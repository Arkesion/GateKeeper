'use strict';
const axios = require('axios');
const { SchwabError, ensureSchwabAuth } = require('./auth');

const MARKET_DATA_URL = 'https://api.schwabapi.com/marketdata/v1';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const store = require('./store');
const { config } = store;

const SYMBOL_PATTERN = config.symbolPattern;
const TICKER_SUGGESTIONS = config.tickerSuggestions;
const TOKEN_FILE = config.tokenFile;
const TOKEN_REFRESH_BUFFER_MS = config.tokenRefreshBufferMs;
const REFRESH_SUSPEND_MS = config.refreshSuspendMs;
const PROACTIVE_REFRESH_CHECK_MS = config.proactiveRefreshCheckMs;
const QUOTE_POLL_MS = config.quotePollMs;
const CANDLE_POLL_MS = config.candlePollMs;
const DAILY_CACHE_MS = config.dailyCacheMs;
const INDICATOR_1M_CACHE_MS = config.indicator1mCacheMs;
const INDICATOR_1M_PERIOD = config.indicator1mPeriod;
const MACD_MIN_BARS = config.macdMinBars;
const MACD_MIN_BARS_SPARSE = config.macdMinBarsSparse;
const SESSION_MIN_BARS = config.sessionMinBars;
const WARNING_WINDOW_MS = config.warningWindowMs;
const TOPPING_TAIL_WICK_RATIO = config.toppingTailWickRatio;
const BOTTOMING_TAIL_WICK_RATIO = config.bottomingTailWickRatio;
const DOJI_BODY_RATIO = config.dojiBodyRatio;
const DOJI_RUN_LOOKBACK = config.dojiRunLookback;
const DOJI_RUN_MIN_SAME_DIR = config.dojiRunMinSameDir;
const HIGH_VOL_RATIO = config.highVolRatio;
const HIGH_VOL_PRIOR_BARS = config.highVolPriorBars;
const TAPE_SLOW_RATIO = config.tapeSlowRatio;
const LEVEL_TEST_BAND_USD = config.levelTestBandUsd;
const LEVEL_NEAR_BAND_USD = config.levelNearBandUsd;
const LEVEL_BREAK_USD = config.levelBreakUsd;
const LEVEL_BREAK_LOOKBACK_BARS = config.levelBreakLookbackBars;
const FRONT_SIDE_LOOKBACK_BARS = config.frontSideLookbackBars;
const FRONT_SIDE_MIN_GREEN_BARS = config.frontSideMinGreenBars;
const FRONT_SIDE_SMALL_BODY_RATIO = config.frontSideSmallBodyRatio;
const FRONT_SIDE_REVERSAL_BODY_RATIO = config.frontSideReversalBodyRatio;
const FRONT_SIDE_MIN_HOLD_PCT = config.frontSideMinHoldPct;
const FRONT_SIDE_NEAR_PEAK_PCT = config.frontSideNearPeakPct;
const GIVEBACK_MIN_GREEN_BARS = config.givebackMinGreenBars;
const GIVEBACK_MOVE_MIN_USD = config.givebackMoveMinUsd;
const GIVEBACK_WARN_RATIO = config.givebackWarnRatio;
const GIVEBACK_FAIL_RATIO = config.givebackFailRatio;
const MAX_BID_ASK_SPREAD_USD = config.maxBidAskSpreadUsd;
const NASDAQ_HALT_POLL_MS = config.nasdaqHaltPollMs;
const LUDP_PAUSE_MS = config.ludpPauseMs;
const NASDAQ_HALT_RPC_URL = config.nasdaqHaltRpcUrl;
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
  return candles.map(c => ({
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
