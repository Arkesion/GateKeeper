require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = 3000;

// ── TOKEN PERSISTENCE ─────────────────────────────────────────
/** Persist on Docker volume so deploy/rebuild does not wipe tokens. */
const TOKEN_FILE = process.env.TOKEN_PATH || '/data/tokens.json';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const REFRESH_SUSPEND_MS = 15 * 60 * 1000;
const PROACTIVE_REFRESH_CHECK_MS = 60 * 1000;

let accessToken = null;
let refreshToken = null;
let tokenExpiry = null;

let authenticated = false;
let refreshTokenSuspendedUntil = 0;
let proactiveRefreshTimer = null;
let lastSuccessfulFetch = null;
let rateLimitStatus = 'ok';
let rateLimitBackoffStep = 0;
let rateLimitBackoffUntil = 0;
let rateLimitBackoffPromise = null;

const stateCache = {};

const QUOTE_POLL_MS = Number(process.env.QUOTE_POLL_MS) || 1000;
const CANDLE_POLL_MS = Number(process.env.CANDLE_POLL_MS) || 2000;
const DAILY_CACHE_MS = Number(process.env.DAILY_CACHE_MS) || 60000;
const DAILY_RVOL_LOOKBACK = 14;
/** 1m bars for MACD — longer history so EMA chain matches TOS chart (Schwab max 10 session days). */
const INDICATOR_1M_CACHE_MS = Number(process.env.INDICATOR_1M_CACHE_MS) || 60000;
const INDICATOR_1M_PERIOD = 10;
/** MACD(12,26,9) ideal warmup; Schwab may return fewer 1m bars on thin premarket names. */
const MACD_MIN_BARS = 26;
const MACD_MIN_BARS_SPARSE = 20;
/** Minimum today's session 1m bars for VWAP / higher-highs (not MACD warmup). */
const SESSION_MIN_BARS = 4;
/** Timed warnings only surface bars from the last 8 minutes (1m chart). */
const WARNING_WINDOW_MS = 8 * 60 * 1000;
const WARNING_LOOKBACK_BARS = 8;
const TOPPING_TAIL_WICK_RATIO = 0.6;
const BOTTOMING_TAIL_WICK_RATIO = 0.6;
const DOJI_BODY_RATIO = 0.1;
const DOJI_RUN_LOOKBACK = 5;
const DOJI_RUN_MIN_SAME_DIR = 3;
/** High-volume 1m bar vs prior bars (no L2 — tape proxy). */
const HIGH_VOL_RATIO = 2.0;
const HIGH_VOL_PRIOR_BARS = 8;
/** HV sell GO check uses the same 8-minute window as warning messages. */
const TAPE_SLOW_RATIO = 0.5;
/** Row 2 level bands: 3¢ active test at level; 10¢ near/approach/clear. */
const LEVEL_TEST_BAND_USD = 0.03;
const LEVEL_NEAR_BAND_USD = 0.10;
const LEVEL_BREAK_USD = 0.02;
const LEVEL_BREAK_LOOKBACK_BARS = 5;
/** Front-side structure (row 2, not a GO veto). */
const FRONT_SIDE_LOOKBACK_BARS = 12;
const FRONT_SIDE_MIN_GREEN_BARS = 2;
const FRONT_SIDE_SMALL_BODY_RATIO = 0.35;
const FRONT_SIDE_REVERSAL_BODY_RATIO = 0.5;
const FRONT_SIDE_MIN_HOLD_PCT = 0.40;
const FRONT_SIDE_NEAR_PEAK_PCT = 0.25;
/** Green-run giveback vs move size (row 2). */
const GIVEBACK_MIN_GREEN_BARS = 2;
const GIVEBACK_MOVE_MIN_USD = 0.05;
const GIVEBACK_WARN_RATIO = 0.30;
const GIVEBACK_FAIL_RATIO = 0.50;
/** Max NBBO spread (ask − bid) for row 1 GO. */
const MAX_BID_ASK_SPREAD_USD = 0.10;

/** Common typos → valid Schwab symbol (shown in UI). */
const TICKER_SUGGESTIONS = {
  APPL: 'AAPL',
  GOOG: 'GOOGL',
  BRK: 'BRK.B'
};

let activeSymbol = null;
const refreshTimers = { quote: null, candles: null };
const refreshInFlight = { quote: false, candles: false };
const marketDataCache = {};
const responseCache = {};
/** Per-symbol halt tracking (Schwab securityStatus + transition times). */
const haltTrackers = {};

const NASDAQ_HALT_POLL_MS = Number(process.env.NASDAQ_HALT_POLL_MS) || 60000;
const LUDP_PAUSE_MS = 5 * 60 * 1000;
const NASDAQ_HALT_RPC_URL = 'https://www.nasdaqtrader.com/RPCHandler.axd';
const nasdaqHaltsCache = { fetchedAt: 0, rows: [] };
let nasdaqHaltsRefreshPromise = null;

/** Rolling window of successful Schwab HTTP call timestamps (for /api/health). */
const schwabCallTimestamps = [];

const BACKOFF_MS = [5000, 10000, 20000];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class SchwabError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function markFetchSuccess() {
  lastSuccessfulFetch = new Date().toISOString();
  rateLimitStatus = 'ok';
  rateLimitBackoffStep = 0;
}

function recordSchwabCall() {
  const now = Date.now();
  schwabCallTimestamps.push(now);
  const cutoff = now - 60000;
  while (schwabCallTimestamps.length && schwabCallTimestamps[0] < cutoff) {
    schwabCallTimestamps.shift();
  }
}

function getSchwabCallsPerMinute() {
  const cutoff = Date.now() - 60000;
  return schwabCallTimestamps.filter(t => t >= cutoff).length;
}

function ensureTokenDir() {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function migrateTokenFile() {
  if (fs.existsSync(TOKEN_FILE)) return;
  const legacyPaths = [
    path.join(process.cwd(), 'tokens.json'),
    '/app/tokens.json'
  ];
  for (const legacy of legacyPaths) {
    if (legacy === TOKEN_FILE || !fs.existsSync(legacy)) continue;
    try {
      ensureTokenDir();
      fs.copyFileSync(legacy, TOKEN_FILE);
      console.log(`✅ Migrated tokens → ${TOKEN_FILE}`);
      return;
    } catch (e) {
      console.warn(`Token migration from ${legacy} failed:`, e.message);
    }
  }
}

function saveTokens() {
  try {
    ensureTokenDir();
    const payload = JSON.stringify({ accessToken, refreshToken, tokenExpiry });
    const tmp = `${TOKEN_FILE}.tmp`;
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, TOKEN_FILE);
    console.log(`💾 Tokens saved (${TOKEN_FILE})`);
  } catch (e) {
    console.error('Token save failed:', e.message);
  }
}

function accessTokenStillValid() {
  return Boolean(accessToken && tokenExpiry && Date.now() < tokenExpiry - TOKEN_REFRESH_BUFFER_MS);
}

function accessTokenNeedsRefresh() {
  if (!accessToken || !tokenExpiry) return true;
  return Date.now() >= tokenExpiry - TOKEN_REFRESH_BUFFER_MS;
}

function isInvalidGrantError(err) {
  const data = err.response?.data;
  const desc = typeof data?.error_description === 'string' ? data.error_description : '';
  return err.response?.status === 400 && (
    data?.error === 'unsupported_token_type' ||
    desc.includes('invalid_grant') ||
    desc.includes('Refresh token is invalid')
  );
}

function suspendRefreshAttempts() {
  refreshTokenSuspendedUntil = Date.now() + REFRESH_SUSPEND_MS;
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const d = JSON.parse(fs.readFileSync(TOKEN_FILE));
      accessToken  = d.accessToken;
      refreshToken = d.refreshToken;
      tokenExpiry  = d.tokenExpiry;
      authenticated = accessTokenStillValid();
      console.log(`✅ Tokens loaded (${TOKEN_FILE})`);
    }
  } catch (e) {
    console.error('Token load failed:', e.message);
  }
}

function bootstrapTokenStore() {
  ensureTokenDir();
  migrateTokenFile();
  loadTokens();
}

function clearAuthFailedCache() {
  for (const sym of Object.keys(responseCache)) {
    if (responseCache[sym]?.status === 'auth_failed') delete responseCache[sym];
  }
}

function markAuthenticated() {
  authenticated = true;
  clearAuthFailedCache();
}

bootstrapTokenStore();

let tokenRefreshInFlight = null;

// ── AUTH ──────────────────────────────────────────────────────
const SCHWAB_AUTH_URL  = 'https://api.schwabapi.com/v1/oauth/authorize';
const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const MARKET_DATA_URL  = 'https://api.schwabapi.com/marketdata/v1';

const clientId     = process.env.SCHWAB_CLIENT_ID;
const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
const publicUrl    = (process.env.PUBLIC_URL || 'https://gatekeeper.veilforge.org').replace(/\/$/, '');
const redirectUri  = process.env.REDIRECT_URI || `${publicUrl}/callback`;
const basicAuth    = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

if (!redirectUri.includes('/callback')) {
  console.warn('⚠️ REDIRECT_URI should end with /callback — Schwab OAuth will fail');
}
if (redirectUri.includes('127.0.0.1') && publicUrl.includes('veilforge')) {
  console.error('⚠️ REDIRECT_URI points at 127.0.0.1 but PUBLIC_URL is production — fix .env');
}

function redirectToSchwabLogin(req, res) {
  const authUrl = `${SCHWAB_AUTH_URL}?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(authUrl);
}

app.get('/login', redirectToSchwabLogin);
app.get('/api/login', redirectToSchwabLogin);

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('No auth code received.');
  try {
    const response = await axios.post(SCHWAB_TOKEN_URL,
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
      { headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    accessToken  = response.data.access_token;
    refreshToken = response.data.refresh_token;
    tokenExpiry  = Date.now() + (response.data.expires_in * 1000);
    refreshTokenSuspendedUntil = 0;
    saveTokens();
    markAuthenticated();
    startProactiveRefreshTimer();
    console.log('✅ Authenticated with Schwab');
    if (activeSymbol) startSymbolRefresh(activeSymbol);
    res.send('<script>window.close();</script>Authenticated! You can close this window.');
  } catch (err) {
    console.error('Auth error:', err.response?.data || err.message);
    res.send('Authentication failed. Check console.');
  }
});

async function refreshAccessToken({ force = false } = {}) {
  if (!refreshToken && !accessTokenStillValid()) {
    authenticated = false;
    return false;
  }
  if (!force && accessTokenStillValid()) {
    markAuthenticated();
    return true;
  }
  if (!refreshToken) {
    if (accessTokenStillValid()) {
      markAuthenticated();
      return true;
    }
    authenticated = false;
    return false;
  }
  if (Date.now() < refreshTokenSuspendedUntil) {
    if (accessTokenStillValid()) {
      markAuthenticated();
      return true;
    }
    authenticated = false;
    return false;
  }

  if (tokenRefreshInFlight) return tokenRefreshInFlight;

  tokenRefreshInFlight = (async () => {
    try {
      const response = await axios.post(SCHWAB_TOKEN_URL,
        new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
        { headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      accessToken = response.data.access_token;
      if (response.data.refresh_token) refreshToken = response.data.refresh_token;
      tokenExpiry = Date.now() + (response.data.expires_in * 1000);
      refreshTokenSuspendedUntil = 0;
      saveTokens();
      markAuthenticated();
      console.log('🔄 Token refreshed');
      return true;
    } catch (err) {
      if (isInvalidGrantError(err)) {
        console.error('Refresh token rejected — suspend refresh retries; re-login if access expires');
        refreshToken = null;
        suspendRefreshAttempts();
        saveTokens();
      } else {
        console.error('Token refresh failed:', err.response?.status, err.response?.data || err.message);
      }
      if (accessTokenStillValid()) {
        markAuthenticated();
        return true;
      }
      authenticated = false;
      return false;
    } finally {
      tokenRefreshInFlight = null;
    }
  })();

  return tokenRefreshInFlight;
}

/** Single entry: use valid access token; refresh only when near expiry or forced. */
async function ensureSchwabAuth({ forceRefresh = false } = {}) {
  if (!forceRefresh && accessTokenStillValid()) {
    markAuthenticated();
    return true;
  }
  if (!forceRefresh && !accessTokenNeedsRefresh()) {
    markAuthenticated();
    return true;
  }
  return refreshAccessToken({ force: true });
}

function startProactiveRefreshTimer() {
  if (proactiveRefreshTimer) return;
  proactiveRefreshTimer = setInterval(() => {
    if (!refreshToken || Date.now() < refreshTokenSuspendedUntil) return;
    if (!accessTokenNeedsRefresh()) return;
    refreshAccessToken({ force: true }).catch(() => {});
  }, PROACTIVE_REFRESH_CHECK_MS);
}

async function probeSchwabAuth() {
  if (!(await ensureSchwabAuth())) return false;
  try {
    const res = await axios.get(`${MARKET_DATA_URL}/quotes`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      params: { symbols: 'SPY', fields: 'quote' },
      validateStatus: () => true
    });
    if (res.status === 200) {
      markFetchSuccess();
      return true;
    }
    console.warn('Auth probe failed:', res.status);
    return false;
  } catch (err) {
    console.warn('Auth probe error:', err.message);
    return false;
  }
}

async function enterRateLimitBackoff() {
  if (rateLimitBackoffPromise) {
    await rateLimitBackoffPromise;
    return;
  }
  rateLimitBackoffPromise = (async () => {
    rateLimitStatus = 'backing_off';
    const waitMs = BACKOFF_MS[Math.min(rateLimitBackoffStep, 2)];
    rateLimitBackoffStep = Math.min(rateLimitBackoffStep + 1, 2);
    rateLimitBackoffUntil = Date.now() + waitMs;
    console.warn(`⚠️ Schwab 429 — backing off ${waitMs / 1000}s`);
    await delay(waitMs);
    if (waitMs === 20000) {
      await probeSchwabAuth();
    }
  })().finally(() => {
    rateLimitBackoffPromise = null;
  });
  await rateLimitBackoffPromise;
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

  if (rateLimitBackoffPromise) {
    await rateLimitBackoffPromise;
  } else if (rateLimitStatus === 'backing_off' && Date.now() < rateLimitBackoffUntil) {
    await delay(rateLimitBackoffUntil - Date.now());
  }

  async function requestOnce() {
    return axios.request({
      url,
      method: options.method || 'GET',
      params: options.params,
      headers: { Authorization: `Bearer ${accessToken}`, ...options.headers },
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
    refreshTokenSuspendedUntil = 0;
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

const NY_TZ = 'America/New_York';

function getEtDateString(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: NY_TZ }).format(new Date(ms));
}

function getEtHourMinute(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(new Date(ms));
  return {
    h: parseInt(parts.find(p => p.type === 'hour').value, 10),
    m: parseInt(parts.find(p => p.type === 'minute').value, 10)
  };
}

function getEtSecond(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    second: 'numeric',
    hour12: false
  }).formatToParts(new Date(ms));
  return parseInt(parts.find(p => p.type === 'second').value, 10);
}

/** First few seconds of each ET minute: pull quote + 1m so :00 flash has fresh bar. */
function triggerMinuteEdgeRefresh(symbol) {
  if (!symbol) return;
  const now = Date.now();
  if (getEtSecond(now) > 3) return;
  const { h, m } = getEtHourMinute(now);
  const edgeKey = `${getEtDateString(now)}T${h}:${String(m).padStart(2, '0')}`;
  if (!marketDataCache[symbol]) marketDataCache[symbol] = {};
  if (marketDataCache[symbol].minuteEdgeKey === edgeKey) return;
  marketDataCache[symbol].minuteEdgeKey = edgeKey;
  refreshQuote(symbol);
  refreshCandles(symbol);
}

function utcFromEtDateTime(dateStr, hour, minute) {
  let lo = Date.parse(`${dateStr}T17:00:00.000Z`) - 36 * 60 * 60 * 1000;
  let hi = Date.parse(`${dateStr}T17:00:00.000Z`) + 36 * 60 * 60 * 1000;
  const target = hour * 60 + minute;
  for (let i = 0; i < 40; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const { h, m } = getEtHourMinute(mid);
    const mins = h * 60 + m;
    const day = getEtDateString(mid);
    if (day < dateStr || (day === dateStr && mins < target)) lo = mid + 1;
    else hi = mid;
  }
  return hi;
}

const CLOSED_LOOKBACK_MS = 10 * 24 * 60 * 60 * 1000;

const ETH_OPEN_ET   = 4 * 60;
const ETH_CLOSE_ET  = 20 * 60;
const PRE_OPEN_ET   = ETH_OPEN_ET;
const RTH_OPEN_ET   = 9 * 60 + 30;
const RTH_CLOSE_ET  = 16 * 60;
const POST_CLOSE_ET = ETH_CLOSE_ET;

function getEthDayBounds(now = Date.now()) {
  const today = getEtDateString(now);
  return getEthDayBoundsForDay(today, now);
}

function getEthDayBoundsForDay(sessionDay, now = Date.now()) {
  return {
    today: sessionDay,
    ethStartMs: utcFromEtDateTime(sessionDay, 4, 0),
    ethEndMs:   utcFromEtDateTime(sessionDay, 20, 0),
    capEndMs:   Math.min(now, utcFromEtDateTime(sessionDay, 20, 0))
  };
}

function mergeCandleSources(...sources) {
  const map = new Map();
  for (const src of sources) {
    if (!src?.length) continue;
    for (const c of src) {
      if (c?.datetime != null) map.set(c.datetime, c);
    }
  }
  return sortCandles([...map.values()]);
}

/** ET session day: clock today if any bars match, else newest bar's ET date (Schwab skew). */
function inferSessionDayFromCandles(candles, now = Date.now()) {
  const todayStr = getEtDateString(now);
  if (!candles?.length) return todayStr;
  const sorted = sortCandles(candles);
  const { ethStartMs, capEndMs } = getEthDayBounds(now);
  const cap = Math.min(now, capEndMs);
  const onClockToday = sorted.filter(c =>
    getEtDateString(c.datetime) === todayStr &&
    c.datetime >= ethStartMs &&
    c.datetime <= cap
  );
  if (onClockToday.length > 0) return todayStr;
  return getEtDateString(sorted[sorted.length - 1].datetime);
}

function filterSessionDayBars(candles, sessionDay, now = Date.now()) {
  if (!candles?.length) return [];
  const sorted = sortCandles(candles);
  const { ethStartMs, capEndMs } = getEthDayBoundsForDay(sessionDay, now);
  const cap = Math.min(now, capEndMs);
  let bars = sorted.filter(c =>
    getEtDateString(c.datetime) === sessionDay &&
    c.datetime >= ethStartMs &&
    c.datetime <= cap
  );
  if (bars.length < 26) {
    bars = sorted.filter(c =>
      getEtDateString(c.datetime) === sessionDay &&
      c.datetime >= ethStartMs &&
      c.datetime <= capEndMs
    );
  }
  return bars;
}

/** Drop pre-gap regime on large gap-ups; never return the full mixed series. */
function trimPreGapBars(bars, quote) {
  if (!bars?.length || !quote?.closePrice || !quote?.lastPrice) return bars;
  const prev = quote.closePrice;
  const last = quote.lastPrice;
  if (!Number.isFinite(prev) || prev <= 0 || last / prev < 1.2) return bars;

  const floor = Math.max(prev * 1.35, last * 0.65);
  const inRegime = bars.filter(c =>
    (Number.isFinite(c.close) && c.close >= floor) ||
    (Number.isFinite(c.high) && c.high >= floor)
  );
  let pick = inRegime.length >= MACD_MIN_BARS ? inRegime : null;

  if (!pick) {
    let gapIdx = -1;
    let bestJump = 1.2;
    for (let i = 1; i < bars.length; i++) {
      const p = bars[i - 1].close;
      const c = bars[i].close;
      if (!Number.isFinite(p) || !Number.isFinite(c) || p <= 0 || p > prev * 1.12) continue;
      const jump = c / p;
      if (jump >= bestJump && c >= prev * 1.2) {
        bestJump = jump;
        gapIdx = i;
      }
    }
    if (gapIdx >= 0) {
      const fromGap = bars.slice(gapIdx);
      if (fromGap.length >= 10) pick = fromGap;
    }
  }
  if (!pick && inRegime.length >= 10) pick = inRegime;
  if (!pick) {
    const abovePrev = bars.filter(c =>
      (Number.isFinite(c.close) && c.close >= prev * 1.2) ||
      (Number.isFinite(c.high) && c.high >= prev * 1.2)
    );
    pick = abovePrev.length ? abovePrev : inRegime;
  }
  if (bars.length >= MACD_MIN_BARS && pick.length < MACD_MIN_BARS) return bars;
  return pick;
}

/** @deprecated use trimPreGapBars */
function filterGapUpSessionBars(bars, quote) {
  return trimPreGapBars(bars, quote);
}

function buildSession1mBars(candleSources, quote, now = Date.now()) {
  const merged = mergeCandleSources(...candleSources);
  if (!merged.length) return [];

  const sessionDay = inferSessionDayFromCandles(merged, now);
  let bars = filterSessionDayBars(merged, sessionDay, now);

  if (bars.length < 26) {
    const tail = merged.slice(-Math.min(500, merged.length));
    bars = filterSessionDayBars(tail, sessionDay, now);
    if (bars.length < 26) bars = tail;
    console.warn(
      `[session] ${sessionDay}: ${bars.length} bars (merged=${merged.length}, clock=${getEtDateString(now)})`
    );
  }

  bars = trimPreGapBars(bars, quote);
  if (quote) bars = applyLiveQuoteToCandles(bars, quote);
  return bars;
}

/** 1m series for EMA/MACD — today's 4AM–now ETH session (matches TOS 1D MACD; no gap trim). */
function buildIndicator1mBars(candleSources, quote, now = Date.now()) {
  const merged = mergeCandleSources(...candleSources);
  if (!merged.length) return [];

  const sessionDay = inferSessionDayFromCandles(merged, now);
  let bars = filterSessionDayBars(merged, sessionDay, now);

  if (bars.length < MACD_MIN_BARS) {
    const tail = merged.slice(-Math.min(800, merged.length));
    bars = filterSessionDayBars(tail, sessionDay, now);
    if (bars.length < MACD_MIN_BARS) bars = tail;
  }

  if (quote) bars = applyLiveQuoteToCandles(bars, quote);
  return bars;
}

/** Active session: today's ET date + 4AM→now window (excludes prior-day AH on gap names). */
function getTodaySession1mBars(candles, now = Date.now()) {
  if (!candles?.length) return [];
  const sessionDay = inferSessionDayFromCandles(candles, now);
  return filterSessionDayBars(candles, sessionDay, now);
}

function isGatekeeperOpen(now = Date.now()) {
  const mins = getEtMinutes(now);
  return mins >= ETH_OPEN_ET && mins < ETH_CLOSE_ET;
}

function getEtMinutes(ms) {
  const { h, m } = getEtHourMinute(ms);
  return h * 60 + m;
}

function getMarketSession(now = Date.now()) {
  if (!isGatekeeperOpen(now)) return 'CLOSED';
  const mins = getEtMinutes(now);
  if (mins >= RTH_OPEN_ET && mins < RTH_CLOSE_ET) return 'RTH';
  if (mins >= PRE_OPEN_ET && mins < RTH_OPEN_ET)  return 'PRE';
  if (mins >= RTH_CLOSE_ET && mins < POST_CLOSE_ET) return 'POST';
  return 'CLOSED';
}

function getSessionConfig(now = Date.now()) {
  const session = getMarketSession(now);
  const today = getEtDateString(now);

  const onToday = c => getEtDateString(c.datetime) === today;
  const inMins  = (c, lo, hi) => {
    const mins = getEtMinutes(c.datetime);
    return mins >= lo && mins < hi;
  };

  switch (session) {
    case 'PRE': {
      const { ethStartMs, capEndMs } = getEthDayBounds(now);
      return {
        session,
        tag: 'PRE',
        needExtendedHours: true,
        vwapStartMs: ethStartMs,
        filterCandle: c => onToday(c) && c.datetime >= ethStartMs && c.datetime <= capEndMs
      };
    }
    case 'RTH':
      return {
        session,
        tag: 'RTH',
        needExtendedHours: false,
        vwapStartMs: utcFromEtDateTime(today, 9, 30),
        filterCandle: c => onToday(c) && inMins(c, RTH_OPEN_ET, RTH_CLOSE_ET)
      };
    case 'POST':
      return {
        session,
        tag: 'RTH+POST',
        needExtendedHours: true,
        vwapStartMs: utcFromEtDateTime(today, 9, 30),
        filterCandle: c => onToday(c) && inMins(c, RTH_OPEN_ET, POST_CLOSE_ET)
      };
    default:
      return {
        session: 'CLOSED',
        tag: 'EOD',
        needExtendedHours: true,
        // Span weekends/holidays — last trade may be several calendar days ago
        vwapStartMs: now - CLOSED_LOOKBACK_MS,
        filterCandle: c => inMins(c, RTH_OPEN_ET, POST_CLOSE_ET)
      };
  }
}

function getVwapConfig(now = Date.now()) {
  const session = getMarketSession(now);
  if (session === 'CLOSED') return getSessionConfig(now);

  const bounds = getEthDayBounds(now);
  const tag = session === 'POST' ? 'RTH+POST' : session;

  return {
    session,
    tag,
    needExtendedHours: true,
    vwapStartMs: bounds.ethStartMs,
    filterCandle: c =>
      getEtDateString(c.datetime) === bounds.today &&
      c.datetime >= bounds.ethStartMs &&
      c.datetime <= bounds.capEndMs
  };
}

function formatUsd(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : 'n/a';
}

function formatEtHm(ms) {
  const { h, m } = getEtHourMinute(ms);
  return `${h}:${String(m).padStart(2, '0')}`;
}

function isVwapPartialEth(candles, anchorMs) {
  if (!candles.length) return true;
  return candles[0].datetime > anchorMs + 30 * 60 * 1000;
}

function formatVwapTag(sessionTag, partialEth) {
  return partialEth ? `${sessionTag} · 7AM start` : sessionTag;
}

function sortCandles(candles) {
  return candles.length > 1 && candles[0].datetime
    ? [...candles].sort((a, b) => a.datetime - b.datetime)
    : candles;
}

function getLastCandleEtDate(candles) {
  if (!candles?.length) return getEtDateString(Date.now());
  const sorted = sortCandles(candles);
  return getEtDateString(sorted[sorted.length - 1].datetime);
}

function filterToMostRecentTradingDay(candles, filterCandle) {
  if (!candles.length) return [];
  const sorted  = sortCandles(candles);
  const lastDay = getEtDateString(sorted[sorted.length - 1].datetime);
  return sorted.filter(c => getEtDateString(c.datetime) === lastDay && filterCandle(c));
}

function buildVwapPackFrom1m(candles1m, cfg) {
  const candles = sortCandles(candles1m).filter(
    c => c.datetime >= cfg.vwapStartMs && cfg.filterCandle(c)
  );
  const partialEth = isVwapPartialEth(candles, cfg.vwapStartMs);
  return {
    candles,
    tag:        formatVwapTag(cfg.tag, partialEth),
    session:    cfg.session,
    barSize:    '1m',
    bucketMs:   60 * 1000,
    partialEth,
    firstBarMs: candles[0]?.datetime ?? null
  };
}

/** VWAP config aligned to bars already scoped to the active session day. */
function vwapCfgForSessionBars(candles1m, pmCfg, now = Date.now()) {
  if (!candles1m?.length) return pmCfg;
  const sessionDay = getLastCandleEtDate(candles1m);
  const { ethStartMs, capEndMs } = getEthDayBoundsForDay(sessionDay, now);
  const cap = Math.min(now, capEndMs);
  return {
    ...pmCfg,
    vwapStartMs: ethStartMs,
    filterCandle: c =>
      getEtDateString(c.datetime) === sessionDay &&
      c.datetime >= ethStartMs &&
      c.datetime <= cap
  };
}

function resolveVwapPackFrom1m(candles1m, pmCfg, now = Date.now()) {
  const vwapPack = buildVwapPackFrom1m(candles1m, pmCfg);
  // TOS VWAP (0,0,DAY) = cumulative from 4:00 AM ET through extended hours.
  // partialEth only affects the display tag (first bar after 4:30), not a switch to RTH-only.
  if (getEtMinutes(now) < RTH_OPEN_ET) {
    return { vwapPack, vwapAnchor: 'ETH' };
  }
  return { vwapPack, vwapAnchor: 'PM' };
}

/** Daily bars for 14-day average volume (cached per symbol). */
async function getDailyCandles(symbol) {
  return getPriceHistory(symbol, 'month', 2, 'daily', 1, {
    needExtendedHoursData: false
  });
}

/**
 * Daily RVOL = today's cumulative volume (sum of today's 1m bars) ÷ avg daily volume of prior 14 sessions.
 */
function calcDailyRvol14(candles1m, dailyCandles, now = Date.now()) {
  const sessionDay = candles1m?.length ? getLastCandleEtDate(candles1m) : getEtDateString(now);
  const todayVol = sortCandles(candles1m)
    .filter(c => getEtDateString(c.datetime) === sessionDay)
    .reduce((s, c) => s + (Number.isFinite(c.volume) ? c.volume : 0), 0);

  const priorDays = sortCandles(dailyCandles || [])
    .filter(c => getEtDateString(c.datetime) !== sessionDay && Number.isFinite(c.volume) && c.volume > 0)
    .slice(-DAILY_RVOL_LOOKBACK);

  if (priorDays.length < DAILY_RVOL_LOOKBACK || todayVol <= 0) {
    return { rvol: null, todayVol, avg14: null, priorDays };
  }
  const avg14 = priorDays.reduce((s, c) => s + c.volume, 0) / DAILY_RVOL_LOOKBACK;
  return { rvol: todayVol / avg14, todayVol, avg14, priorDays };
}

const KEY_LEVEL_KIND_LABEL = {
  whole: 'Whole Dollar',
  half: 'Half Dollar',
  pivot: 'Pivot',
  pivot_high: 'Pivot',
  pivot_low: 'Pivot',
  session_hod: 'HOD',
  session_lod: 'LOD',
  premarket_high: 'Premarket High',
  premarket_low: 'Premarket Low',
  tested_high: 'Pivot',
  tested_low: 'Pivot',
  prior_hod: 'HOD',
  prior_lod: 'LOD',
  prev_close: 'Prev close',
  ema9: '9 EMA',
  vwap: 'VWAP'
};

const KEY_LEVEL_KIND_PRIORITY = {
  premarket_high: 1,
  premarket_low: 1,
  session_hod: 2,
  session_lod: 2,
  pivot: 3,
  pivot_high: 3,
  pivot_low: 3,
  tested_high: 4,
  tested_low: 4,
  whole: 5,
  half: 5,
  ema9: 6,
  vwap: 6,
  prior_hod: 7,
  prior_lod: 7,
  prev_close: 8
};

function collectPsychLevels(price, span = 4) {
  const levels = [];
  const base = Math.floor(price);
  for (let d = base - span; d <= base + span + 1; d++) {
    if (d > 0) levels.push({ price: d, kind: 'whole' });
    const half = d + 0.5;
    if (half > 0) levels.push({ price: half, kind: 'half' });
  }
  return levels;
}

/** Confirmed swing high/low; last bars use fewer right-side bars so fresh reversals count. */
function findPivotHighs(bars, left = 3, right = 3) {
  const pivots = [];
  if (bars.length < left + 1) return pivots;
  for (let i = left; i < bars.length; i++) {
    const r = Math.min(right, bars.length - 1 - i);
    if (i < left || r < 0) continue;
    const h = bars[i].high;
    if (!Number.isFinite(h)) continue;
    let ok = true;
    for (let j = i - left; j <= i + r; j++) {
      if (j === i) continue;
      if (bars[j].high > h) { ok = false; break; }
    }
    if (ok) {
      pivots.push({ price: h, kind: 'pivot_high', barIndex: i, datetime: bars[i].datetime });
    }
  }
  return pivots;
}

function findPivotLows(bars, left = 3, right = 3) {
  const pivots = [];
  if (bars.length < left + 1) return pivots;
  for (let i = left; i < bars.length; i++) {
    const r = Math.min(right, bars.length - 1 - i);
    if (i < left || r < 0) continue;
    const l = bars[i].low;
    if (!Number.isFinite(l)) continue;
    let ok = true;
    for (let j = i - left; j <= i + r; j++) {
      if (j === i) continue;
      if (bars[j].low < l) { ok = false; break; }
    }
    if (ok) {
      pivots.push({ price: l, kind: 'pivot_low', barIndex: i, datetime: bars[i].datetime });
    }
  }
  return pivots;
}

function levelTolerance(price) {
  return Math.max(0.03, price * 0.012);
}

function countResistanceTouches(bars, level, tol) {
  let n = 0;
  for (const c of bars) {
    if (Number.isFinite(c.high) && c.high >= level - tol) n++;
  }
  return n;
}

function countSupportTouches(bars, level, tol) {
  let n = 0;
  for (const c of bars) {
    if (Number.isFinite(c.low) && c.low <= level + tol) n++;
  }
  return n;
}

function countOpenCloseTouches(bars, level, tol) {
  let n = 0;
  for (const c of bars) {
    if (Number.isFinite(c.open) && Math.abs(c.open - level) <= tol) n++;
    else if (Number.isFinite(c.close) && Math.abs(c.close - level) <= tol) n++;
  }
  return n;
}

function isWholeDollarPrice(price) {
  if (!Number.isFinite(price)) return false;
  const frac = Math.abs(price - Math.round(price));
  return frac < 0.02 || frac > 0.98;
}

function isHalfDollarPrice(price) {
  if (!Number.isFinite(price)) return false;
  const frac = price - Math.floor(price);
  return Math.abs(frac - 0.5) < 0.02;
}

function getPremarketExtremes(bars, now = Date.now()) {
  const sessionDay = getEtDateString(now);
  const pm = bars.filter(c => {
    if (getEtDateString(c.datetime) !== sessionDay) return false;
    const mins = getEtMinutes(c.datetime);
    return mins >= PRE_OPEN_ET && mins < RTH_OPEN_ET;
  });
  if (!pm.length) return { high: null, low: null };
  const highs = pm.map(c => c.high).filter(Number.isFinite);
  const lows = pm.map(c => c.low).filter(Number.isFinite);
  return {
    high: highs.length ? Math.max(...highs) : null,
    low: lows.length ? Math.min(...lows) : null
  };
}

/** Display kind for a selected level — never generic "Tested". */
function annotateKeyLevel(candidate, bars, ctx, side) {
  if (!candidate || !Number.isFinite(candidate.price)) return null;
  const price = round2(candidate.price);
  const tol = levelTolerance(price);
  const touches = candidate.touches ??
    (side === 'down'
      ? countSupportTouches(bars, price, tol)
      : countResistanceTouches(bars, price, tol));
  const ocTouches = countOpenCloseTouches(bars, price, tol);

  if (side !== 'down') {
    if (ctx.pmHigh != null && Math.abs(price - ctx.pmHigh) <= tol) {
      return { price: round2(ctx.pmHigh), kind: 'premarket_high', touches };
    }
    if (ctx.sessionHod != null && Math.abs(price - ctx.sessionHod) <= tol) {
      return { price: round2(ctx.sessionHod), kind: 'session_hod', touches };
    }
  }
  if (side !== 'up') {
    if (ctx.pmLow != null && Math.abs(price - ctx.pmLow) <= tol) {
      return { price: round2(ctx.pmLow), kind: 'premarket_low', touches };
    }
    if (ctx.sessionLod != null && Math.abs(price - ctx.sessionLod) <= tol) {
      return { price: round2(ctx.sessionLod), kind: 'session_lod', touches };
    }
  }

  if (isWholeDollarPrice(price)) {
    return { price, kind: 'whole', touches };
  }
  if (isHalfDollarPrice(price)) {
    return { price, kind: 'half', touches };
  }

  if (ocTouches >= 2 ||
      candidate.kind === 'pivot' ||
      candidate.kind === 'pivot_high' ||
      candidate.kind === 'pivot_low' ||
      candidate.kind === 'tested_high' ||
      candidate.kind === 'tested_low') {
    return { price, kind: 'pivot', touches: Math.max(ocTouches, touches || 0) };
  }

  if (candidate.kind && KEY_LEVEL_KIND_LABEL[candidate.kind]) {
    const kind = candidate.kind.startsWith('pivot') ? 'pivot' : candidate.kind;
    return { price, kind, touches };
  }
  return { price, kind: 'pivot', touches };
}

/** Bonus for half/whole $ and .x0 / .x5 handles (e.g. 1.50, 2.00, 1.70). */
function psychLevelBonus(level) {
  const frac = level - Math.floor(level);
  if (frac <= 0.04 || frac >= 0.96) return 3;
  if (Math.abs(frac - 0.5) <= 0.04) return 2;
  const dime = Math.round(frac * 10) / 10;
  if (Math.abs(frac - dime) <= 0.025 && (Math.abs(dime * 10 - Math.round(dime * 10)) < 0.01)) {
    const cents = Math.round(dime * 100) % 10;
    if (cents === 0 || cents === 5) return 2;
  }
  return 0;
}

/** Cluster highs into $0.05 buckets — repeated tests at/under a ceiling (e.g. 1.70). */
function buildTouchResistanceClusters(bars, price, buf, lookback = 48) {
  const tail = bars.slice(-Math.min(lookback, bars.length));
  const step = 0.05;
  const buckets = new Map();
  for (const c of tail) {
    if (!Number.isFinite(c.high) || c.high <= price + buf) continue;
    const bucket = Math.round(c.high / step) * step;
    const entry = buckets.get(bucket) || { highs: [] };
    entry.highs.push(c.high);
    buckets.set(bucket, entry);
  }
  return [...buckets.entries()]
    .filter(([, v]) => v.highs.length >= 2)
    .map(([bucket, v]) => ({
      price: round2(v.highs.reduce((s, h) => s + h, 0) / v.highs.length),
      kind: 'tested_high',
      touches: v.highs.length
    }));
}

function buildTouchSupportClusters(bars, price, buf, lookback = 48) {
  const tail = bars.slice(-Math.min(lookback, bars.length));
  const step = 0.05;
  const buckets = new Map();
  for (const c of tail) {
    if (!Number.isFinite(c.low) || c.low >= price - buf) continue;
    const bucket = Math.round(c.low / step) * step;
    const entry = buckets.get(bucket) || { lows: [] };
    entry.lows.push(c.low);
    buckets.set(bucket, entry);
  }
  return [...buckets.entries()]
    .filter(([, v]) => v.lows.length >= 2)
    .map(([bucket, v]) => ({
      price: round2(v.lows.reduce((s, l) => s + l, 0) / v.lows.length),
      kind: 'tested_low',
      touches: v.lows.length
    }));
}

function scoreResistanceCandidate(candidate, bars, sessionHod) {
  const tol = levelTolerance(candidate.price);
  const touches = candidate.touches ?? countResistanceTouches(bars, candidate.price, tol);
  const psych = psychLevelBonus(candidate.price);
  const isHod = Number.isFinite(sessionHod) && Math.abs(candidate.price - sessionHod) <= tol;
  let score = touches * 100 + psych * 15;
  if (isHod && touches >= 2) score += 40;
  if (isHod && touches === 1) score -= 50;
  return { ...candidate, touches, score, isHod };
}

function finalizeResistancePick(pick, ctx, bars) {
  if (!pick) return null;
  return annotateKeyLevel(pick, bars, ctx, 'up');
}

function pickMostRecentPivot(pivots, price, buf, side) {
  const filtered = pivots.filter(p => {
    if (!Number.isFinite(p.price)) return false;
    return side === 'up' ? p.price > price + buf : p.price < price - buf;
  });
  if (!filtered.length) return null;
  filtered.sort((a, b) => (b.barIndex ?? 0) - (a.barIndex ?? 0));
  return filtered[0];
}

function pickKeyLevelUp(price, unique, allBars, buf, ctx) {
  const sessionHod = ctx.sessionHod;

  const pool = [
    ...buildTouchResistanceClusters(allBars, price, buf),
    ...unique.filter(c =>
      ['pivot_high', 'pivot', 'half', 'whole', 'session_hod', 'premarket_high'].includes(c.kind) &&
      c.price > price + buf
    )
  ];
  if (Number.isFinite(sessionHod) && sessionHod > price + buf) {
    pool.push({ price: sessionHod, kind: 'session_hod' });
  }
  if (ctx.pmHigh != null && ctx.pmHigh > price + buf) {
    pool.push({ price: ctx.pmHigh, kind: 'premarket_high' });
  }

  const recentPivot = pickMostRecentPivot(
    unique.filter(c => c.kind === 'pivot_high' || c.kind === 'pivot'),
    price, buf, 'up'
  );
  if (recentPivot) pool.push(recentPivot);

  if (pool.length) {
    const scored = pool.map(c => scoreResistanceCandidate(c, allBars, sessionHod));
    const withMulti = scored.filter(s => s.touches >= 2);
    const ranked = (withMulti.length ? withMulti : scored).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.price - b.price;
    });
    const finalized = finalizeResistancePick(ranked[0], ctx, allBars);
    if (finalized) return finalized;
  }

  const above = unique
    .filter(c => c.price > price + buf)
    .sort((a, b) => a.price - b.price);
  return above[0] ? annotateKeyLevel(above[0], allBars, ctx, 'up') : null;
}

function pickKeyLevelDown(price, unique, allBars, buf, ctx) {
  const sessionLod = ctx.sessionLod;

  const pool = [
    ...buildTouchSupportClusters(allBars, price, buf),
    ...unique.filter(c =>
      ['pivot_low', 'pivot', 'half', 'whole', 'session_lod', 'premarket_low'].includes(c.kind) &&
      c.price < price - buf
    )
  ];
  if (Number.isFinite(sessionLod) && sessionLod < price - buf) {
    pool.push({ price: sessionLod, kind: 'session_lod' });
  }
  if (ctx.pmLow != null && ctx.pmLow < price - buf) {
    pool.push({ price: ctx.pmLow, kind: 'premarket_low' });
  }

  const recentPivot = pickMostRecentPivot(
    unique.filter(c => c.kind === 'pivot_low' || c.kind === 'pivot'),
    price, buf, 'down'
  );
  if (recentPivot) pool.push(recentPivot);

  if (pool.length) {
    const scored = pool.map(c => {
      const tol = levelTolerance(c.price);
      const touches = c.touches ?? countSupportTouches(allBars, c.price, tol);
      const psych = psychLevelBonus(c.price);
      const isLod = Number.isFinite(sessionLod) && Math.abs(c.price - sessionLod) <= tol;
      let score = touches * 100 + psych * 15;
      if (isLod && touches >= 2) score += 40;
      return { ...c, touches, score };
    });
    const withMulti = scored.filter(s => s.touches >= 2);
    const ranked = (withMulti.length ? withMulti : scored).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.price - a.price;
    });
    const pick = ranked[0];
    if (pick) return annotateKeyLevel(pick, allBars, ctx, 'down');
  }

  const below = unique
    .filter(c => c.price < price - buf)
    .sort((a, b) => b.price - a.price);
  return below[0] ? annotateKeyLevel(below[0], allBars, ctx, 'down') : null;
}

function dedupeKeyLevels(candidates, minDist) {
  const sorted = [...candidates].sort((a, b) => a.price - b.price);
  const out = [];
  for (const c of sorted) {
    const existing = out.find(o => Math.abs(o.price - c.price) <= minDist);
    if (!existing) {
      out.push({ ...c });
      continue;
    }
    const pNew = KEY_LEVEL_KIND_PRIORITY[c.kind] ?? 99;
    const pOld = KEY_LEVEL_KIND_PRIORITY[existing.kind] ?? 99;
    if (pNew < pOld) Object.assign(existing, c);
  }
  return out;
}

function formatKeyLevelCandidate(c) {
  const out = {
    price: round2(c.price),
    kind: c.kind,
    kind_label: KEY_LEVEL_KIND_LABEL[c.kind] || c.kind
  };
  if (c.touches != null) out.touches = c.touches;
  return out;
}

/**
 * Nearest proven resistance (up) / support (down) from HOD/LOD, pivots, 9 EMA, VWAP, psych levels, prior session.
 */
function calcKeyLevels(sessionBars, dailyCandles, price, prevClose, ema9, vwap, now = Date.now()) {
  if (!Number.isFinite(price) || price <= 0) {
    return { key_level_up: null, key_level_down: null };
  }

  const candidates = [];
  candidates.push(...collectPsychLevels(price));

  if (Number.isFinite(prevClose) && prevClose > 0) {
    candidates.push({ price: prevClose, kind: 'prev_close' });
  }
  if (Number.isFinite(ema9) && ema9 > 0) {
    candidates.push({ price: ema9, kind: 'ema9' });
  }
  if (Number.isFinite(vwap) && vwap > 0) {
    candidates.push({ price: vwap, kind: 'vwap' });
  }

  const allBars = sortCandles(sessionBars);
  const completed = getCompleted1mBars(allBars);
  const pivotBars = completed.length >= 7 ? completed : allBars;

  const pmExt = getPremarketExtremes(allBars, now);
  if (Number.isFinite(pmExt.high)) {
    candidates.push({ price: pmExt.high, kind: 'premarket_high' });
  }
  if (Number.isFinite(pmExt.low)) {
    candidates.push({ price: pmExt.low, kind: 'premarket_low' });
  }

  if (allBars.length) {
    const hod = Math.max(...allBars.map(c => c.high).filter(Number.isFinite));
    const lod = Math.min(...allBars.map(c => c.low).filter(Number.isFinite));
    if (Number.isFinite(hod)) candidates.push({ price: hod, kind: 'session_hod' });
    if (Number.isFinite(lod)) candidates.push({ price: lod, kind: 'session_lod' });
  }
  if (pivotBars.length >= 7) {
    candidates.push(...findPivotHighs(pivotBars));
    candidates.push(...findPivotLows(pivotBars));
  }
  const sessionDay = getEtDateString(now);
  const priorDaily = sortCandles(dailyCandles || [])
    .filter(c => getEtDateString(c.datetime) !== sessionDay);
  if (priorDaily.length) {
    const last = priorDaily[priorDaily.length - 1];
    if (Number.isFinite(last.high)) candidates.push({ price: last.high, kind: 'prior_hod' });
    if (Number.isFinite(last.low)) candidates.push({ price: last.low, kind: 'prior_lod' });
  }

  const minDist = Math.max(0.03, price * 0.008);
  const unique = dedupeKeyLevels(candidates, minDist);
  const buf = Math.max(0.01, price * 0.002);

  const RESISTANCE_KINDS = new Set([
    'tested_high', 'pivot_high', 'pivot', 'session_hod', 'premarket_high',
    'prior_hod', 'ema9', 'vwap', 'whole', 'half', 'prev_close'
  ]);
  const SUPPORT_KINDS = new Set([
    'tested_low', 'pivot_low', 'pivot', 'session_lod', 'premarket_low',
    'prior_lod', 'ema9', 'vwap', 'whole', 'half', 'prev_close'
  ]);

  const sessionHod = allBars.length
    ? Math.max(...allBars.map(c => c.high).filter(Number.isFinite))
    : null;
  const sessionLod = allBars.length
    ? Math.min(...allBars.map(c => c.low).filter(Number.isFinite))
    : null;
  const levelCtx = {
    sessionHod: Number.isFinite(sessionHod) ? sessionHod : null,
    sessionLod: Number.isFinite(sessionLod) ? sessionLod : null,
    pmHigh: pmExt.high,
    pmLow: pmExt.low,
    price
  };

  const upPick = pickKeyLevelUp(price, unique, allBars, buf, levelCtx);
  const downPick = pickKeyLevelDown(price, unique, allBars, buf, levelCtx);

  let key_level_session_hod = null;
  if (Number.isFinite(sessionHod) && sessionHod > price + buf) {
    const hodTol = levelTolerance(sessionHod);
    const hodTouches = countResistanceTouches(allBars, sessionHod, hodTol);
    const upPrice = upPick?.price;
    if (!Number.isFinite(upPrice) || Math.abs(sessionHod - upPrice) > hodTol) {
      key_level_session_hod = formatKeyLevelCandidate({
        price: sessionHod,
        kind: 'session_hod',
        touches: hodTouches
      });
    }
  }

  const aboveAlts = unique
    .filter(c => c.price > price + buf && RESISTANCE_KINDS.has(c.kind))
    .sort((a, b) => (b.barIndex ?? 0) - (a.barIndex ?? 0) || a.price - b.price);
  const belowAlts = unique
    .filter(c => c.price < price - buf && SUPPORT_KINDS.has(c.kind))
    .sort((a, b) => (b.barIndex ?? 0) - (a.barIndex ?? 0) || b.price - a.price);

  return {
    key_level_up: upPick ? formatKeyLevelCandidate(upPick) : null,
    key_level_down: downPick ? formatKeyLevelCandidate(downPick) : null,
    key_level_session_hod,
    key_level_session_lod: null,
    key_level_candidates_up: aboveAlts.slice(0, 5).map(formatKeyLevelCandidate),
    key_level_candidates_down: belowAlts.slice(0, 5).map(formatKeyLevelCandidate)
  };
}

/**
 * Schwab periodType=day 1m can lag on gap/IPO names (last bar days old while quote is live).
 * Use startDate/endDate for the active ETH session when the gate is open.
 */
function getSession1mFetchRange(now = Date.now()) {
  const sessionDay = getEtDateString(now);
  const { ethStartMs, capEndMs } = getEthDayBoundsForDay(sessionDay, now);
  const endMs = isGatekeeperOpen(now) ? Math.min(now, capEndMs) : capEndMs;
  return { startDate: ethStartMs, endDate: endMs };
}

async function getSession1mCandles(symbol, now = Date.now()) {
  if (isGatekeeperOpen(now)) {
    const { startDate, endDate } = getSession1mFetchRange(now);
    const session = await getPriceHistory(symbol, null, null, 'minute', 1, {
      needExtendedHoursData: true,
      startDate,
      endDate
    });
    if (session.length >= MACD_MIN_BARS) return session;
    const extra = await getPriceHistory(symbol, 'day', 5, 'minute', 1, {
      needExtendedHoursData: true
    });
    return mergeCandleSources(session, extra);
  }
  return getPriceHistory(symbol, 'day', 5, 'minute', 1, {
    needExtendedHoursData: true
  });
}

async function getSignal1mCandles(symbol, now = Date.now()) {
  return getSession1mCandles(symbol, now);
}

/** Same session-range 1m as signal when open; period fallback when closed (cached ~60s). */
async function getIndicator1mCandles(symbol, now = Date.now()) {
  if (isGatekeeperOpen(now)) {
    const session = await getSession1mCandles(symbol, now);
    if (session.length >= MACD_MIN_BARS) return session;
    const extra = await getPriceHistory(symbol, 'day', INDICATOR_1M_PERIOD, 'minute', 1, {
      needExtendedHoursData: true
    });
    return mergeCandleSources(session, extra);
  }
  return getPriceHistory(symbol, 'day', INDICATOR_1M_PERIOD, 'minute', 1, {
    needExtendedHoursData: true
  });
}

function cacheInvalidSymbol(symbol) {
  responseCache[symbol] = {
    status: 'invalid_symbol',
    symbol,
    suggestion: TICKER_SUGGESTIONS[symbol] || null
  };
}

function isQuoteValid(quote) {
  return quote && Number.isFinite(quote.lastPrice);
}

function applyLiveQuoteToCandles(candles, quote, bucketMs = 60 * 1000) {
  if (!candles?.length || !quote?.lastPrice || !Number.isFinite(quote.lastPrice)) return candles;
  const sorted = candles.length > 1 && candles[0].datetime
    ? [...candles].sort((a, b) => a.datetime - b.datetime)
    : [...candles];
  const last  = sorted[sorted.length - 1];
  const qTime = quote.quoteTime || quote.tradeTime;
  const price = quote.lastPrice;

  if (!qTime) { last.close = price; return sorted; }

  const qBucket    = Math.floor(qTime / bucketMs) * bucketMs;
  const lastBucket = Math.floor(last.datetime / bucketMs) * bucketMs;

  if (qBucket === lastBucket) {
    last.close = price;
    if (last.high != null) last.high = Math.max(last.high, price);
    if (last.low  != null) last.low  = Math.min(last.low,  price);
  } else if (qBucket > lastBucket) {
    sorted.push({ datetime: qBucket, open: price, high: price, low: price, close: price, volume: 0 });
  }
  return sorted;
}

function shouldPatchQuote(candles, quote, bucketMs = 60 * 1000) {
  if (!candles?.length || !quote?.quoteTime) return false;
  return quote.quoteTime > candles[candles.length - 1].datetime + bucketMs;
}

// ── SIGNAL CALCULATIONS ───────────────────────────────────────

function round2(n) {
  return Math.round(n * 100) / 100;
}

function lastFinite(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (Number.isFinite(arr[i])) return arr[i];
  }
  return null;
}

function formatTimeEtIso(now = Date.now()) {
  const d = new Date(now);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset'
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value;
  const tzName = parts.find(p => p.type === 'timeZoneName')?.value || '';
  const offMatch = tzName.match(/([+-])(\d{1,2})(?::(\d{2}))?/);
  let offset = '-05:00';
  if (offMatch) {
    const sign = offMatch[1];
    const hh = String(offMatch[2]).padStart(2, '0');
    const mm = offMatch[3] || '00';
    offset = `${sign}${hh}:${mm}`;
  }
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
}

/** User-facing session label for the context grid (not internal RTH/PRE codes). */
function contextMarketSession(now = Date.now()) {
  const s = getMarketSession(now);
  switch (s) {
    case 'PRE': return 'Pre-Market';
    case 'RTH': return 'Market Open';
    case 'POST': return 'After Hours';
    case 'CLOSED': return 'Closed';
    default: return s;
  }
}

function formatTimeEtHms(ms) {
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  }).formatToParts(new Date(ms));
  const get = t => parts.find(p => p.type === t)?.value;
  return `${get('hour')}:${get('minute')}:${get('second')}`;
}

function parseNasdaqEtDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const dm = dateStr.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!dm) return null;
  const [, mo, day, yr] = dm;
  const dateIso = `${yr}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const tm = timeStr.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!tm) return null;
  const hour = parseInt(tm[1], 10);
  const minute = parseInt(tm[2], 10);
  const second = parseInt(tm[3], 10);
  const frac = tm[4] ? parseInt(tm[4].padEnd(3, '0').slice(0, 3), 10) : 0;
  const base = utcFromEtDateTime(dateIso, hour, minute);
  if (!Number.isFinite(base)) return null;
  return base + second * 1000 + frac;
}

function displayNasdaqEtTime(timeStr) {
  if (!timeStr) return null;
  const t = timeStr.trim();
  const m = t.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!m) return t;
  const frac = m[4] ? `.${m[4].replace(/0+$/, '') || m[4]}` : '';
  return `${String(parseInt(m[1], 10)).padStart(2, '0')}:${m[2]}:${m[3]}${frac}`;
}

function parseNasdaqHaltsHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let isHeader = true;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    if (isHeader) {
      isHeader = false;
      continue;
    }
    const tds = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let td;
    while ((td = tdRe.exec(m[1])) !== null) {
      tds.push(td[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    }
    if (tds.length < 6) continue;
    rows.push({
      haltDate: tds[0],
      haltTime: tds[1],
      symbol: (tds[2] || '').toUpperCase(),
      issueName: tds[3],
      market: tds[4],
      reasonCode: tds[5],
      pauseThresholdPrice: tds[6] || '',
      resumptionDate: tds[7] || '',
      resumptionQuoteTime: tds[8] || '',
      resumptionTradeTime: tds[9] || ''
    });
  }
  return rows;
}

async function refreshNasdaqHalts() {
  if (nasdaqHaltsRefreshPromise) return nasdaqHaltsRefreshPromise;
  nasdaqHaltsRefreshPromise = (async () => {
    try {
      const res = await axios.post(
        NASDAQ_HALT_RPC_URL,
        { id: 2, method: 'BL_TradeHalt.GetTradeHalts', params: '[]', version: '1.1' },
        {
          headers: { Referer: 'https://www.nasdaqtrader.com/trader.aspx?id=TradeHalts' },
          timeout: 15000
        }
      );
      const html = res.data?.result;
      if (typeof html === 'string') {
        nasdaqHaltsCache.rows = parseNasdaqHaltsHtml(html);
        nasdaqHaltsCache.fetchedAt = Date.now();
      }
    } catch (err) {
      console.warn('Nasdaq trade halts fetch failed:', err.message);
    } finally {
      nasdaqHaltsRefreshPromise = null;
    }
  })();
  return nasdaqHaltsRefreshPromise;
}

function startNasdaqHaltPoll() {
  refreshNasdaqHalts();
  setInterval(refreshNasdaqHalts, NASDAQ_HALT_POLL_MS);
}

function findNasdaqHaltRow(symbol) {
  const sym = (symbol || '').toUpperCase();
  if (!sym) return null;
  return nasdaqHaltsCache.rows.find(r => r.symbol === sym) || null;
}

function isNasdaqHaltActive(row, now = Date.now()) {
  if (!row) return false;
  const trade = (row.resumptionTradeTime || '').trim();
  if (!trade) return true;
  const resumeMs = parseNasdaqEtDateTime(row.resumptionDate, trade);
  if (!Number.isFinite(resumeMs)) return true;
  return now < resumeMs;
}

function isLudpStyleReason(code) {
  return /^(LUDP|LULD)$/i.test((code || '').trim());
}

function tradingStatusFromNasdaqHalt(row, now = Date.now()) {
  const reason = (row.reasonCode || 'Halt').trim();
  const haltMs = parseNasdaqEtDateTime(row.haltDate, row.haltTime);
  const halt_time_et = displayNasdaqEtTime(row.haltTime);
  const ludp = isLudpStyleReason(reason);

  let resumption_time_et = null;
  let resumption_estimated = false;
  const trade = (row.resumptionTradeTime || '').trim();
  if (trade) {
    resumption_time_et = displayNasdaqEtTime(trade);
  } else if (ludp && Number.isFinite(haltMs)) {
    resumption_time_et = formatTimeEtHms(haltMs + LUDP_PAUSE_MS);
    resumption_estimated = true;
  }

  return {
    status: 'halted',
    status_line: `Status: Halt (${reason})`,
    halt_time_et,
    resumption_time_et,
    resumption_pending: !trade,
    resumption_estimated,
    halt_reason: reason,
    halt_source: 'nasdaq'
  };
}

function normalizeSecurityStatus(quote) {
  const raw = quote?.securityStatus;
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') return raw.trim();
  const codes = {
    0: 'Unknown',
    1: 'Normal',
    2: 'Halted',
    3: 'Paused',
    4: 'Offline',
    5: 'Closed'
  };
  return codes[raw] || String(raw);
}

function haltReasonLabel(quote, statusStr) {
  const s = (statusStr || '').toLowerCase();
  if (/ludp|luld|limit up|limit down/.test(s)) return 'LUDP';
  if (/pause/.test(s)) return 'Paused';
  if (/^halted?$/i.test((statusStr || '').trim())) return 'LUDP';
  if (/halt/.test(s)) return 'Halt';
  if (statusStr) return statusStr;
  return 'LUDP';
}

function detectQuoteHalt(quote, now = Date.now()) {
  const statusStr = normalizeSecurityStatus(quote);
  if (statusStr && /halt|pause|luld|limit state|non.?firm/i.test(statusStr)) {
    return { halted: true, reason: haltReasonLabel(quote, statusStr) };
  }
  const session = getMarketSession(now);
  if (session !== 'RTH' || !quote) return { halted: false };

  const tradeMs = quote.tradeTime || quote.quoteTime;
  if (!Number.isFinite(tradeMs) || !Number.isFinite(quote.lastPrice)) return { halted: false };
  const staleMs = Date.now() - tradeMs;
  const vol = quote.totalVolume;
  if (Number.isFinite(vol) && vol > 0 && staleMs > 180000) {
    return { halted: true, reason: 'LUDP', inferred: true };
  }
  return { halted: false };
}

function computeTradingStatus(symbol, quote, now = Date.now()) {
  if (Date.now() - nasdaqHaltsCache.fetchedAt > NASDAQ_HALT_POLL_MS + 5000) {
    refreshNasdaqHalts().catch(() => {});
  }
  const nasdaqRow = findNasdaqHaltRow(symbol);
  if (nasdaqRow && isNasdaqHaltActive(nasdaqRow, now)) {
    return tradingStatusFromNasdaqHalt(nasdaqRow, now);
  }

  const halt = detectQuoteHalt(quote, now);
  let tr = haltTrackers[symbol];

  if (halt.halted) {
    if (!tr?.halted) {
      const eventMs = quote?.tradeTime || quote?.quoteTime || now;
      tr = { halted: true, haltSinceMs: eventMs, reason: halt.reason };
      haltTrackers[symbol] = tr;
    } else {
      tr.reason = halt.reason || tr.reason;
    }
    const reason = tr.reason || 'LUDP';
    const ludp = isLudpStyleReason(reason) || reason === 'LUDP';
    let resumption_time_et = null;
    let resumption_estimated = false;
    if (ludp && Number.isFinite(tr.haltSinceMs)) {
      resumption_time_et = formatTimeEtHms(tr.haltSinceMs + LUDP_PAUSE_MS);
      resumption_estimated = true;
    }
    return {
      status: 'halted',
      status_line: `Status: Halt (${reason})`,
      halt_time_et: formatTimeEtHms(tr.haltSinceMs),
      resumption_time_et,
      resumption_pending: true,
      resumption_estimated,
      halt_reason: reason,
      halt_source: 'schwab'
    };
  }

  if (tr?.halted) {
    haltTrackers[symbol] = {
      halted: false,
      lastResumeMs: now,
      lastHaltReason: tr.reason
    };
  } else if (!tr) {
    haltTrackers[symbol] = { halted: false };
  }

  const session = getMarketSession(now);
  if (session === 'CLOSED') {
    return { status: 'closed', status_line: 'Status: Closed', halt_time_et: null, resumption_time_et: null };
  }
  if (session === 'PRE') {
    return { status: 'pre', status_line: 'Status: Pre-Market', halt_time_et: null, resumption_time_et: null };
  }
  if (session === 'POST') {
    return { status: 'ah', status_line: 'Status: After Hours', halt_time_et: null, resumption_time_et: null };
  }
  return { status: 'open', status_line: 'Status: Open', halt_time_et: null, resumption_time_et: null };
}

function formatEtHm(ms) {
  const { h, m } = getEtHourMinute(ms);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function minuteClosePulseFromBars(completed1m) {
  if (!completed1m?.length) {
    return {
      last_completed_1m_key: null,
      minute_close_direction: null,
      last_completed_1m_close: null,
      prev_completed_1m_close: null,
      last_completed_1m_et_hm: null
    };
  }
  const last = completed1m[completed1m.length - 1];
  const key = String(last.datetime);
  if (completed1m.length < 2) {
    return {
      last_completed_1m_key: key,
      minute_close_direction: null,
      last_completed_1m_close: last.close,
      prev_completed_1m_close: null,
      last_completed_1m_et_hm: formatEtHm(last.datetime)
    };
  }
  const prev = completed1m[completed1m.length - 2];
  let minute_close_direction = 'flat';
  if (last.close > prev.close) minute_close_direction = 'up';
  else if (last.close < prev.close) minute_close_direction = 'down';
  return {
    last_completed_1m_key: key,
    minute_close_direction,
    last_completed_1m_close: last.close,
    prev_completed_1m_close: prev.close,
    last_completed_1m_et_hm: formatEtHm(last.datetime)
  };
}

// TOS-exact EMA: SMA seed at index (period - 1), then standard EMA recursion.
function calcEMASMASeed(values, period) {
  const n = values.length;
  const out = Array(n).fill(null);
  if (n < period) return out;
  if (values.some(v => !Number.isFinite(v))) return out;

  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  out[period - 1] = ema;

  for (let i = period; i < n; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

// TOS ExpAverage — first value seeds the EMA (ThinkScript ExpAverage, not SMA seed).
function calcExpAverageTOS(values, period) {
  const n = values.length;
  const out = Array(n).fill(null);
  if (!n || values.some(v => !Number.isFinite(v))) return out;

  const k = 2 / (period + 1);
  let ema = values[0];
  out[0] = ema;
  for (let i = 1; i < n; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

// TOS built-in MACD study: ExpAverage(close,12/26), signal = ExpAverage(MACD,9), hist = MACD - signal.
function calcMACDExactTOS(closes) {
  const n = closes.length;
  const macdLine   = Array(n).fill(null);
  const signalLine = Array(n).fill(null);
  const histogram  = Array(n).fill(null);

  if (n < 26 || closes.some(v => !Number.isFinite(v))) {
    return { macdLine, signalLine, histogram };
  }

  const ema12 = calcExpAverageTOS(closes, 12);
  const ema26 = calcExpAverageTOS(closes, 26);
  const macdSeq = [];

  for (let i = 0; i < n; i++) {
    macdLine[i] = ema12[i] - ema26[i];
    macdSeq.push(macdLine[i]);
  }

  const signalEma = calcExpAverageTOS(macdSeq, 9);
  for (let i = 0; i < n; i++) {
    signalLine[i] = signalEma[i];
    histogram[i] = macdLine[i] - signalEma[i];
  }

  return { macdLine, signalLine, histogram };
}

function getCompleted1mBars(candles) {
  if (!candles?.length) return [];
  const sorted = candles.length > 1 && candles[0].datetime
    ? [...candles].sort((a, b) => a.datetime - b.datetime)
    : [...candles];
  const bucketMs   = 60 * 1000;
  const nowBucket  = Math.floor(Date.now() / bucketMs) * bucketMs;
  const last       = sorted[sorted.length - 1];
  const lastBucket = Math.floor(last.datetime / bucketMs) * bucketMs;
  if (lastBucket >= nowBucket) return sorted.slice(0, -1);
  return sorted;
}

/** Closes for EMA/MACD — includes forming bar (matches TOS chart updating live). */
function getIndicatorCloses(candles) {
  return sortCandles(candles).map(c => c.close).filter(Number.isFinite);
}

function calcVWAP(candles) {
  let cumTPV = 0, cumVol = 0;
  for (const c of candles) {
    const tp  = (c.high + c.low + c.close) / 3;
    if (!Number.isFinite(tp)) continue;
    const vol = Number.isFinite(c.volume) && c.volume > 0 ? c.volume : 0;
    if (vol <= 0) continue;
    cumTPV += tp * vol;
    cumVol += vol;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

/** VWAP 1m series for compute; widens to vol bars on same session day if PM pack is empty. */
function resolveVwapCandlesForCompute(candles1mRaw, quote, pmCfg, vwapPack, vwapAnchor) {
  const bucketMs = vwapPack.bucketMs || 60 * 1000;
  let candlesVwap = sortCandles(vwapPack.candles);
  if (quote && shouldPatchQuote(candlesVwap, quote, bucketMs)) {
    candlesVwap = applyLiveQuoteToCandles(candlesVwap, quote, bucketMs);
  }
  if (candlesVwap.some(c => Number.isFinite(c.volume) && c.volume > 0)) {
    return { candlesVwap, vwapAnchor };
  }

  const withVol = sortCandles(candles1mRaw).filter(
    c => Number.isFinite(c.volume) && c.volume > 0
  );
  if (!withVol.length) {
    return { candlesVwap: [], vwapAnchor };
  }

  const refMs = withVol[withVol.length - 1].datetime;
  const refDay = getEtDateString(refMs);
  const { ethStartMs, capEndMs } = getEthDayBounds(refMs);
  candlesVwap = withVol.filter(c =>
    getEtDateString(c.datetime) === refDay &&
    c.datetime >= ethStartMs &&
    c.datetime <= capEndMs
  );
  if (quote && shouldPatchQuote(candlesVwap, quote, bucketMs)) {
    candlesVwap = applyLiveQuoteToCandles(candlesVwap, quote, bucketMs);
  }
  return { candlesVwap, vwapAnchor };
}

function isToppingTailBar(bar) {
  const range = bar.high - bar.low;
  if (range <= 0) return false;
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  return upperWick / range > TOPPING_TAIL_WICK_RATIO;
}

function isBottomingTailBar(bar) {
  const range = bar.high - bar.low;
  if (range <= 0) return false;
  const lowerWick = Math.min(bar.open, bar.close) - bar.low;
  return lowerWick / range > BOTTOMING_TAIL_WICK_RATIO;
}

function isDojiBar(bar) {
  const range = bar.high - bar.low;
  if (range <= 0) return false;
  const body = Math.abs(bar.close - bar.open);
  return body / range < DOJI_BODY_RATIO;
}

function isBullishBar(bar) {
  return bar && Number.isFinite(bar.close) && Number.isFinite(bar.open) && bar.close > bar.open;
}

function isBearishBar(bar) {
  return bar && Number.isFinite(bar.close) && Number.isFinite(bar.open) && bar.close < bar.open;
}

function priorBarsBefore(completedBars, bar, count) {
  const idx = completedBars.indexOf(bar);
  if (idx <= 0) return [];
  return completedBars.slice(Math.max(0, idx - count), idx);
}

function isDojiOnBullishRunBar(bar, completedBars) {
  if (!isDojiBar(bar)) return false;
  const prior = priorBarsBefore(completedBars, bar, DOJI_RUN_LOOKBACK);
  if (prior.length < DOJI_RUN_MIN_SAME_DIR) return false;
  const bullish = prior.filter(isBullishBar).length;
  return bullish >= DOJI_RUN_MIN_SAME_DIR;
}

function isDojiOnBearishRunBar(bar, completedBars) {
  if (!isDojiBar(bar)) return false;
  const prior = priorBarsBefore(completedBars, bar, DOJI_RUN_LOOKBACK);
  if (prior.length < DOJI_RUN_MIN_SAME_DIR) return false;
  const bearish = prior.filter(isBearishBar).length;
  return bearish >= DOJI_RUN_MIN_SAME_DIR;
}

function isHighVolumeBar(bar, completedBars, direction) {
  if (!bar) return false;
  if (direction === 'sell' && !isBearishBar(bar)) return false;
  if (direction === 'buy' && !isBullishBar(bar)) return false;
  const vol = bar.volume;
  if (!Number.isFinite(vol) || vol <= 0) return false;
  const idx = completedBars.indexOf(bar);
  if (idx < HIGH_VOL_PRIOR_BARS) return false;
  const prior = completedBars.slice(idx - HIGH_VOL_PRIOR_BARS, idx);
  const avg = prior.reduce((s, c) => s + (Number.isFinite(c.volume) ? c.volume : 0), 0) /
    HIGH_VOL_PRIOR_BARS;
  if (avg <= 0) return false;
  return vol >= avg * HIGH_VOL_RATIO;
}

function isHighVolumeSellBar(bar, completedBars) {
  return isHighVolumeBar(bar, completedBars, 'sell');
}

function isHighVolumeBuyBar(bar, completedBars) {
  return isHighVolumeBar(bar, completedBars, 'buy');
}

function barsInWarningWindow(completedBars, now = Date.now()) {
  const cutoff = now - WARNING_WINDOW_MS;
  return sortCandles(completedBars).filter(b => b?.datetime >= cutoff);
}

function findMostRecentWarningBar(completedBars, predicate, now = Date.now()) {
  const window = barsInWarningWindow(completedBars, now);
  for (let i = window.length - 1; i >= 0; i--) {
    if (predicate(window[i], completedBars)) return window[i];
  }
  return null;
}

function findAllWarningBarsInLookback(completedBars, predicate, now = Date.now()) {
  return barsInWarningWindow(completedBars, now).filter(bar => predicate(bar, completedBars));
}

function formatWarningBarTimes(barList, now = Date.now()) {
  const times = barsInWarningWindow(barList, now).map(b => formatEtHm(b.datetime));
  return times.join(', ');
}

function hasHighVolSellInLookback(completedBars, now = Date.now()) {
  return findMostRecentWarningBar(completedBars, isHighVolumeSellBar, now) != null;
}

function addTimedWarning(codes, bars, code, barList, now) {
  const label = formatWarningBarTimes(barList, now);
  if (!label) return;
  codes.push(code);
  bars[code] = label;
}

function barBodyRatio(bar) {
  if (!bar) return 0;
  const range = bar.high - bar.low;
  if (range <= 0) return 0;
  return Math.abs(bar.close - bar.open) / range;
}

function barBodySize(bar) {
  if (!bar) return 0;
  return Math.abs(bar.close - bar.open);
}

/** Trailing consecutive bullish 1m bars at end of series. */
function findTrailingBullishRun(bars, minLen = FRONT_SIDE_MIN_GREEN_BARS) {
  const sorted = sortCandles(bars);
  const run = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (isBullishBar(sorted[i])) run.unshift(sorted[i]);
    else break;
  }
  return run.length >= minLen ? run : null;
}

/** Longest consecutive green run in window (for structure after small pullbacks). */
function findLongestBullishRunInWindow(bars, minLen = FRONT_SIDE_MIN_GREEN_BARS) {
  const sorted = sortCandles(bars);
  let best = null;
  let i = 0;
  while (i < sorted.length) {
    if (!isBullishBar(sorted[i])) {
      i++;
      continue;
    }
    const run = [];
    while (i < sorted.length && isBullishBar(sorted[i])) {
      run.push(sorted[i]);
      i++;
    }
    if (run.length >= minLen && (!best || run.length > best.length)) best = run;
  }
  return best;
}

/**
 * Recent green run for front-side: skip up to 2 small bearish bars at the end, then
 * trailing greens; else longest green chain in the lookback window.
 */
function findRecentBullishRunForFrontSide(bars) {
  const sorted = sortCandles(bars);
  let end = sorted.length;
  let skipped = 0;
  while (end > 0 && skipped < 2) {
    const b = sorted[end - 1];
    if (isBearishBar(b) && barBodyRatio(b) < FRONT_SIDE_SMALL_BODY_RATIO) {
      end--;
      skipped++;
    } else {
      break;
    }
  }
  const trailing = findTrailingBullishRun(sorted.slice(0, end));
  if (trailing) return trailing;
  return findLongestBullishRunInWindow(sorted);
}

/** Green chain ending at last completed bar (forming bearish excluded). */
function findTrailingBullishRunCompleted(completedBars) {
  return findTrailingBullishRun(completedBars, GIVEBACK_MIN_GREEN_BARS);
}

function hasTwoConsecutiveLowerLows(bars, lookback = 4) {
  const recent = sortCandles(bars).slice(-lookback);
  if (recent.length < 3) return false;
  let streak = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].low < recent[i - 1].low) {
      streak++;
      if (streak >= 2) return true;
    } else {
      streak = 0;
    }
  }
  return false;
}

function hasLowerHighs(bars, count = 3) {
  const recent = sortCandles(bars).slice(-count);
  if (recent.length < 3) return false;
  let steps = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].high < recent[i - 1].high) steps++;
  }
  return steps >= 2;
}

function avgBullishBodySize(run) {
  const bodies = run.filter(isBullishBar).map(barBodySize).filter(s => s > 0);
  if (!bodies.length) return 0;
  return bodies.reduce((a, b) => a + b, 0) / bodies.length;
}

/**
 * Row 2 — buy-side structure: front side vs consolidation vs backside (not HH ladder).
 */
function computeFrontSideSignal(candles1m, price, ema9, ema20) {
  const bars = sortCandles(candles1m).slice(-FRONT_SIDE_LOOKBACK_BARS);
  const fail = (phase, reason) => ({
    state: 'red', phase, reason
  });
  const warn = (phase, reason) => ({
    state: 'yellow', phase, reason
  });
  const ok = (phase, reason) => ({
    state: 'green', phase, reason
  });

  if (bars.length < 2) {
    return fail('insufficient_bars', 'Need more 1m bars');
  }

  const run = findRecentBullishRunForFrontSide(bars);
  if (!run) {
    return fail('no_impulse', 'No recent buy-side run');
  }

  if (Number.isFinite(ema9) && price < ema9) {
    return fail('below_ema9', 'Below 9 EMA — structure lost');
  }

  if (hasTwoConsecutiveLowerLows(bars)) {
    return fail('backside_ll', 'Two consecutive lower lows');
  }

  const runHigh = Math.max(...run.map(b => b.high));
  const runLow = Math.min(...run.map(b => b.low));
  const runRange = runHigh - runLow;
  const avgBullBody = avgBullishBodySize(run);

  const completed = bars.length > 1 ? bars.slice(0, -1) : bars;
  const lastCompleted = completed.length ? completed[completed.length - 1] : null;
  if (lastCompleted && isBearishBar(lastCompleted) && avgBullBody > 0) {
    const lastBody = barBodySize(lastCompleted);
    if (lastBody >= avgBullBody * FRONT_SIDE_REVERSAL_BODY_RATIO) {
      return fail('reversal_bar', 'Large bearish bar after run');
    }
  }

  if (Number.isFinite(runLow) && price < runLow) {
    return fail('below_run_low', 'Price below green-run low');
  }

  const holdFloor = runRange > 0
    ? runLow + runRange * FRONT_SIDE_MIN_HOLD_PCT
    : runLow;
  const lastTwo = bars.slice(-2);
  const recentBearish = lastTwo.filter(isBearishBar);
  const smallConsolidation = recentBearish.length > 0 &&
    recentBearish.every(b => barBodyRatio(b) < FRONT_SIDE_SMALL_BODY_RATIO);

  if (runRange > 0 && price >= holdFloor && smallConsolidation) {
    return ok('consolidating', 'Small pullback — still on front side');
  }

  if (run.length >= 3 && runRange > 0 &&
      price >= runHigh - runRange * FRONT_SIDE_NEAR_PEAK_PCT) {
    return ok('trending', 'Front-side run near highs');
  }

  if (isBullishBar(bars[bars.length - 1]) && price >= holdFloor) {
    return ok('front_side', 'Buy-side run intact');
  }

  if (hasLowerHighs(bars) && Number.isFinite(ema9) && price >= ema9) {
    return warn('weakening', 'Lower highs — watch for backside');
  }

  const last5 = bars.slice(-5);
  const bulls = last5.filter(isBullishBar).length;
  const bears = last5.filter(isBearishBar).length;
  if (bulls < 2 && bears >= 2) {
    return warn('choppy', 'Choppy — no clear buy-side control');
  }

  if (price >= holdFloor) {
    return warn('weakening', 'Pullback — still above run floor');
  }

  return fail('backside', 'Backside / lost front-side structure');
}

/**
 * Row 2 — giveback from trailing green chain vs live price.
 */
function computeGivebackSignal(completedBars, price) {
  const base = {
    move_size: null,
    pullback: null,
    pct: null
  };
  const run = findTrailingBullishRunCompleted(completedBars);
  if (!run) {
    return {
      ...base,
      state: 'green',
      phase: 'no_run',
      reason: 'No recent green run'
    };
  }

  const moveHigh = Math.max(...run.map(b => b.high).filter(Number.isFinite));
  const moveLow = Math.min(...run.map(b => b.low).filter(Number.isFinite));
  const moveSize = moveHigh - moveLow;
  const pullback = moveHigh - price;
  const pct = moveSize > 0 ? pullback / moveSize : 0;

  base.move_size = round2(moveSize);
  base.pullback = round2(Math.max(0, pullback));
  base.pct = round2(pct * 100);

  if (moveSize < GIVEBACK_MOVE_MIN_USD) {
    return {
      ...base,
      state: 'green',
      phase: 'move_too_small',
      reason: 'Green run too small to score giveback'
    };
  }

  if (pct > GIVEBACK_FAIL_RATIO) {
    return {
      ...base,
      state: 'red',
      phase: 'deep_giveback',
      reason: `Gave back ${(pct * 100).toFixed(0)}% of green run (>${(GIVEBACK_FAIL_RATIO * 100).toFixed(0)}%)`
    };
  }
  if (pct >= GIVEBACK_WARN_RATIO) {
    return {
      ...base,
      state: 'yellow',
      phase: 'moderate_giveback',
      reason: `Gave back ${(pct * 100).toFixed(0)}% of green run (${(GIVEBACK_WARN_RATIO * 100).toFixed(0)}–${(GIVEBACK_FAIL_RATIO * 100).toFixed(0)}%)`
    };
  }
  return {
    ...base,
    state: 'green',
    phase: 'shallow_pullback',
    reason: `Pullback ${(pct * 100).toFixed(0)}% of green run (<${(GIVEBACK_WARN_RATIO * 100).toFixed(0)}%)`
  };
}

function computeWarnings(candles1m, completed1m, now = Date.now()) {
  const codes = [];
  const bars = {};
  if (candles1m.length < 4) return { codes, bars };

  const bar = candles1m[candles1m.length - 2];

  addTimedWarning(codes, bars, 'topping_tail',
    findAllWarningBarsInLookback(completed1m, isToppingTailBar, now), now);
  addTimedWarning(codes, bars, 'bottoming_tail',
    findAllWarningBarsInLookback(completed1m, isBottomingTailBar, now), now);
  addTimedWarning(codes, bars, 'doji_bull_run',
    findAllWarningBarsInLookback(completed1m, isDojiOnBullishRunBar, now), now);
  addTimedWarning(codes, bars, 'doji_bear_run',
    findAllWarningBarsInLookback(completed1m, isDojiOnBearishRunBar, now), now);

  const hvSellBars = findAllWarningBarsInLookback(completed1m, isHighVolumeSellBar, now);
  if (hvSellBars.length) {
    bars.high_volume_sell = formatWarningBarTimes(hvSellBars, now);
  }

  addTimedWarning(codes, bars, 'high_volume_buy',
    findAllWarningBarsInLookback(completed1m, isHighVolumeBuyBar, now), now);

  const last3 = candles1m.slice(-4, -1);
  if (last3.length === 3) {
    const bodies = last3.map(c => Math.abs(c.close - c.open));
    const heights = last3.map(c => c.high - c.low);
    const bodiesShrinking = bodies[0] > bodies[1] && bodies[1] > bodies[2];
    const heightsShrinking = heights[0] > heights[1] && heights[1] > heights[2];
    const shrinking = bodiesShrinking || heightsShrinking;
    if (last3.every(isBullishBar) && shrinking) {
      codes.push('momentum_exhaustion_up');
    }
    if (last3.every(isBearishBar) && shrinking) {
      codes.push('momentum_exhaustion_down');
    }
  }

  const prior10 = candles1m.slice(-12, -2);
  if (prior10.length >= 10) {
    const prior10Avg = prior10.reduce((s, c) => s + c.volume, 0) / prior10.length;
    if (Number.isFinite(bar.volume) && bar.volume < prior10Avg * TAPE_SLOW_RATIO) {
      const runPrior = priorBarsBefore(completed1m, bar, DOJI_RUN_LOOKBACK);
      if (runPrior.filter(isBullishBar).length >= DOJI_RUN_MIN_SAME_DIR) {
        codes.push('tape_slowdown_bull_run');
      }
      if (runPrior.filter(isBearishBar).length >= DOJI_RUN_MIN_SAME_DIR) {
        codes.push('tape_slowdown_bear_run');
      }
    }
  }

  const completedCloses = completed1m.map(c => c.close);
  const ema9_1m = lastFinite(calcExpAverageTOS(completedCloses, 9));
  const ema20_1m = lastFinite(calcExpAverageTOS(completedCloses, 20));
  if (Number.isFinite(ema9_1m) && bar.close < ema9_1m) {
    codes.push('lost_9_ema');
  }
  if (Number.isFinite(ema20_1m) && bar.close < ema20_1m) {
    codes.push('lost_20_ema');
  }
  if (Number.isFinite(ema9_1m) && bar.close > ema9_1m) {
    codes.push('above_9_ema');
  }
  if (Number.isFinite(ema20_1m) && bar.close > ema20_1m) {
    codes.push('above_20_ema');
  }

  return { codes, bars };
}

function barTestsResistance(bar, level) {
  if (!bar || !Number.isFinite(bar.high) || !Number.isFinite(level)) return false;
  return bar.high >= level - LEVEL_TEST_BAND_USD &&
    bar.high <= level + LEVEL_TEST_BAND_USD;
}

function barTestsSupport(bar, level) {
  if (!bar || !Number.isFinite(bar.low) || !Number.isFinite(level)) return false;
  return bar.low <= level + LEVEL_TEST_BAND_USD &&
    bar.low >= level - LEVEL_TEST_BAND_USD;
}

function crossedAboveRecently(completedBars, level) {
  const n = completedBars.length;
  for (let i = Math.max(1, n - LEVEL_BREAK_LOOKBACK_BARS); i < n; i++) {
    const prev = completedBars[i - 1].close;
    const cur = completedBars[i].close;
    if (Number.isFinite(prev) && Number.isFinite(cur) && prev <= level && cur > level) {
      return true;
    }
  }
  return false;
}

function crossedBelowRecently(completedBars, level) {
  const n = completedBars.length;
  for (let i = Math.max(1, n - LEVEL_BREAK_LOOKBACK_BARS); i < n; i++) {
    const prev = completedBars[i - 1].close;
    const cur = completedBars[i].close;
    if (Number.isFinite(prev) && Number.isFinite(cur) && prev >= level && cur < level) {
      return true;
    }
  }
  return false;
}

function computeResistanceSignal(price, keyUp, completedBars, formingBar) {
  if (!keyUp?.price || !Number.isFinite(keyUp.price)) {
    return {
      state: 'green',
      phase: 'no_resistance_above',
      reason: 'No resistance above price',
      level_price: null,
      level_label: null,
      distance: null
    };
  }
  const level = keyUp.price;
  const label = keyUp.kind_label || 'Resistance';
  const distBelow = level - price;
  const last = completedBars.length ? completedBars[completedBars.length - 1] : null;

  if (crossedAboveRecently(completedBars, level) && price > level + LEVEL_BREAK_USD) {
    return {
      state: 'green',
      phase: 'broke_through',
      reason: `Broke · $${level.toFixed(2)}`,
      level_price: round2(level),
      level_label: label,
      distance: round2(price - level)
    };
  }
  if (distBelow > LEVEL_NEAR_BAND_USD) {
    return {
      state: 'green',
      phase: 'clear',
      reason: `Clear · $${level.toFixed(2)} ($${distBelow.toFixed(2)} below)`,
      level_price: round2(level),
      level_label: label,
      distance: round2(distBelow)
    };
  }

  const inTestBand = distBelow >= 0 && distBelow <= LEVEL_TEST_BAND_USD;
  const testing = inTestBand &&
    (barTestsResistance(formingBar, level) || barTestsResistance(last, level));

  if (testing && last && Number.isFinite(last.close) && last.close < level) {
    return {
      state: 'red',
      phase: 'reject',
      reason: `Rejected · $${level.toFixed(2)} (close below)`,
      level_price: round2(level),
      level_label: label,
      distance: round2(distBelow)
    };
  }
  if (testing) {
    return {
      state: 'yellow',
      phase: 'testing',
      reason: `Testing · $${level.toFixed(2)}`,
      level_price: round2(level),
      level_label: label,
      distance: round2(distBelow)
    };
  }
  const approaching = distBelow > LEVEL_TEST_BAND_USD && distBelow <= LEVEL_NEAR_BAND_USD;
  if (approaching) {
    return {
      state: 'yellow',
      phase: 'approach',
      reason: `Approaching · $${level.toFixed(2)} ($${distBelow.toFixed(2)} away)`,
      level_price: round2(level),
      level_label: label,
      distance: round2(distBelow)
    };
  }
  if (price > level) {
    return {
      state: 'yellow',
      phase: 'testing',
      reason: `Above · $${level.toFixed(2)} (watch hold)`,
      level_price: round2(level),
      level_label: label,
      distance: round2(price - level)
    };
  }
  return {
    state: 'green',
    phase: 'clear',
    reason: `Clear · $${level.toFixed(2)}`,
    level_price: round2(level),
    level_label: label,
    distance: round2(distBelow)
  };
}

function computeSupportSignal(price, keyDown, completedBars, formingBar) {
  if (!keyDown?.price || !Number.isFinite(keyDown.price)) {
    return {
      state: 'yellow',
      phase: 'no_support_below',
      reason: 'No support mapped below',
      level_price: null,
      level_label: null,
      distance: null
    };
  }
  const level = keyDown.price;
  const label = keyDown.kind_label || 'Support';
  const distAbove = price - level;
  const last = completedBars.length ? completedBars[completedBars.length - 1] : null;

  if (price < level - LEVEL_BREAK_USD ||
      (crossedBelowRecently(completedBars, level) && price < level)) {
    return {
      state: 'red',
      phase: 'broken',
      reason: `Support broken · $${level.toFixed(2)}`,
      level_price: round2(level),
      level_label: label,
      distance: round2(distAbove)
    };
  }

  const inTestBand = distAbove >= 0 && distAbove <= LEVEL_TEST_BAND_USD;
  const testing = inTestBand &&
    (barTestsSupport(formingBar, level) || barTestsSupport(last, level));
  const nearSupport = distAbove >= 0 && distAbove <= LEVEL_NEAR_BAND_USD;

  if (testing) {
    return {
      state: 'yellow',
      phase: 'testing',
      reason: `Testing support · $${level.toFixed(2)}`,
      level_price: round2(level),
      level_label: label,
      distance: round2(distAbove)
    };
  }
  if (nearSupport) {
    return {
      state: 'green',
      phase: 'near',
      reason: `Near support · $${level.toFixed(2)} ($${distAbove.toFixed(2)} above)`,
      level_price: round2(level),
      level_label: label,
      distance: round2(distAbove)
    };
  }
  return {
    state: 'yellow',
    phase: 'far',
    reason: `Far from support · $${level.toFixed(2)} ($${distAbove.toFixed(2)} above)`,
    level_price: round2(level),
    level_label: label,
    distance: round2(distAbove)
  };
}

function formatLevelWarningDetail(sig) {
  if (!sig?.level_price || !Number.isFinite(sig.level_price)) return '';
  const label = sig.level_label ? ` · ${sig.level_label}` : '';
  return `$${sig.level_price.toFixed(2)}${label}`;
}

/** KEY LVL ↑/↓ signals → bearish/bullish warning rows. */
function mergeLevelWarnings(warningResult, levelSignals) {
  const r = levelSignals?.resistance;
  const s = levelSignals?.support;

  if (r?.phase === 'reject') {
    warningResult.codes.push('failed_resistance_breakout');
    warningResult.bars.failed_resistance_breakout = formatLevelWarningDetail(r);
  }
  if (r?.phase === 'broke_through') {
    warningResult.codes.push('resistance_breakout');
    warningResult.bars.resistance_breakout = formatLevelWarningDetail(r);
  }
  if (s?.phase === 'broken') {
    warningResult.codes.push('failed_support_hold');
    warningResult.bars.failed_support_hold = formatLevelWarningDetail(s);
  } else if (s?.phase === 'near' || s?.phase === 'testing') {
    warningResult.codes.push('held_support');
    warningResult.bars.held_support = formatLevelWarningDetail(s);
  }
  return warningResult;
}

function row1AllGreen(frontSide) {
  return frontSide && Object.values(frontSide).every(Boolean);
}

function row2AllGreen(levelSignals, momentum, giveback) {
  const r = levelSignals?.resistance;
  const s = levelSignals?.support;
  const resOk = r?.state === 'green' &&
    ['clear', 'broke_through', 'no_resistance_above'].includes(r.phase);
  const supOk = s?.state === 'green' && s.phase === 'near';
  const frontOk = momentum?.front_side?.state === 'green';
  const gbOk = giveback?.state === 'green';
  return resOk && supOk && frontOk && gbOk;
}

function trafficBanner(frontSide, levelSignals, momentum, giveback) {
  if (!row1AllGreen(frontSide)) return 'NO_ENTRY';
  if (row2AllGreen(levelSignals, momentum, giveback)) return 'LOOK_FOR_SETUP';
  return 'CAUTION';
}

function updateTrafficLightConfirmed(symbol, raw) {
  let entry = stateCache[symbol];
  if (!entry || entry.confirmed == null) {
    stateCache[symbol] = { confirmed: raw, pending: null, pending_count: 0 };
    return raw;
  }

  const { confirmed } = entry;
  if (raw === confirmed) {
    entry.pending = null;
    entry.pending_count = 0;
    return confirmed;
  }

  if (raw === entry.pending) {
    entry.pending_count += 1;
    if (entry.pending_count >= 2) {
      entry.confirmed = entry.pending;
      entry.pending = null;
      entry.pending_count = 0;
      return entry.confirmed;
    }
    return confirmed;
  }

  entry.pending = raw;
  entry.pending_count = 1;
  return confirmed;
}

function keyLevelHintLines(title, price, chosen, alts, extra) {
  const lines = [
    title,
    'Sources: multi-touch clusters ($0.05), 9 EMA, VWAP, pivots, session HOD/LOD, half/whole $.',
    'Labels: Whole/Half Dollar, Pivot (2+ open/close at reversal), HOD/LOD, Premarket High/Low.',
    'Resistance prefers multi-touch clusters; single-wick HOD is deprioritized.'
  ];
  if (chosen) {
    const touchNote = chosen.touches != null ? ` · ${chosen.touches} bar tests` : '';
    lines.push(`Selected: $${chosen.price.toFixed(2)} (${chosen.kind_label}${touchNote})`);
    lines.push(`Distance: $${(chosen.price - price).toFixed(2)}`);
  } else {
    lines.push('No level found in range.');
  }
  if (extra?.session_hod) {
    const h = extra.session_hod;
    const ht = h.touches != null ? `${h.touches} test(s)` : '—';
    lines.push(`Session HOD: $${h.price.toFixed(2)} (${ht}) — ceiling wick; shown separately when not the primary level.`);
  }
  if (alts?.length > 1) {
    lines.push('Also considered:');
    alts.slice(1, 5).forEach(c => lines.push(`  $${c.price.toFixed(2)} (${c.kind_label})`));
  }
  return lines;
}

function buildCalcHints({
  price, prevClose, vwap, vwapAnchor, vwapPack,
  ema9_1m_value, ema20_1m_value, macd_histogram_value,
  completed1m, candles1m, forming1m, recent4, recent4High, momentum, giveback,
  rvolDaily, todayVol, avg14Vol, front_side, macdBarCount,
  keyLevels, level_signals, quote, now = Date.now()
}) {
  const nl = lines => lines.join('\n');
  const spread = quoteBidAskSpread(quote);
  const barLine = c => `${formatEtHm(c.datetime)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)} V=${c.volume}`;

  const fs = momentum?.front_side;
  const momLines = [
    'Row 2 — Front side: buy-side structure (not HH ladder).',
    'GREEN: run intact, small white candles OK, above 9 EMA.',
    'RED: below 9 EMA, reversal bar, backside lower lows, or below run low.',
    fs?.reason ? `→ ${fs.state?.toUpperCase()} (${fs.phase}): ${fs.reason}` : '→ —'
  ];
  const momBars = sortCandles(candles1m || []).slice(-FRONT_SIDE_LOOKBACK_BARS);
  const run = findRecentBullishRunForFrontSide(momBars);
  if (run?.length) {
    momLines.push(`Green run (${run.length} bars):`);
    run.forEach(c => momLines.push(`  ${barLine(c)}`));
    if (Number.isFinite(ema9_1m_value)) {
      momLines.push(`Price $${price.toFixed(2)} vs 9 EMA $${ema9_1m_value.toFixed(2)}`);
    }
  }

  const gbLines = [
    'Row 2 — Giveback: pullback from green-chain high vs chain range.',
    `Yellow ${(GIVEBACK_WARN_RATIO * 100).toFixed(0)}–${(GIVEBACK_FAIL_RATIO * 100).toFixed(0)}%, red >${(GIVEBACK_FAIL_RATIO * 100).toFixed(0)}%.`
  ];
  if (giveback?.reason) {
    gbLines.push(giveback.reason);
    if (giveback.move_size != null) {
      gbLines.push(
        `Move $${giveback.move_size.toFixed(2)} · Pullback $${giveback.pullback?.toFixed(2) ?? '—'} · ${giveback.pct ?? '—'}%`
      );
    }
    gbLines.push(`→ ${giveback.state?.toUpperCase()} (${giveback.phase})`);
  }

  return {
    price: nl([
      'Schwab quote lastPrice.',
      `Last: $${price.toFixed(2)}`,
      'Color: green $2–$20, yellow $1–$1.99, red otherwise.'
    ]),
    day_change_pct: nl([
      '((lastPrice - previousClose) / previousClose) × 100',
      `($${price.toFixed(2)} - $${prevClose.toFixed(2)}) / $${prevClose.toFixed(2)}`,
      'Green if > 10%.'
    ]),
    vwap_delta: nl([
      `VWAP anchor: ${vwapAnchor} (${vwapPack?.tag ?? '—'})`,
      vwap != null ? `Session VWAP: $${vwap.toFixed(2)}` : 'VWAP unavailable (no volume in window)',
      vwap != null ? `Delta: lastPrice - VWAP. Green if price > VWAP.` : '',
      vwap != null ? `Price $${price.toFixed(2)} vs VWAP $${vwap.toFixed(2)}` : ''
    ]),
    rvol_daily: nl([
      `Daily RVOL = today's cumulative volume ÷ avg of prior ${DAILY_RVOL_LOOKBACK} session daily volumes.`,
      `Today vol (sum of 1m bars, ET date ${getEtDateString(now)}): ${todayVol != null ? Math.round(todayVol).toLocaleString() : '—'}`,
      avg14Vol != null ? `Avg prior ${DAILY_RVOL_LOOKBACK} days: ${Math.round(avg14Vol).toLocaleString()}` : `Need ${DAILY_RVOL_LOOKBACK} prior daily bars from Schwab.`,
      rvolDaily != null ? `RVOL = ${rvolDaily.toFixed(2)}x. Green if ≥ 5x.` : 'RVOL unavailable.'
    ]),
    ema9_1m: nl([
      '9 EMA (1m) — TOS ExpAverage, today 4AM ET session only (matches TOS active day).',
      `Value: $${ema9_1m_value?.toFixed(2) ?? '—'} on ${macdBarCount ?? '—'} bars (includes forming).`,
      `Compare to 20 EMA: ${ema9_1m_value > ema20_1m_value ? '9 > 20 (green)' : '9 ≤ 20 (red)'}.`
    ]),
    ema20_1m: nl([
      '20 EMA (1m) — TOS ExpAverage, same today-session series as 9 EMA.',
      `Value: $${ema20_1m_value?.toFixed(2) ?? '—'}.`
    ]),
    macd_histogram: nl([
      'MACD (12, 26, 9) — TOS ExpAverage on today 4AM–now ETH 1m bars (includes forming bar).',
      `Series: ${macdBarCount ?? '—'} bars (full session; gap trim not applied to MACD).`,
      `Histogram: ${macd_histogram_value}`,
      'Green if > 0. Compare to TOS MACD (0,0,DAY) on the 1m chart with extended hours.'
    ]),
    session: nl([
      'ET session: Pre-Market 4:00–9:30, Market Open 9:30–4:00, After Hours 4:00–8:00, else Closed.',
      'Colors: Pre-Market gold, Market Open green, After Hours blue, Closed red.'
    ]),
    key_level_up: nl(keyLevelHintLines(
      'Next resistance above price',
      price,
      keyLevels?.key_level_up,
      keyLevels?.key_level_candidates_up,
      { session_hod: keyLevels?.key_level_session_hod }
    )),
    key_level_down: nl(keyLevelHintLines(
      'Next support below price',
      price,
      keyLevels?.key_level_down,
      keyLevels?.key_level_candidates_down
    )),
    dots: {
      emas: nl([
        'GO check: 9 EMA > 20 EMA (1m).',
        `9 EMA $${ema9_1m_value?.toFixed(2) ?? '—'} vs 20 EMA $${ema20_1m_value?.toFixed(2) ?? '—'}`,
        `→ ${front_side.emas ? 'GREEN' : 'RED'}`
      ]),
      macd: nl([
        'GO check: MACD histogram > 0.',
        `Histogram = ${macd_histogram_value}`,
        `→ ${front_side.macd ? 'GREEN' : 'RED'}`
      ]),
      vwap: nl([
        'GO check: lastPrice > session VWAP.',
        vwap != null ? `Price $${price.toFixed(2)} vs VWAP $${vwap.toFixed(2)}` : 'No VWAP',
        `→ ${front_side.vwap ? 'GREEN' : 'RED'}`
      ]),
      no_hv_sell: nl([
        `GO check: no high-volume sell order in last 8 minutes of 1m bars.`,
        `Bearish bar with volume ≥ 2× prior ${HIGH_VOL_PRIOR_BARS}-bar avg = HV sell (see warnings).`,
        `→ ${front_side.no_hv_sell ? 'GREEN' : 'RED (HV sell in window)'}`
      ]),
      spread_ok: nl([
        `GO check: ask − bid ≤ $${MAX_BID_ASK_SPREAD_USD.toFixed(2)} (Schwab quote).`,
        spread != null
          ? `Bid $${(quote.bidPrice ?? quote.bid)?.toFixed(2) ?? '—'} · Ask $${(quote.askPrice ?? quote.ask)?.toFixed(2) ?? '—'} · Spread $${spread.toFixed(2)}`
          : 'Bid/ask not available on quote',
        `→ ${front_side.spread_ok ? 'GREEN' : 'RED'}`
      ])
    },
    momentum: nl(momLines),
    giveback: nl(gbLines),
    level_resistance: level_signals?.resistance
      ? nl([
          'Row 2 — resistance. Testing within 3¢ at level; approach 3–10¢.',
          level_signals.resistance.reason,
          `Phase: ${level_signals.resistance.phase} · state: ${level_signals.resistance.state}`
        ])
      : '',
    level_support: level_signals?.support
      ? nl([
          'Row 2 — support. Testing within 3¢ at level; near green 0–10¢ above.',
          level_signals.support.reason,
          `Phase: ${level_signals.support.phase} · state: ${level_signals.support.state}`
        ])
      : ''
  };
}

function computeStateFromCache(symbol) {
  const cache = marketDataCache[symbol];
  if (!cache) {
    return { status: 'insufficient_data', missing: ['initializing'] };
  }

  const { quote, candles1m: candles1mRaw, candles1mMacd, dailyCandles, quoteFetched } = cache;
  if (quoteFetched && !isQuoteValid(quote)) {
    return {
      status: 'invalid_symbol',
      symbol,
      suggestion: TICKER_SUGGESTIONS[symbol] || null
    };
  }
  if (!quote || !candles1mRaw) {
    const missing = [];
    if (!quote) missing.push('quote');
    if (!candles1mRaw?.length) missing.push('1m_candles');
    return { status: 'insufficient_data', missing };
  }

  const now = Date.now();
  const sources = [candles1mMacd, candles1mRaw];
  const session1m = buildSession1mBars(sources, quote, now);
  const indicator1m = buildIndicator1mBars(sources, quote, now);
  const candles1mLive = session1m;
  const closesInd = getIndicatorCloses(indicator1m);

  if (session1m.length < MACD_MIN_BARS || closesInd.length < MACD_MIN_BARS) {
    console.warn(
      `[${symbol}] session=${session1m.length} indicator=${indicator1m.length} closes=${closesInd.length} raw=${candles1mRaw?.length ?? 0}`
    );
  }

  const pmCfg = getVwapConfig(now);
  const vwapCfg = vwapCfgForSessionBars(session1m, pmCfg, now);
  let { vwapPack, vwapAnchor } = resolveVwapPackFrom1m(session1m, vwapCfg, now);

  const missing = [];
  if (!quote?.lastPrice || !Number.isFinite(quote.lastPrice) ||
      !quote?.closePrice || !Number.isFinite(quote.closePrice)) {
    missing.push('quote');
  }

  if (session1m.length < SESSION_MIN_BARS) missing.push('1m_candles');
  const macdFloor = closesInd.length >= MACD_MIN_BARS ? MACD_MIN_BARS : MACD_MIN_BARS_SPARSE;
  if (closesInd.length < macdFloor) missing.push('1m_candles');

  const insufficientDetail = {
    session_bars: session1m.length,
    indicator_bars: indicator1m.length,
    raw_bars: candles1mRaw?.length ?? 0,
    required_session_bars: SESSION_MIN_BARS,
    required_indicator_bars: MACD_MIN_BARS
  };

  const { candlesVwap, vwapAnchor: resolvedVwapAnchor } = resolveVwapCandlesForCompute(
    session1m, quote, pmCfg, vwapPack, vwapAnchor
  );
  vwapAnchor = resolvedVwapAnchor;

  if (missing.length) {
    return { status: 'insufficient_data', missing, detail: insufficientDetail };
  }

  const price = quote.lastPrice;
  const prevClose = quote.closePrice;
  const vwap = calcVWAP(candlesVwap);

  const completedInd = getCompleted1mBars(session1m);
  const ema9_1m_value = lastFinite(calcExpAverageTOS(closesInd, 9));
  const ema20_1m_value = lastFinite(calcExpAverageTOS(closesInd, 20));
  const front_side_emas = Number.isFinite(ema9_1m_value) && Number.isFinite(ema20_1m_value) &&
    ema9_1m_value > ema20_1m_value;

  const { histogram } = calcMACDExactTOS(closesInd);
  const macd_histogram_value = lastFinite(histogram);
  if (!Number.isFinite(macd_histogram_value)) {
    return {
      status: 'insufficient_data',
      missing: ['1m_candles'],
      detail: insufficientDetail
    };
  }
  const front_side_macd = macd_histogram_value > 0;
  const front_side_vwap = vwap != null && price > vwap;

  const completed1m = getCompleted1mBars(candles1mLive);
  let forming1m = null;
  let recent4 = [];
  let recent4High = -Infinity;
  if (candles1mLive.length >= 1) {
    forming1m = candles1mLive[candles1mLive.length - 1];
    if (completed1m.length >= 4) {
      recent4 = completed1m.slice(-4);
      recent4High = Math.max(...recent4.map(c => c.high));
    }
  }

  const no_hv_sell = !hasHighVolSellInLookback(completed1m, now);
  const spread = quoteBidAskSpread(quote);
  const spread_ok = isSpreadAcceptable(quote);
  const front_side = {
    emas: front_side_emas,
    macd: front_side_macd,
    vwap: front_side_vwap,
    no_hv_sell,
    spread_ok
  };
  const front_side_signal = computeFrontSideSignal(
    indicator1m, price, ema9_1m_value, ema20_1m_value
  );
  const momentum = { front_side: front_side_signal };
  const giveback = computeGivebackSignal(completedInd, price);
  const warningResult = computeWarnings(candles1mLive, completedInd, now);

  const rvolResult = calcDailyRvol14(session1m, dailyCandles, now);
  const rvol_daily = rvolResult.rvol;

  const vwapDeltaDollars = vwap != null ? price - vwap : 0;
  const vwapDeltaPct = vwap != null && vwap > 0 ? ((price - vwap) / vwap) * 100 : 0;

  const keyLevels = calcKeyLevels(session1m, dailyCandles, price, prevClose, ema9_1m_value, vwap, now);
  const level_signals = {
    resistance: computeResistanceSignal(
      price, keyLevels.key_level_up, completed1m, forming1m
    ),
    support: computeSupportSignal(
      price, keyLevels.key_level_down, completed1m, forming1m
    )
  };
  mergeLevelWarnings(warningResult, level_signals);
  const tradingStatus = computeTradingStatus(symbol, quote, now);
  const minutePulse = minuteClosePulseFromBars(completed1m);

  const calc_hints = buildCalcHints({
    price, prevClose, vwap, vwapAnchor, vwapPack,
    ema9_1m_value, ema20_1m_value, macd_histogram_value,
    completed1m: completedInd, candles1m: indicator1m, forming1m, recent4, recent4High, momentum,
    giveback,
    rvolDaily: rvol_daily,
    todayVol: rvolResult.todayVol,
    avg14Vol: rvolResult.avg14,
    front_side,
    macdBarCount: session1m.length,
    keyLevels,
    level_signals,
    quote,
    now
  });

  return {
    status: 'ok',
    symbol,
    traffic_light_raw: trafficBanner(front_side, level_signals, momentum, giveback),
    front_side,
    momentum,
    giveback,
    level_signals,
    warnings: warningResult.codes,
    warning_bars: warningResult.bars,
    context: {
      price: round2(price),
      day_change_pct: round2(((price - prevClose) / prevClose) * 100),
      vwap_value: vwap != null ? round2(vwap) : null,
      vwap_delta_dollars: vwap != null ? round2(vwapDeltaDollars) : null,
      vwap_delta_pct: vwap != null ? round2(vwapDeltaPct) : null,
      vwap_anchor: vwapAnchor,
      bid_ask_spread: spread != null ? round2(spread) : null,
      spread_max_usd: MAX_BID_ASK_SPREAD_USD,
      ema9_1m_value: round2(ema9_1m_value),
      ema20_1m_value: round2(ema20_1m_value),
      macd_histogram_value,
      rvol_daily: rvol_daily != null ? round2(rvol_daily) : null,
      key_level_up: keyLevels.key_level_up,
      key_level_down: keyLevels.key_level_down,
      key_level_session_hod: keyLevels.key_level_session_hod,
      time_et: formatTimeEtIso(now),
      market_session: contextMarketSession(now),
      trading_status: tradingStatus,
      last_completed_1m_key: minutePulse.last_completed_1m_key,
      minute_close_direction: minutePulse.minute_close_direction,
      last_completed_1m_close: Number.isFinite(minutePulse.last_completed_1m_close)
        ? round2(minutePulse.last_completed_1m_close) : null,
      prev_completed_1m_close: Number.isFinite(minutePulse.prev_completed_1m_close)
        ? round2(minutePulse.prev_completed_1m_close) : null,
      last_completed_1m_et_hm: minutePulse.last_completed_1m_et_hm,
      calc_hints
    }
  };
}

function cacheRefreshError(symbol, err) {
  if (err instanceof SchwabError) {
    if (err.code === 'auth_failed') {
      responseCache[symbol] = { status: 'auth_failed' };
      return;
    }
    if (err.code === 'rate_limited') {
      responseCache[symbol] = { status: 'rate_limited' };
      return;
    }
  }
  const detail = err.status ? `${err.message} (${err.status})` : err.message;
  console.error(`Refresh error (${symbol}):`, detail);
}

function recomputeAndCacheState(symbol) {
  if (symbol !== activeSymbol) return;
  try {
    const state = computeStateFromCache(symbol);
    if (state.status === 'insufficient_data' || state.status === 'invalid_symbol') {
      responseCache[symbol] = state;
      return;
    }
    if (state.status === 'ok') {
      const confirmed = updateTrafficLightConfirmed(symbol, state.traffic_light_raw);
      responseCache[symbol] = { ...state, traffic_light_confirmed: confirmed };
    }
  } catch (err) {
    cacheRefreshError(symbol, err);
  }
}

async function refreshQuote(symbol) {
  if (symbol !== activeSymbol) return;
  if (refreshInFlight.quote) return;
  refreshInFlight.quote = true;
  try {
    if (!(await ensureSchwabAuth())) return;
    const quote = await getQuote(symbol);
    if (symbol !== activeSymbol) return;
    if (!marketDataCache[symbol]) marketDataCache[symbol] = {};
    marketDataCache[symbol].quoteFetched = true;
    marketDataCache[symbol].quote = isQuoteValid(quote) ? quote : null;
    recomputeAndCacheState(symbol);
  } catch (err) {
    cacheRefreshError(symbol, err);
  } finally {
    refreshInFlight.quote = false;
  }
}

async function refreshCandles(symbol) {
  if (symbol !== activeSymbol) return;
  if (refreshInFlight.candles) return;
  refreshInFlight.candles = true;
  try {
    if (!(await ensureSchwabAuth())) return;
    const entry = marketDataCache[symbol] || {};
    const needDaily = !entry.dailyCandles || Date.now() - (entry.dailyFetchedAt || 0) > DAILY_CACHE_MS;
    const needInd = !entry.candles1mMacd || Date.now() - (entry.candles1mMacdFetchedAt || 0) > INDICATOR_1M_CACHE_MS;

    const [candles1m, candles1mMacd] = await Promise.all([
      getSignal1mCandles(symbol),
      needInd ? getIndicator1mCandles(symbol) : Promise.resolve(entry.candles1mMacd)
    ]);
    if (symbol !== activeSymbol) return;
    if (!marketDataCache[symbol]) marketDataCache[symbol] = {};
    marketDataCache[symbol].candles1m = candles1m;
    if (needInd && candles1mMacd) {
      marketDataCache[symbol].candles1mMacd = candles1mMacd;
      marketDataCache[symbol].candles1mMacdFetchedAt = Date.now();
    }

    if (needDaily) {
      try {
        const dailyCandles = await getDailyCandles(symbol);
        if (symbol !== activeSymbol) return;
        marketDataCache[symbol].dailyCandles = dailyCandles;
        marketDataCache[symbol].dailyFetchedAt = Date.now();
      } catch (err) {
        console.warn(`Daily history failed (${symbol}):`, err.message);
      }
    }

    recomputeAndCacheState(symbol);
  } catch (err) {
    cacheRefreshError(symbol, err);
  } finally {
    refreshInFlight.candles = false;
  }
}

function stopSymbolRefresh() {
  if (refreshTimers.quote) {
    clearInterval(refreshTimers.quote);
    refreshTimers.quote = null;
  }
  if (refreshTimers.candles) {
    clearInterval(refreshTimers.candles);
    refreshTimers.candles = null;
  }
  refreshInFlight.quote = false;
  refreshInFlight.candles = false;
}

function startSymbolRefresh(symbol) {
  stopSymbolRefresh();
  refreshQuote(symbol);
  refreshCandles(symbol);
  refreshTimers.quote = setInterval(() => refreshQuote(symbol), QUOTE_POLL_MS);
  refreshTimers.candles = setInterval(() => refreshCandles(symbol), CANDLE_POLL_MS);
}

function setActiveSymbol(symbol) {
  if (activeSymbol === symbol) return;
  stopSymbolRefresh();
  activeSymbol = symbol;
  if (symbol) startSymbolRefresh(symbol);
}

// ── API ENDPOINTS ─────────────────────────────────────────────
async function stateHandler(req, res) {
  const sym = req.params.symbol.toUpperCase();

  if (!(await ensureSchwabAuth())) {
    return res.json({ status: 'auth_failed' });
  }

  setActiveSymbol(sym);
  triggerMinuteEdgeRefresh(sym);

  const cached = responseCache[sym];
  if (cached) {
    if (cached.status === 'rate_limited') {
      return res.status(429).json(cached);
    }
    if (cached.status === 'auth_failed' && !authenticated) {
      return res.json(cached);
    }
    if (cached.status === 'auth_failed') {
      delete responseCache[sym];
    }
    return res.json(cached);
  }

  return res.json({ status: 'insufficient_data', missing: ['initializing'] });
}

app.get('/api/state/:symbol', stateHandler);

app.get('/api/health', async (req, res) => {
  if (!authenticated) await ensureSchwabAuth();
  res.json({
    authenticated,
    token_store: TOKEN_FILE,
    last_successful_fetch: lastSuccessfulFetch,
    rate_limit_status: rateLimitStatus,
    schwab_calls_per_min: getSchwabCallsPerMinute(),
    poll_intervals_ms: {
      quote: QUOTE_POLL_MS,
      candles: CANDLE_POLL_MS,
      frontend_state: Number(process.env.STATE_POLL_MS) || 1000
    }
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    authenticated,
    session:  getMarketSession(),
    open:     isGatekeeperOpen(),
    hoursEt:  '4:00 AM – 8:00 PM'
  });
});

app.use(express.static('public'));

// ── START ─────────────────────────────────────────────────────
async function initAuthOnStartup() {
  if (accessTokenStillValid()) {
    markAuthenticated();
    console.log('✅ Startup: using stored access token (no refresh)');
  } else if (refreshToken && Date.now() >= refreshTokenSuspendedUntil) {
    await refreshAccessToken({ force: true });
  }
  startProactiveRefreshTimer();
  if (authenticated) await probeSchwabAuth().catch(() => {});
}

function listen() {
  const onListen = () => {
    console.log(`\n🚀 KQ-GateKeeper running at https://gatekeeper.veilforge.org`);
    console.log(`🔐 Login at https://gatekeeper.veilforge.org/login`);
    console.log(`💾 Token store: ${TOKEN_FILE}\n`);
  };
  const certPath = process.env.CERT_PATH;
  const keyPath  = process.env.KEY_PATH;
  if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    https.createServer({
      cert: fs.readFileSync(certPath),
      key:  fs.readFileSync(keyPath)
    }, app).listen(PORT, onListen);
  } else {
    app.listen(PORT, onListen);
  }
}

initAuthOnStartup()
  .catch(err => console.error('Startup auth init failed:', err.message))
  .finally(() => {
    startNasdaqHaltPoll();
    listen();
  });