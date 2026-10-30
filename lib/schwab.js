'use strict';
const axios = require('axios');
const { SchwabError, ensureSchwabAuth } = require('./auth');

const MARKET_DATA_URL = 'https://api.schwabapi.com/marketdata/v1';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const store = require('./store');
const { config } = store;

const MAX_BID_ASK_SPREAD_USD = config.maxBidAskSpreadUsd;
const BACKOFF_MS = config.backoffMs;

function markFetchSuccess() {
  store.lastSuccessfulFetch = new Date().toISOString();
  store.rateLimitStatus = 'ok';
  store.rateLimitBackoffStep = 0;
}

function recordSchwabCall() {
  const now = Date.now();
  store.schwabCallTimestamps.push(now);
  const cutoff = now - 60000;
  while (store.schwabCallTimestamps.length && store.schwabCallTimestamps[0] < cutoff) {
    store.schwabCallTimestamps.shift();
  }
}

function getSchwabCallsPerMinute() {
  const cutoff = Date.now() - 60000;
  return store.schwabCallTimestamps.filter(t => t >= cutoff).length;
}

async function enterRateLimitBackoff() {
  if (store.rateLimitBackoffPromise) {
    await store.rateLimitBackoffPromise;
    return;
  }
  store.rateLimitBackoffPromise = (async () => {
    store.rateLimitStatus = 'backing_off';
    const waitMs = BACKOFF_MS[Math.min(store.rateLimitBackoffStep, 2)];
    store.rateLimitBackoffStep = Math.min(store.rateLimitBackoffStep + 1, 2);
    store.rateLimitBackoffUntil = Date.now() + waitMs;
    console.warn(`⚠️ Schwab 429 — backing off ${waitMs / 1000}s`);
    await delay(waitMs);
    if (waitMs === 20000) {
      await require('./auth').probeSchwabAuth();
    }
  })().finally(() => {
    store.rateLimitBackoffPromise = null;
  });
  await store.rateLimitBackoffPromise;
}

function schwabResultToError(result) {
  if (result.error === 'auth_failed') {
    return new SchwabError('auth_failed', 'Authentication failed', result.status || 401);
  }
  if (result.status === 429 || result.error === 'rate_limited') {
    return new SchwabError('rate_limited', 'Rate limited', 429);
  }
  return new SchwabError('schwab_error', result.error || 'Schwab request failed', result.status || 500);
}

async function schwabFetch(url, options = {}) {
  if (!url.startsWith(MARKET_DATA_URL)) {
    return { ok: false, status: 400, error: 'invalid_schwab_url' };
  }

  if (!(await ensureSchwabAuth())) {
    return { ok: false, status: 401, error: 'auth_failed' };
  }

  if (store.rateLimitBackoffPromise) {
    await store.rateLimitBackoffPromise;
  } else if (store.rateLimitStatus === 'backing_off' && Date.now() < store.rateLimitBackoffUntil) {
    await delay(store.rateLimitBackoffUntil - Date.now());
  }

  async function requestOnce() {
    return axios.request({
      url,
      method: options.method || 'GET',
      params: options.params,
      headers: { Authorization: `Bearer ${store.accessToken}`, ...options.headers },
      validateStatus: () => true
    });
  }

  let res = await requestOnce();

  function logSchwabOk() {
    const path = new URL(url).pathname;
    const sym = options.params?.symbols || options.params?.symbol || '';
    console.log('[Schwab]', path, sym);
  }

  if (res.status === 200) {
    markFetchSuccess();
    recordSchwabCall();
    logSchwabOk();
    return { ok: true, status: 200, data: res.data };
  }

  if (res.status === 401) {
    store.refreshTokenSuspendedUntil = 0;
    if (!(await ensureSchwabAuth({ forceRefresh: true }))) {
      return { ok: false, status: 401, error: 'auth_failed' };
    }
    res = await requestOnce();
    if (res.status === 200) {
      markFetchSuccess();
      recordSchwabCall();
      logSchwabOk();
      return { ok: true, status: 200, data: res.data };
    }
    console.error('Schwab 401 after token refresh:', res.status);
    return { ok: false, status: res.status || 401, error: 'schwab_unauthorized' };
  }

  if (res.status === 429) {
    await enterRateLimitBackoff();
    res = await requestOnce();
    if (res.status === 200) {
      markFetchSuccess();
      recordSchwabCall();
      logSchwabOk();
      return { ok: true, status: 200, data: res.data };
    }
    if (res.status === 429) {
      return { ok: false, status: 429, error: 'rate_limited' };
    }
  }

  const errMsg = res.data?.message || res.statusText || `HTTP ${res.status}`;
  return { ok: false, status: res.status || 500, error: errMsg };
}

// ── MARKET DATA ───────────────────────────────────────────────
async function getQuote(symbol) {
  const result = await schwabFetch(`${MARKET_DATA_URL}/quotes`, {
    params: { symbols: symbol, fields: 'quote,fundamental' }
  });
  if (!result.ok) throw schwabResultToError(result);
  return result.data[symbol]?.quote || null;
}

function quoteBidAskSpread(quote) {
  if (!quote) return null;
  const bid = quote.bidPrice ?? quote.bid ?? null;
  const ask = quote.askPrice ?? quote.ask ?? null;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) return null;
  return ask - bid;
}

function isSpreadAcceptable(quote) {
  const spread = quoteBidAskSpread(quote);
  if (spread == null) return false;
  return spread <= MAX_BID_ASK_SPREAD_USD;
}

async function getPriceHistory(symbol, periodType, period, frequencyType, frequency, opts = {}) {
  const { needExtendedHoursData = false, startDate, endDate } = opts;

  const params = { symbol, frequencyType, frequency, needExtendedHoursData };

  // Only include periodType/period when NOT using startDate/endDate
  // Schwab ignores date range when period params are present
  if (startDate != null) {
    params.startDate = startDate;
    if (endDate != null) params.endDate = endDate;
  } else {
    params.periodType = periodType;
    params.period = period;
    if (endDate != null) params.endDate = endDate;
  }

  const result = await schwabFetch(`${MARKET_DATA_URL}/pricehistory`, { params });
  if (!result.ok) throw schwabResultToError(result);
  const candles = result.data.candles || [];
  const { stampBarEt } = require('./session');
  return candles.map(c => stampBarEt({
    ...c,
    datetime: c.datetime < 1e12 ? c.datetime * 1000 : c.datetime
  }));
}
module.exports = {
  delay,
  markFetchSuccess,
  recordSchwabCall,
  getSchwabCallsPerMinute,
  enterRateLimitBackoff,
  schwabResultToError,
  schwabFetch,
  getQuote,
  quoteBidAskSpread,
  isSpreadAcceptable,
  getPriceHistory
};
