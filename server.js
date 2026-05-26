require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = 3000;

// ── TOKEN PERSISTENCE ─────────────────────────────────────────
const TOKEN_FILE = './tokens.json';

let accessToken = null;
let refreshToken = null;
let tokenExpiry = null;

let authenticated = false;
let lastSuccessfulFetch = null;
let rateLimitStatus = 'ok';
let rateLimitBackoffStep = 0;
let rateLimitBackoffUntil = 0;
let rateLimitBackoffPromise = null;

const stateCache = {};

const QUOTE_POLL_MS = 5000;
const CANDLE_POLL_MS = 15000;

let activeSymbol = null;
const refreshTimers = { quote: null, candles: null };
const refreshInFlight = { quote: false, candles: false };
const marketDataCache = {};
const responseCache = {};

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

function saveTokens() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ accessToken, refreshToken, tokenExpiry }));
    console.log('💾 Tokens saved to disk');
  } catch (e) {
    console.error('Token save failed:', e.message);
  }
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const d = JSON.parse(fs.readFileSync(TOKEN_FILE));
      accessToken  = d.accessToken;
      refreshToken = d.refreshToken;
      tokenExpiry  = d.tokenExpiry;
      console.log('✅ Tokens loaded from disk');
    }
  } catch (e) {
    console.error('Token load failed:', e.message);
  }
}

loadTokens();

// ── AUTH ──────────────────────────────────────────────────────
const SCHWAB_AUTH_URL  = 'https://api.schwabapi.com/v1/oauth/authorize';
const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const MARKET_DATA_URL  = 'https://api.schwabapi.com/marketdata/v1';

const clientId     = process.env.SCHWAB_CLIENT_ID;
const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
const redirectUri  = process.env.REDIRECT_URI;
const basicAuth    = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

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
    saveTokens();
    authenticated = true;
    console.log('✅ Authenticated with Schwab');
    res.send('<script>window.close();</script>Authenticated! You can close this window.');
  } catch (err) {
    console.error('Auth error:', err.response?.data || err.message);
    res.send('Authentication failed. Check console.');
  }
});

async function refreshAccessToken({ force = false } = {}) {
  if (!refreshToken) {
    authenticated = false;
    return false;
  }
  if (!force && accessToken && tokenExpiry && Date.now() < tokenExpiry - 60000) {
    return true;
  }
  try {
    const response = await axios.post(SCHWAB_TOKEN_URL,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      { headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    accessToken = response.data.access_token;
    if (response.data.refresh_token) refreshToken = response.data.refresh_token;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000);
    saveTokens();
    authenticated = true;
    console.log('🔄 Token refreshed');
    return true;
  } catch (err) {
    console.error('Token refresh failed:', err.response?.status, err.response?.data || err.message);
    authenticated = false;
    return false;
  }
}

async function probeSchwabAuth() {
  if (!(await refreshAccessToken({ force: true }))) return false;
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

  if (!authenticated && !(await refreshAccessToken())) {
    return { ok: false, status: 401, error: 'auth_failed' };
  }

  if (!(await refreshAccessToken())) {
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
    logSchwabOk();
    return { ok: true, status: 200, data: res.data };
  }

  if (res.status === 401) {
    if (!(await refreshAccessToken({ force: true }))) {
      return { ok: false, status: 401, error: 'auth_failed' };
    }
    res = await requestOnce();
    if (res.status === 200) {
      markFetchSuccess();
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
  return {
    today,
    ethStartMs: utcFromEtDateTime(today, 4, 0),
    ethEndMs:   utcFromEtDateTime(today, 20, 0),
    capEndMs:   Math.min(now, utcFromEtDateTime(today, 20, 0))
  };
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

async function fetchSessionCandles(symbol, frequency, frequencyType, cfg, lookbackDays = 2) {
  const endDate   = Date.now();
  const startDate = Math.min(cfg.vwapStartMs, endDate - lookbackDays * 24 * 60 * 60 * 1000);
  const raw = await getPriceHistory(symbol, 'day', Math.max(lookbackDays, 2), frequencyType, frequency, {
    startDate,
    endDate,
    needExtendedHoursData: cfg.needExtendedHours
  });
  let candles = sortCandles(raw).filter(c => c.datetime >= cfg.vwapStartMs && cfg.filterCandle(c));
  if (cfg.session === 'CLOSED' && candles.length) {
    const lastDay = getEtDateString(candles[candles.length - 1].datetime);
    candles = candles.filter(c => getEtDateString(c.datetime) === lastDay);
  }
  if (candles.length < 10) {
    const wideDays = cfg.session === 'CLOSED' ? 10 : 5;
    const wide = await getPriceHistory(symbol, 'day', wideDays, frequencyType, frequency, {
      startDate: endDate - wideDays * 24 * 60 * 60 * 1000,
      endDate,
      needExtendedHoursData: true
    });
    candles = filterToMostRecentTradingDay(sortCandles(wide), cfg.filterCandle);
  }
  return candles;
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

function resolveVwapPackFrom1m(candles1m, pmCfg) {
  let vwapPack = buildVwapPackFrom1m(candles1m, pmCfg);
  let vwapAnchor = 'PM';
  if (isVwapPartialEth(vwapPack.candles, pmCfg.vwapStartMs)) {
    // Use last bar's session day — not calendar today (empty on holidays/weekends)
    const refDay = getLastCandleEtDate(candles1m);
    const rthStart = utcFromEtDateTime(refDay, 9, 30);
    const refEndMs = utcFromEtDateTime(refDay, 20, 0);
    vwapPack = buildVwapPackFrom1m(candles1m, {
      session: pmCfg.session === 'CLOSED' ? 'CLOSED' : getMarketSession(),
      tag: 'RTH',
      needExtendedHours: true,
      vwapStartMs: rthStart,
      filterCandle: c =>
        getEtDateString(c.datetime) === refDay &&
        c.datetime >= rthStart &&
        c.datetime <= refEndMs
    });
    vwapAnchor = 'RTH';
  }
  return { vwapPack, vwapAnchor };
}

async function getSignal5mCandles(symbol, cfg = getSessionConfig()) {
  const lookbackDays = cfg.session === 'CLOSED' ? 10 : 3;
  const candles = await fetchSessionCandles(symbol, 5, 'minute', cfg, lookbackDays);
  return { candles, session: cfg.session };
}

// 1-min candles: 10 calendar days — must span weekends when session is CLOSED
async function getSignal1mCandles(symbol) {
  const endDate   = Date.now();
  const startDate = endDate - 10 * 24 * 60 * 60 * 1000;
  return getPriceHistory(symbol, 'day', 10, 'minute', 1, {
    startDate,
    endDate,
    needExtendedHoursData: true
  });
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

function contextMarketSession(now = Date.now()) {
  const s = getMarketSession(now);
  if (s === 'POST') return 'AH';
  return s;
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

// TOS MACD (12, 26, 9, EXPONENTIAL) on a close array; null until valid (35 bars for histogram).
function calcMACDExactTOS(closes) {
  const n = closes.length;
  const macdLine   = Array(n).fill(null);
  const signalLine = Array(n).fill(null);
  const histogram  = Array(n).fill(null);

  if (!n || closes.some(v => !Number.isFinite(v))) {
    return { macdLine, signalLine, histogram };
  }

  const ema12 = calcEMASMASeed(closes, 12);
  const ema26 = calcEMASMASeed(closes, 26);

  for (let i = 0; i < n; i++) {
    if (ema12[i] !== null && ema26[i] !== null) {
      macdLine[i] = ema12[i] - ema26[i];
    }
  }

  const macdSeq    = [];
  const macdIndices = [];
  for (let i = 0; i < n; i++) {
    if (macdLine[i] !== null) {
      macdSeq.push(macdLine[i]);
      macdIndices.push(i);
    }
  }

  const signalEma = calcEMASMASeed(macdSeq, 9);
  for (let j = 0; j < macdSeq.length; j++) {
    if (signalEma[j] !== null) {
      const i = macdIndices[j];
      signalLine[i] = signalEma[j];
      histogram[i]  = macdLine[i] - signalEma[j];
    }
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

function getCompleted5mBars(candles) {
  if (!candles?.length) return [];
  const sorted = candles.length > 1 && candles[0].datetime
    ? [...candles].sort((a, b) => a.datetime - b.datetime)
    : [...candles];
  const bucketMs   = 5 * 60 * 1000;
  const nowBucket  = Math.floor(Date.now() / bucketMs) * bucketMs;
  const last       = sorted[sorted.length - 1];
  const lastBucket = Math.floor(last.datetime / bucketMs) * bucketMs;
  if (lastBucket >= nowBucket) return sorted.slice(0, -1);
  return sorted;
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

function computeWarnings(candles1m, completed1m) {
  const warnings = [];
  if (candles1m.length < 4) return warnings;

  const bar = candles1m[candles1m.length - 2];
  const range = bar.high - bar.low;
  if (range > 0) {
    const upperWick = bar.high - Math.max(bar.open, bar.close);
    if (upperWick / range > 0.6) warnings.push('topping_tail');
    const body = Math.abs(bar.close - bar.open);
    if (body / range < 0.1) warnings.push('doji');
  }

  const last3 = candles1m.slice(-4, -1);
  if (last3.length === 3) {
    const bullishAll = last3.every(c => c.close > c.open);
    const bodies = last3.map(c => Math.abs(c.close - c.open));
    const heights = last3.map(c => c.high - c.low);
    const bodiesShrinking   = bodies[0] > bodies[1] && bodies[1] > bodies[2];
    const heightsShrinking  = heights[0] > heights[1] && heights[1] > heights[2];
    if (bullishAll && (bodiesShrinking || heightsShrinking)) {
      warnings.push('momentum_exhaustion');
    }
  }

  const prior10 = candles1m.slice(-12, -2);
  if (prior10.length >= 10) {
    const prior10Avg = prior10.reduce((s, c) => s + c.volume, 0) / prior10.length;
    if (bar.volume < prior10Avg * 0.5) warnings.push('tape_slowdown');
  }

  const ema20arr = calcEMASMASeed(completed1m.map(c => c.close), 20);
  const ema20_1m = lastFinite(ema20arr);
  if (Number.isFinite(ema20_1m) && bar.close < ema20_1m) {
    warnings.push('lost_20_ema');
  }

  return warnings;
}

function trafficLightRaw(countGreen) {
  if (countGreen === 4) return 'IN_PLAY';
  if (countGreen >= 2) return 'CAUTION';
  return 'BACK_SIDE';
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

function computeStateFromCache(symbol) {
  const cache = marketDataCache[symbol];
  if (!cache) {
    return { status: 'insufficient_data', missing: ['initializing'] };
  }

  const { quote, pack5m, candles1m: candles1mRaw } = cache;
  if (!quote || !pack5m || !candles1mRaw) {
    const missing = [];
    if (!quote) missing.push('quote');
    if (!pack5m?.candles?.length) missing.push('5m_candles');
    if (!candles1mRaw?.length) missing.push('1m_candles');
    return { status: 'insufficient_data', missing };
  }

  const pmCfg = getVwapConfig();
  const { vwapPack, vwapAnchor } = resolveVwapPackFrom1m(candles1mRaw, pmCfg);

  const missing = [];
  if (!quote?.lastPrice || !Number.isFinite(quote.lastPrice) ||
      !quote?.closePrice || !Number.isFinite(quote.closePrice)) {
    missing.push('quote');
  }

  const candles5m = sortCandles(pack5m.candles);
  const candles1m = sortCandles(candles1mRaw);
  if (candles5m.length < 25) missing.push('5m_candles');
  if (candles1m.length < 35) missing.push('1m_candles');

  let candlesVwap = sortCandles(vwapPack.candles);
  if (quote && shouldPatchQuote(candlesVwap, quote, vwapPack.bucketMs)) {
    candlesVwap = applyLiveQuoteToCandles(candlesVwap, quote, vwapPack.bucketMs);
  }
  const hasVwapVol = candlesVwap.some(c => Number.isFinite(c.volume) && c.volume > 0);
  if (!hasVwapVol) missing.push('vwap_candles');

  if (missing.length) {
    return { status: 'insufficient_data', missing };
  }

  const price = quote.lastPrice;
  const prevClose = quote.closePrice;
  const vwap = calcVWAP(candlesVwap);

  const completed5m = getCompleted5mBars(candles5m);
  const completed1m = getCompleted1mBars(candles1m);
  const closes1m = completed1m.map(c => c.close);
  const ema9_1m_value = lastFinite(calcEMASMASeed(closes1m, 9));
  const ema20_1m_value = lastFinite(calcEMASMASeed(closes1m, 20));
  const front_side_emas = Number.isFinite(ema9_1m_value) && Number.isFinite(ema20_1m_value) &&
    ema9_1m_value > ema20_1m_value;

  const { histogram } = calcMACDExactTOS(closes1m);
  const macd_histogram_value = lastFinite(histogram);
  if (!Number.isFinite(macd_histogram_value)) {
    return { status: 'insufficient_data', missing: ['1m_candles'] };
  }
  const front_side_macd = macd_histogram_value > 0;
  const front_side_vwap = vwap != null && price > vwap;

  const forming5m = candles5m[candles5m.length - 1];
  const recent4 = completed5m.slice(-4);
  const recent4High = recent4.length
    ? Math.max(...recent4.map(c => c.high))
    : -Infinity;
  const front_side_hh = recent4.length >= 4 && forming5m.high > recent4High;

  const front_side = {
    emas: front_side_emas,
    macd: front_side_macd,
    vwap: front_side_vwap,
    hh: front_side_hh
  };
  const countGreen = Object.values(front_side).filter(Boolean).length;
  const warnings = computeWarnings(candles1m, completed1m);

  const prior10Vol = candles1m.slice(-12, -2);
  const prior10AvgVol = prior10Vol.length
    ? prior10Vol.reduce((s, c) => s + c.volume, 0) / prior10Vol.length
    : 1;
  const currentVol = candles1m[candles1m.length - 1].volume;
  const rvol_1m = prior10AvgVol > 0 ? currentVol / prior10AvgVol : 0;

  const now = Date.now();
  const vwapDeltaDollars = vwap != null ? price - vwap : 0;
  const vwapDeltaPct = vwap != null && vwap > 0 ? ((price - vwap) / vwap) * 100 : 0;

  return {
    status: 'ok',
    symbol,
    traffic_light_raw: trafficLightRaw(countGreen),
    front_side,
    warnings,
    context: {
      price: round2(price),
      day_change_pct: round2(((price - prevClose) / prevClose) * 100),
      vwap_delta_dollars: round2(vwapDeltaDollars),
      vwap_delta_pct: round2(vwapDeltaPct),
      vwap_anchor: vwapAnchor,
      ema9_1m_value: round2(ema9_1m_value),
      ema20_1m_value: round2(ema20_1m_value),
      macd_histogram_value,
      rvol_1m: round2(rvol_1m),
      time_et: formatTimeEtIso(now),
      market_session: contextMarketSession(now)
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
  console.error(`Refresh error (${symbol}):`, err.message);
}

function recomputeAndCacheState(symbol) {
  if (symbol !== activeSymbol) return;
  try {
    const state = computeStateFromCache(symbol);
    if (state.status === 'insufficient_data') {
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
    if (!authenticated && !(await refreshAccessToken())) return;
    const quote = await getQuote(symbol);
    if (symbol !== activeSymbol) return;
    if (!marketDataCache[symbol]) marketDataCache[symbol] = {};
    marketDataCache[symbol].quote = quote;
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
    if (!authenticated && !(await refreshAccessToken())) return;
    const sessionCfg = getSessionConfig();
    const [pack5m, candles1m] = await Promise.all([
      getSignal5mCandles(symbol, sessionCfg),
      getSignal1mCandles(symbol)
    ]);
    if (symbol !== activeSymbol) return;
    if (!marketDataCache[symbol]) marketDataCache[symbol] = {};
    marketDataCache[symbol].pack5m = pack5m;
    marketDataCache[symbol].candles1m = candles1m;
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

  if (!authenticated && !(await refreshAccessToken())) {
    return res.json({ status: 'auth_failed' });
  }

  setActiveSymbol(sym);

  const cached = responseCache[sym];
  if (cached) {
    if (cached.status === 'insufficient_data') {
      return res.status(503).json(cached);
    }
    if (cached.status === 'rate_limited') {
      return res.status(429).json(cached);
    }
    if (cached.status === 'auth_failed') {
      return res.json(cached);
    }
    return res.json(cached);
  }

  return res.status(503).json({ status: 'insufficient_data', missing: ['initializing'] });
}

app.get('/api/state/:symbol', stateHandler);

app.get('/api/health', async (req, res) => {
  if (!authenticated && refreshToken) {
    await refreshAccessToken();
  }
  res.json({
    authenticated,
    last_successful_fetch: lastSuccessfulFetch,
    rate_limit_status: rateLimitStatus
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
if (refreshToken) {
  refreshAccessToken({ force: true }).catch(err => {
    console.error('Startup token refresh failed:', err.message);
  });
}

const certPath = process.env.CERT_PATH;
const keyPath  = process.env.KEY_PATH;

if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const httpsOptions = {
    cert: fs.readFileSync(certPath),
    key:  fs.readFileSync(keyPath)
  };
  https.createServer(httpsOptions, app).listen(PORT, () => {
    console.log(`\n🚀 KQ-GateKeeper running at https://gatekeeper.veilforge.org`);
    console.log(`🔐 Login at https://gatekeeper.veilforge.org/login\n`);
  });
} else {
  app.listen(PORT, () => {
    console.log(`\n🚀 KQ-GateKeeper running at http://localhost:${PORT}`);
    console.log(`🔐 Login at http://localhost:${PORT}/login\n`);
  });
}