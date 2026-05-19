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

app.get('/login', (req, res) => {
  const authUrl = `${SCHWAB_AUTH_URL}?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(authUrl);
});

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
    console.log('✅ Authenticated with Schwab');
    res.send('<script>window.close();</script>Authenticated! You can close this window.');
  } catch (err) {
    console.error('Auth error:', err.response?.data || err.message);
    res.send('Authentication failed. Check console.');
  }
});

async function ensureToken() {
  if (!accessToken) throw new Error('Not authenticated');
  if (Date.now() < tokenExpiry - 60000) return;
  const response = await axios.post(SCHWAB_TOKEN_URL,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    { headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  accessToken = response.data.access_token;
  tokenExpiry = Date.now() + (response.data.expires_in * 1000);
  saveTokens();
  console.log('🔄 Token refreshed');
}

// ── MARKET DATA ───────────────────────────────────────────────
async function getQuote(symbol) {
  await ensureToken();
  const res = await axios.get(`${MARKET_DATA_URL}/quotes`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    params:  { symbols: symbol, fields: 'quote,fundamental' }
  });
  return res.data[symbol]?.quote || null;
}

async function getPriceHistory(symbol, periodType, period, frequencyType, frequency, opts = {}) {
  await ensureToken();
  const { needExtendedHoursData = false, startDate, endDate } = opts;
  const params = { symbol, periodType, period, frequencyType, frequency, needExtendedHoursData };
  if (startDate != null) params.startDate = startDate;
  if (endDate != null) params.endDate = endDate;
  const res = await axios.get(`${MARKET_DATA_URL}/pricehistory`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    params
  });
  return res.data.candles || [];
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

// UTC ms for a given calendar day + clock time in New York (handles DST)
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

const PRE_OPEN_ET  = 4 * 60;         // 4:00 AM — Schwab pre-market
const RTH_OPEN_ET  = 9 * 60 + 30;    // 9:30 AM
const RTH_CLOSE_ET = 16 * 60;        // 4:00 PM
const POST_CLOSE_ET = 20 * 60;       // 8:00 PM — Schwab after-hours

function getEtMinutes(ms) {
  const { h, m } = getEtHourMinute(ms);
  return h * 60 + m;
}

// PRE (4:00–9:30) | RTH (9:30–16:00) | POST (16:00–20:00) | CLOSED
function getMarketSession(now = Date.now()) {
  const mins = getEtMinutes(now);
  if (mins >= RTH_OPEN_ET && mins < RTH_CLOSE_ET) return 'RTH';
  if (mins >= PRE_OPEN_ET && mins < RTH_OPEN_ET) return 'PRE';
  if (mins >= RTH_CLOSE_ET && mins < POST_CLOSE_ET) return 'POST';
  return 'CLOSED';
}

function getSessionConfig(now = Date.now()) {
  const session = getMarketSession(now);
  const today = getEtDateString(now);

  const onToday = c => getEtDateString(c.datetime) === today;
  const inMins = (c, lo, hi) => {
    const mins = getEtMinutes(c.datetime);
    return mins >= lo && mins < hi;
  };

  switch (session) {
    case 'PRE':
      return {
        session,
        tag: 'PRE',
        needExtendedHours: true,
        vwapStartMs: utcFromEtDateTime(today, 4, 0),
        filterCandle: c => onToday(c) && inMins(c, PRE_OPEN_ET, RTH_OPEN_ET)
      };
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
        vwapStartMs: now - 3 * 24 * 60 * 60 * 1000,
        filterCandle: c => inMins(c, RTH_OPEN_ET, POST_CLOSE_ET)
      };
  }
}

function sortCandles(candles) {
  return candles.length > 1 && candles[0].datetime
    ? [...candles].sort((a, b) => a.datetime - b.datetime)
    : candles;
}

function filterToMostRecentTradingDay(candles, filterCandle) {
  if (!candles.length) return [];
  const sorted = sortCandles(candles);
  const lastDay = getEtDateString(sorted[sorted.length - 1].datetime);
  return sorted.filter(c => getEtDateString(c.datetime) === lastDay && filterCandle(c));
}

async function fetchSessionCandles(symbol, frequency, frequencyType, cfg, lookbackDays = 2) {
  const endDate = Date.now();
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
    const wide = await getPriceHistory(symbol, 'day', 5, frequencyType, frequency, {
      startDate: endDate - 5 * 24 * 60 * 60 * 1000,
      endDate,
      needExtendedHoursData: true
    });
    candles = filterToMostRecentTradingDay(sortCandles(wide), cfg.filterCandle);
  }
  return candles;
}

// 1-min bars for session-appropriate VWAP
async function getVwapCandles(symbol, cfg = getSessionConfig()) {
  const candles = await fetchSessionCandles(symbol, 1, 'minute', cfg, 2);
  return { candles, tag: cfg.tag, session: cfg.session };
}

// 5-min bars for EMA / volume / candle rules (same session window as price action)
async function getSignal5mCandles(symbol, cfg = getSessionConfig()) {
  const candles = await fetchSessionCandles(symbol, 5, 'minute', cfg, 3);
  return { candles, session: cfg.session };
}

// 1-min for MACD: last ~2 sessions, extended hours (matches TOS 1-min + ETH)
async function getMacdMinuteCandles(symbol) {
  const endDate = Date.now();
  const startDate = endDate - 2 * 24 * 60 * 60 * 1000;
  return getPriceHistory(symbol, 'day', 10, 'minute', 1, {
    startDate,
    endDate,
    needExtendedHoursData: true
  });
}

// Update the current minute bar from the live quote (no duplicate bars)
function applyLiveQuoteToCandles(candles, quote) {
  if (!candles?.length || !quote?.lastPrice || !Number.isFinite(quote.lastPrice)) {
    return candles;
  }
  const sorted = candles.length > 1 && candles[0].datetime
    ? [...candles].sort((a, b) => a.datetime - b.datetime)
    : [...candles];
  const last = sorted[sorted.length - 1];
  const qTime = quote.quoteTime || quote.tradeTime;
  const price = quote.lastPrice;
  const minuteMs = 60 * 1000;

  if (!qTime) {
    last.close = price;
    return sorted;
  }

  const qMinute = Math.floor(qTime / minuteMs) * minuteMs;
  const lastMinute = Math.floor(last.datetime / minuteMs) * minuteMs;

  if (qMinute === lastMinute) {
    last.close = price;
    if (last.high != null) last.high = Math.max(last.high, price);
    if (last.low != null) last.low = Math.min(last.low, price);
  } else if (qMinute > lastMinute) {
    sorted.push({
      datetime: qMinute,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0
    });
  }
  return sorted;
}

function shouldPatchQuote(candles, quote) {
  if (!candles?.length || !quote?.quoteTime) return false;
  const last = candles[candles.length - 1];
  return quote.quoteTime > last.datetime + 60 * 1000;
}

// ── SIGNAL CALCULATIONS ───────────────────────────────────────

// ~4 significant figures; scales decimals for NVDA-scale vs sub-penny histograms
function formatMacdValue(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value === 0) return '+0';

  const sign = value >= 0 ? '+' : '-';
  const abs = Math.abs(value);
  if (abs >= 100) return sign + String(parseFloat(abs.toFixed(1)));

  const decimals = Math.min(7, Math.max(2, 3 - Math.floor(Math.log10(abs))));
  return sign + String(parseFloat(abs.toFixed(decimals)));
}

// Histogram as % of price — comparable across $0.01 names and $500 names (TOS Diff is still $)
function macdHistogramPct(histogram, price) {
  if (!Number.isFinite(histogram) || !Number.isFinite(price) || price <= 0) return null;
  return (histogram / price) * 100;
}

function formatMacdPercent(histogram, price) {
  const pct = macdHistogramPct(histogram, price);
  if (pct === null) return 'n/a';
  if (pct === 0) return '+0%';

  const sign = pct >= 0 ? '+' : '';
  const abs = Math.abs(pct);
  if (abs >= 1) return sign + parseFloat(pct.toFixed(2)) + '%';
  if (abs >= 0.01) return sign + parseFloat(pct.toFixed(3)) + '%';
  return sign + parseFloat(pct.toFixed(4)) + '%';
}

// Full histogram series (signal EMA applied bar-by-bar, same as TOS Diff)
function buildMacdHistogramSeries(macdValues) {
  if (macdValues.length < 9) return [];
  const k = 2 / 10;
  let signal = calcEMAFromValues(macdValues.slice(0, 9), 9);
  const series = [macdValues[8] - signal];
  for (let i = 9; i < macdValues.length; i++) {
    signal = macdValues[i] * k + signal * (1 - k);
    series.push(macdValues[i] - signal);
  }
  return series;
}

// How tall the current bar is vs recent peaks on THIS symbol (like TOS auto-scaled MACD pane)
function macdHistogramStrength(histogram, history, lookback = 390) {
  if (!Number.isFinite(histogram) || !history?.length) return null;
  const window = history.slice(-lookback);
  const peak = Math.max(...window.map(h => Math.abs(h)), 1e-12);
  return (histogram / peak) * 100;
}

function macdStrengthTier(strength) {
  if (strength === null || !Number.isFinite(strength)) return null;
  const a = Math.abs(strength);
  if (a >= 75) return 'STRONG';
  if (a >= 40) return 'MID';
  return 'WEAK';
}

function formatMacdStrength(strength) {
  if (strength === null || !Number.isFinite(strength)) return 'n/a';
  const sign = strength >= 0 ? '+' : '';
  return sign + Math.round(strength) + '%';
}

// Compact panel label: direction + strength vs recent peak (no raw $ histogram)
function formatMacdHistDetail(histogram, strength, tier) {
  if (!Number.isFinite(histogram)) return 'insufficient data';
  if (!Number.isFinite(strength) || !tier) {
    return histogram < 0 ? 'HIST ↓ weak' : 'HIST ↑ weak';
  }
  const arrow = histogram < 0 ? '↓' : '↑';
  return `HIST ${arrow}${Math.round(Math.abs(strength))}% ${tier}`;
}

// EMA on candle array (uses .close)
function calcEMA(candles, period) {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  return ema;
}

// TOS exponential EMA on a plain number array (first price seeds EMA1)
function calcEMAFromValues(values, period) {
  if (!values.length) return null;
  if (values.some(v => !Number.isFinite(v))) return null;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcVWAP(candles) {
  let cumTPV = 0, cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

function calcEMASlope(candles, period) {
  if (candles.length < period + 1) return false;
  const emaNow  = calcEMA(candles, period);
  const emaPrev = calcEMA(candles.slice(0, -1), period);
  return emaNow > emaPrev;
}

// Full MACD: line, signal line, histogram (TOS 12/26/9 exponential)
// histogram > 0 = MACD line above signal = bullish momentum
function calcMACD(candles, symbol) {
  if (candles.length < 9) return null;

  const sorted = candles.length > 1 && candles[0].datetime
    ? [...candles].sort((a, b) => a.datetime - b.datetime)
    : candles;
  const closes = sorted.map(c => c.close);
  if (closes.some(v => !Number.isFinite(v))) return null;

  const k12 = 2 / 13;
  const k26 = 2 / 27;
  let ema12 = closes[0];
  let ema26 = closes[0];
  const macdValues = [ema12 - ema26];

  for (let i = 1; i < closes.length; i++) {
    ema12 = closes[i] * k12 + ema12 * (1 - k12);
    ema26 = closes[i] * k26 + ema26 * (1 - k26);
    macdValues.push(ema12 - ema26);
  }

  if (macdValues.length < 9) return null;

  const macdLine  = macdValues[macdValues.length - 1];
  const signal    = calcEMAFromValues(macdValues, 9);
  if (signal === null) return null;

  const histogram = macdLine - signal;
  const histogramSeries = buildMacdHistogramSeries(macdValues);
  const strength = macdHistogramStrength(histogram, histogramSeries);

  const tag = symbol ? `${symbol} ` : '';
  const lastBar = sorted[sorted.length - 1];
  const lastTs = lastBar?.datetime ? new Date(lastBar.datetime).toISOString() : 'n/a';
  const tier = macdStrengthTier(strength);
  console.log(
    `${tag}MACD (${sorted.length} bars, last ${lastTs} close=${lastBar?.close}) ` +
    `hist=${formatMacdValue(histogram)} ${tier} ${formatMacdStrength(strength)} of recent peak`
  );

  return { line: macdLine, signal, histogram, strength, strengthTier: tier, histogramSeries };
}

function checkVolumeDry(candles, lookback = 10, threshold = 0.5) {
  if (candles.length < lookback + 2) return false;
  const recent     = candles.slice(-lookback - 2, -2);
  const avg        = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  const prevCandle = candles[candles.length - 2];
  return prevCandle.volume < avg * threshold;
}

function checkVolumeSurge(candles, lookback = 10, threshold = 1.5) {
  if (candles.length < lookback + 1) return false;
  const recent  = candles.slice(-lookback - 1, -1);
  const avg     = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  const current = candles[candles.length - 1];
  return current.volume > avg * threshold;
}

function checkToppingTail(candles) {
  const c     = candles[candles.length - 1];
  const range = c.high - c.low;
  if (range === 0) return false;
  return (c.high - c.close) / range > 0.6;
}

// Last completed 5m close vs low of the 5m bar before it (skip forming bar at end)
function getCandleUnderSnapshot(candles) {
  if (candles.length < 3) return null;
  const closed = candles[candles.length - 2];
  const prior = candles[candles.length - 3];
  const met = closed.close < prior.low;
  const c = closed.close.toFixed(2);
  const l = prior.low.toFixed(2);
  const detail = met ? `C $${c} < $${l} L` : `C $${c} ≥ $${l} L`;
  return { met, detail, closed, prior };
}

function checkCandleUnderCandle(candles) {
  const snap = getCandleUnderSnapshot(candles);
  return snap ? snap.met : false;
}

function checkPullback(candles) {
  if (candles.length < 5) return { valid: false, pct: null };
  const recent = candles.slice(-10);
  let poleHighIdx = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].high > recent[poleHighIdx].high) poleHighIdx = i;
  }
  if (poleHighIdx === 0 || poleHighIdx === recent.length - 1) return { valid: false, pct: null };
  const beforePole = recent.slice(0, poleHighIdx);
  const poleBottom = Math.min(...beforePole.map(c => c.low));
  const poleTop    = recent[poleHighIdx].high;
  const poleSize   = poleTop - poleBottom;
  if (poleSize <= 0) return { valid: false, pct: null };
  const afterPole   = recent.slice(poleHighIdx + 1);
  const pullbackLow = Math.min(...afterPole.map(c => c.low));
  const pullbackPct = ((poleTop - pullbackLow) / poleSize) * 100;
  return { valid: pullbackPct <= 50, pct: pullbackPct };
}

function checkVWAPBreakDuringConsolidation(candles, vwap) {
  if (candles.length < 6) return false;
  const window   = candles.slice(-6, -1);
  const avgClose = window.reduce((s, c) => s + c.close, 0) / window.length;
  const maxHigh  = Math.max(...window.map(c => c.high));
  const minLow   = Math.min(...window.map(c => c.low));
  if ((maxHigh - minLow) / avgClose >= 0.03) return false;
  return window.some(c => c.close < vwap);
}

async function buildSignals(symbol) {
  const sessionCfg = getSessionConfig();
  const [quote, pack5m, candles1mRaw, vwapPack] = await Promise.all([
    getQuote(symbol),
    getSignal5mCandles(symbol, sessionCfg),
    getMacdMinuteCandles(symbol),
    getVwapCandles(symbol, sessionCfg)
  ]);
  const candles5m = pack5m.candles;
  const candlesVwap = vwapPack.candles;
  const vwapTag = vwapPack.tag;
  const marketSession = vwapPack.session;

  const min5mBars = marketSession === 'PRE' ? 6 : 24;
  if (!quote || candles5m.length < min5mBars) return null;

  const candles1m = shouldPatchQuote(candles1mRaw, quote)
    ? applyLiveQuoteToCandles(candles1mRaw, quote)
    : candles1mRaw;

  const price      = quote.lastPrice;
  const prevClose  = quote.closePrice;
  const dayGainPct = ((price - prevClose) / prevClose) * 100;

  const vwap = calcVWAP(candlesVwap);
  if (vwap !== null && candlesVwap.length) {
    const vFirst = candlesVwap[0];
    const vLast = candlesVwap[candlesVwap.length - 1];
    console.log(
      `${symbol} [${marketSession}] VWAP $${vwap.toFixed(2)} (${vwapTag}, ${candlesVwap.length} 1m, ` +
      `${getEtHourMinute(vFirst.datetime).h}:${String(getEtHourMinute(vFirst.datetime).m).padStart(2, '0')}–` +
      `${getEtHourMinute(vLast.datetime).h}:${String(getEtHourMinute(vLast.datetime).m).padStart(2, '0')} ET)`
    );
  }
  const ema9        = calcEMA(candles5m, 9);
  const ema9Sloping = calcEMASlope(candles5m, 9);
  const macd        = calcMACD(candles1m, symbol);
  const volDry      = checkVolumeDry(candles5m);
  const volSurge    = checkVolumeSurge(candles5m);
  const toppingTail = checkToppingTail(candles5m);
  const candleUnder = checkCandleUnderCandle(candles5m);
  const pullback    = checkPullback(candles5m);
  const vwapBreak   = checkVWAPBreakDuringConsolidation(candles5m, vwap);

  // Histogram: negative = bearish momentum, positive = bullish
  const histValue     = macd?.histogram ?? null;
  const histPct       = histValue !== null ? macdHistogramPct(histValue, price) : null;
  const histStrength  = macd?.strength ?? null;
  const histStrengthTier = macd?.strengthTier ?? null;
  const histNeg       = histValue !== null ? histValue < 0 : false;
  const histDetail = formatMacdHistDetail(histValue, histStrength, histStrengthTier);

  const candleUnderSnap = getCandleUnderSnapshot(candles5m);
  const candleUnderDetail = candleUnderSnap?.detail ?? 'need 3+ 5m bars';

  return {
    symbol,
    price,
    marketSession,
    macdHistogram: histValue,
    macdHistogramPct: histPct,
    macdHistogramStrength: histStrength,
    macdHistogramStrengthTier: histStrengthTier,
    buy: {
      up10pct:   { label: 'Stock up 10%+ on day?',     value: dayGainPct >= 10, detail: `${dayGainPct.toFixed(1)}%` },
      aboveVWAP: { label: 'Price above VWAP?',          value: price > vwap,     detail: `VWAP $${vwap?.toFixed(2)} (${vwapTag})` },
      ema9Up:    { label: '9 EMA sloping up (5-min)?', value: ema9Sloping,      detail: `EMA $${ema9?.toFixed(2)}` },
      volDry:    { label: 'Volume dried up?',           value: volDry,           detail: 'prev < 50% avg' },
      volSurge:  { label: 'Volume surge on candle?',    value: volSurge,         detail: 'cur > 150% avg' },
      pullback:  { label: 'Pullback ≤ 50% of move?',   value: pullback.valid,   detail: pullback.pct !== null ? `${pullback.pct.toFixed(0)}% retraced` : 'no pole found' },
    },
    sell: {
      belowVWAP:  { label: 'Price below VWAP?',             value: price < vwap,  detail: `VWAP $${vwap?.toFixed(2)} (${vwapTag})` },
      belowEMA9:  { label: 'Price below 9 EMA?',            value: price < ema9,  detail: `EMA $${ema9?.toFixed(2)}` },
      macdNeg:    { label: 'MACD histogram negative?',       value: histNeg,       detail: histDetail },
      candleUnder:{ label: 'Close below prior low?',         value: candleUnder,   detail: candleUnderDetail },
      toppingTail:{ label: 'Topping tail detected?',         value: toppingTail,   detail: 'wick > 60% range' },
      vwapBreak:  { label: 'VWAP break in consolidation?',   value: vwapBreak,     detail: 'cross below VWAP' },
    }
  };
}

// ── API ENDPOINTS ─────────────────────────────────────────────
app.get('/api/signals/:symbol', async (req, res) => {
  try {
    const signals = await buildSignals(req.params.symbol.toUpperCase());
    if (!signals) return res.status(503).json({ error: 'Insufficient data' });
    res.json(signals);
  } catch (err) {
    console.error('Signal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({ authenticated: !!accessToken });
});

app.use(express.static('public'));

// ── START ─────────────────────────────────────────────────────
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