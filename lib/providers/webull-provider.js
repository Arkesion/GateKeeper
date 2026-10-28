'use strict';

const { randomUUID } = require('crypto');
const { MarketDataProvider } = require('./market-data-provider');

const STALE_MS = 3000;
const WATCH_LIMIT = 3;
const ACK_TIMEOUT_MS = 45000;

function isHeartbeatStale(iso, now = Date.now()) {
  const ts = Date.parse(iso || '');
  if (!Number.isFinite(ts)) return true;
  return now - ts > STALE_MS;
}

function upsertBar(bars, bar) {
  if (!bar || bar.datetime == null) return bars;
  const next = bars.filter(row => row.datetime !== bar.datetime);
  next.push(bar);
  next.sort((a, b) => a.datetime - b.datetime);
  return next;
}

class WebullProvider extends MarketDataProvider {
  constructor(redisUrl) {
    super();
    const { config } = require('../store');
    this.redisUrl = redisUrl || config.redisUrl;
    this.redis = null;
    this.sub = null;
    this.watched = [];
    this.states = new Map();
    this.inflight = new Map();
    this.heartbeatIso = null;
    this.heartbeatTimer = null;
    this.onUpdate = null;
  }

  async start() {
    const { createClient } = require('redis');
    this.redis = createClient({
      url: this.redisUrl,
      socket: {
        reconnectStrategy: retries => Math.min(100 * retries, 2000)
      }
    });
    let loggedDisconnect = false;
    this.redis.on('error', err => {
      if (!loggedDisconnect) {
        loggedDisconnect = true;
        console.error('Redis:', err.message);
      }
    });
    this.redis.on('ready', () => {
      loggedDisconnect = false;
    });
    const connected = this.redis.connect().then(() => true).catch(err => {
      console.error('Redis connect:', err.message);
      return false;
    });
    const ready = await Promise.race([
      connected,
      new Promise(resolve => setTimeout(() => resolve(false), 2000))
    ]);
    if (!ready) {
      console.error('Redis not ready; quotes stay DATA STALE until it connects');
      connected.then(ok => { if (ok) return this._attachSubscriber(); }).catch(() => {});
      return;
    }
    await this._attachSubscriber();
  }

  async _attachSubscriber() {
    if (this.sub || !this.redis) return;
    this.sub = this.redis.duplicate();
    this.sub.on('error', err => console.error('Redis sub:', err.message));
    await this.sub.connect();
    await this._pollHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this._pollHeartbeat().catch(err => console.error('Heartbeat:', err.message));
    }, 1000);
  }

  async stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.sub) await this.sub.quit().catch(() => {});
    if (this.redis) await this.redis.quit().catch(() => {});
  }

  isDataStale() {
    return isHeartbeatStale(this.heartbeatIso);
  }

  getState(symbol) {
    return this.states.get(symbol.toUpperCase()) || null;
  }

  async backfill(symbol, sessions = ['PRE', 'RTH']) {
    symbol = symbol.toUpperCase();
    const id = randomUUID();
    await this.redis.rPush('gk:cmd', JSON.stringify({
      id,
      op: 'watch',
      symbol,
      sessions
    }));
    const ack = await this._waitAck(id);
    if (!ack.ok) throw new Error(ack.error || 'backfill failed');
    const barsRaw = await this.redis.get(`gk:bars:${symbol}`);
    const quoteRaw = await this.redis.get(`gk:quote:${symbol}`);
    const state = this.states.get(symbol) || { bars: [], quote: null, seeded: false };
    state.bars = barsRaw ? JSON.parse(barsRaw) : [];
    if (quoteRaw) state.quote = JSON.parse(quoteRaw);
    state.seeded = true;
    this.states.set(symbol, state);
    return { bars: state.bars, quote: state.quote };
  }

  async stream(symbol) {
    symbol = symbol.toUpperCase();
    const pending = this.inflight.get(symbol);
    if (pending) return pending;
    const job = this._stream(symbol).finally(() => this.inflight.delete(symbol));
    this.inflight.set(symbol, job);
    return job;
  }

  async _stream(symbol) {
    const known = this.states.get(symbol);
    if (this.watched.includes(symbol) && known?.seeded) {
      this._emit(symbol);
      return known;
    }
    if (!this.watched.includes(symbol) && this.watched.length >= WATCH_LIMIT) {
      await this.unstream(this.watched[0]);
    }
    const seeded = await this.backfill(symbol, ['PRE', 'RTH']);
    if (!this.watched.includes(symbol)) {
      this.watched.push(symbol);
      await this.sub.subscribe(`gk:live:${symbol}`, message => this._onLive(symbol, message));
    }
    this._emit(symbol);
    return seeded;
  }

  async unstream(symbol) {
    symbol = symbol.toUpperCase();
    this.watched = this.watched.filter(item => item !== symbol);
    this.states.delete(symbol);
    if (this.sub) await this.sub.unsubscribe(`gk:live:${symbol}`).catch(() => {});
    if (!this.redis) return;
    const id = randomUUID();
    await this.redis.rPush('gk:cmd', JSON.stringify({ id, op: 'unwatch', symbol }));
    await this._waitAck(id).catch(() => {});
  }

  async _waitAck(id) {
    const deadline = Date.now() + ACK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const raw = await this.redis.get(`gk:ack:${id}`);
      if (raw) return JSON.parse(raw);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('backfill timed out');
  }

  async _pollHeartbeat() {
    if (!this.redis) return;
    this.heartbeatIso = await this.redis.get('gk:heartbeat');
  }

  _onLive(symbol, message) {
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }
    const state = this.states.get(symbol) || { bars: [], quote: null, seeded: true };
    if (payload.quote) state.quote = payload.quote;
    const updates = payload.updates || (payload.closed ? [payload.closed] : []);
    for (const bar of updates) {
      state.bars = upsertBar(state.bars, bar);
    }
    if (payload.forming) state.bars = upsertBar(state.bars, payload.forming);
    state.seeded = true;
    this.states.set(symbol, state);
    this._emit(symbol);
  }

  _emit(symbol) {
    const state = this.states.get(symbol);
    if (!state || !this.onUpdate) return;
    this.onUpdate(symbol, { quote: state.quote, bars: state.bars });
  }
}

module.exports = { WebullProvider, isHeartbeatStale, STALE_MS };
