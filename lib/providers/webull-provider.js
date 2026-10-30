'use strict';

const { randomUUID } = require('crypto');
const { MarketDataProvider } = require('./market-data-provider');

const STALE_MS = 3000;
const WATCH_LIMIT = 3;
const ACK_TIMEOUT_MS = 45000;

let sharedSnapshot = null;
let feedTimer = null;
let feedRedis = null;

function noteAccount(snapshot) {
  sharedSnapshot = snapshot || null;
}

function getAccountSnapshot() {
  return sharedSnapshot;
}

function accountStatusOf(snapshot) {
  const status = snapshot?.status;
  return status ? { status } : null;
}

function fillWatchOf(snapshot) {
  if (!snapshot) {
    return { orders_stream: null, positions_poll_age_s: null, open_positions: null };
  }
  const at = Number(snapshot.positionsPollAt);
  const age = Number.isFinite(at) ? Math.max(0, Math.round((Date.now() - at) / 1000)) : null;
  const open = Number(snapshot.openPositions);
  return {
    orders_stream: snapshot.ordersStream || null,
    positions_poll_age_s: age,
    open_positions: Number.isFinite(open) ? open : null
  };
}

function parseRedisJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function readAccountSnapshot(redis) {
  if (!redis) return null;
  const [positions, fills, account, dayFills] = await Promise.all([
    redis.get('gk:positions'),
    redis.lRange('gk:fills', 0, 199),
    redis.get('gk:account'),
    redis.get('gk:day_fills')
  ]);
  const accountBody = parseRedisJson(account);
  const pollAt = Number(accountBody?.positions_poll_at);
  const openCount = Number(accountBody?.open_positions);
  return {
    status: accountBody?.status || null,
    ordersStream: accountBody?.orders_stream || null,
    positionsPollAt: Number.isFinite(pollAt) ? pollAt : null,
    openPositions: Number.isFinite(openCount) ? openCount : null,
    positions: positions ? (parseRedisJson(positions) || []) : null,
    fills: (fills || []).map(parseRedisJson).filter(Boolean),
    dayFills: dayFills ? (parseRedisJson(dayFills) || []) : null
  };
}

function publishAccount(snapshot) {
  if (!snapshot) return;
  noteAccount(snapshot);
  require('../trades').logPriorSessionOnce(snapshot.dayFills, Date.now());
}

async function startAccountFeed() {
  if (feedTimer || feedRedis) return;
  const { createClient } = require('redis');
  const { config } = require('../store');
  feedRedis = createClient({
    url: config.redisUrl,
    socket: { reconnectStrategy: retries => Math.min(100 * retries, 2000) }
  });
  feedRedis.on('error', () => {});
  const connected = feedRedis.connect().then(() => true).catch(err => {
    console.error('Account feed:', err.message);
    return false;
  });
  const ready = await Promise.race([
    connected,
    new Promise(resolve => setTimeout(() => resolve(false), 2000))
  ]);
  if (!ready) {
    console.error('Account feed: Redis not ready');
    return;
  }
  const tick = async () => {
    try {
      const snapshot = await readAccountSnapshot(feedRedis);
      publishAccount(snapshot);
    } catch (err) {
      console.error('Account feed:', err.message);
    }
  };
  await tick();
  feedTimer = setInterval(() => {
    tick().catch(err => console.error('Account feed:', err.message));
  }, 1000);
}

function stopAccountFeed() {
  if (feedTimer) clearInterval(feedTimer);
  feedTimer = null;
  if (feedRedis) feedRedis.quit().catch(() => {});
  feedRedis = null;
}

function isHeartbeatStale(iso, now = Date.now()) {
  const ts = Date.parse(iso || '');
  if (!Number.isFinite(ts)) return true;
  return now - ts > STALE_MS;
}

function upsertBar(bars, bar) {
  if (!bar || bar.datetime == null) return bars;
  require('../session').stampBarEt(bar);
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
    this.accountSnapshot = null;
    this.heartbeatTimer = null;
    this.onUpdate = null;
  }

  async start() {
    const { createClient } = require('redis');
    const fs = require('fs');
    const writeRedisDiag = line => {
      const text = line.endsWith('\n') ? line : `${line}\n`;
      try {
        fs.writeSync(process.stderr.fd, text);
      } catch {
        /* stderr unavailable */
      }
    };
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
      writeRedisDiag(`redis error: ${err && err.stack ? err.stack : err}`);
    });
    this.redis.on('end', () => writeRedisDiag('redis end'));
    this.redis.on('reconnecting', () => writeRedisDiag('redis reconnecting'));
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

  async getStreamStatus() {
    if (!this.redis || !this.redis.isReady) return 'down';
    try {
      const status = await this.redis.get('gk:stream');
      if (status === 'stream_taken') return 'stream_taken';
      const beat = await this.redis.get('gk:heartbeat');
      this.heartbeatIso = beat;
      if (isHeartbeatStale(beat)) return 'stale';
      return 'streaming';
    } catch {
      return 'down';
    }
  }

  async reclaim() {
    if (!this.redis || !this.redis.isReady) {
      throw new Error('redis down');
    }
    await this.redis.rPush('gk:cmd', JSON.stringify({ id: randomUUID(), op: 'reclaim' }));
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
    state.bars = require('../session').stampBars(barsRaw ? JSON.parse(barsRaw) : []);
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
      this._emit(symbol, { immediate: true });
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
    this._emit(symbol, { immediate: true });
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

  async ensureDaily(symbol) {
    symbol = symbol.toUpperCase();
    if (!this.redis || !this.redis.isReady) return [];
    const { getEtDateString } = require('../session');
    const today = getEtDateString(Date.now());
    const key = `gk:daily:${symbol}`;
    const existing = await this.redis.get(key);
    if (existing) {
      try {
        const cached = JSON.parse(existing);
        if (cached.day === today && Array.isArray(cached.bars)) return cached.bars;
      } catch {
        /* refetch */
      }
    }
    const id = randomUUID();
    await this.redis.rPush('gk:cmd', JSON.stringify({ id, op: 'daily', symbol }));
    const ack = await this._waitAck(id);
    if (!ack.ok) throw new Error(ack.error || 'daily bars failed');
    const raw = await this.redis.get(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.bars) ? parsed.bars : [];
  }

  async _pollHeartbeat() {
    if (!this.redis) return;
    this.heartbeatIso = await this.redis.get('gk:heartbeat');
    try {
      const snapshot = await readAccountSnapshot(this.redis);
      this.accountSnapshot = snapshot;
      publishAccount(snapshot);
    } catch {
      /* the book keeps the last good snapshot */
    }
  }

  _onLive(symbol, message) {
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }
    const state = this.states.get(symbol) || { bars: [], quote: null, ticks: [], seeded: true };
    if (payload.quote) state.quote = payload.quote;
    if (payload.tick && Number.isFinite(payload.tick.t)) {
      if (!state.ticks) state.ticks = [];
      state.ticks.push(payload.tick);
      const cutoff = payload.tick.t - 20 * 60 * 1000;
      while (state.ticks.length && state.ticks[0].t < cutoff) state.ticks.shift();
    }
    const httpReplace = Array.isArray(payload.updates);
    const updates = payload.updates || (payload.closed ? [payload.closed] : []);
    for (const bar of updates) {
      state.bars = upsertBar(state.bars, bar);
    }
    if (payload.forming) state.bars = upsertBar(state.bars, payload.forming);
    state.seeded = true;
    this.states.set(symbol, state);
    this._emit(symbol, { immediate: httpReplace || updates.length > 0 });
  }

  _emit(symbol, opts = {}) {
    const state = this.states.get(symbol);
    if (!state || !this.onUpdate) return;
    this.onUpdate(symbol, {
      quote: state.quote,
      bars: state.bars,
      ticks: state.ticks || [],
      immediate: opts.immediate === true
    });
  }
}

module.exports = {
  WebullProvider,
  isHeartbeatStale,
  STALE_MS,
  noteAccount,
  getAccountSnapshot,
  accountStatusOf,
  fillWatchOf,
  startAccountFeed,
  stopAccountFeed
};
