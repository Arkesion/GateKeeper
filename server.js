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

async function getPriceHistory(symbol, periodType, period, frequencyType, frequency) {
  await ensureToken();
  const res = await axios.get(`${MARKET_DATA_URL}/pricehistory`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    params:  { symbol, periodType, period, frequencyType, frequency, needExtendedHoursData: false }
  });
  return res.data.candles || [];
}

// ── SIGNAL CALCULATIONS ───────────────────────────────────────

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
function calcMACD(candles) {
  if (candles.length < 9) return null;

  const closes = candles.map(c => c.close);
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
  console.log(
    `MACD line=${macdLine.toFixed(4)} signal=${signal.toFixed(4)} histogram=${histogram.toFixed(4)}`
  );

  return { line: macdLine, signal, histogram };
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

function checkCandleUnderCandle(candles) {
  if (candles.length < 2) return false;
  return candles[candles.length - 1].close < candles[candles.length - 2].low;
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
  const [quote, candles5m, candles1m] = await Promise.all([
    getQuote(symbol),
    getPriceHistory(symbol, 'day', 1, 'minute', 5),
    getPriceHistory(symbol, 'day', 1, 'minute', 1)
  ]);

  if (!quote || candles5m.length < 30) return null;

  const price      = quote.lastPrice;
  const prevClose  = quote.closePrice;
  const dayGainPct = ((price - prevClose) / prevClose) * 100;

  const vwap        = calcVWAP(candles5m);
  const ema9        = calcEMA(candles5m, 9);
  const ema9Sloping = calcEMASlope(candles5m, 9);
  const macd        = calcMACD(candles1m);
  const volDry      = checkVolumeDry(candles5m);
  const volSurge    = checkVolumeSurge(candles5m);
  const toppingTail = checkToppingTail(candles5m);
  const candleUnder = checkCandleUnderCandle(candles5m);
  const pullback    = checkPullback(candles5m);
  const vwapBreak   = checkVWAPBreakDuringConsolidation(candles5m, vwap);

  // Histogram: negative = bearish momentum, positive = bullish
  const histValue  = macd?.histogram ?? null;
  const histNeg    = histValue !== null ? histValue < 0 : false;
  const histDetail = histValue !== null
    ? `HIST ${histValue >= 0 ? '+' : ''}${(histValue / price * 10000).toFixed(2)}%`
    : 'insufficient data';

  const currClose = candles5m[candles5m.length - 1].close;
  const prevLow   = candles5m[candles5m.length - 2].low;

  return {
    symbol,
    price,
    buy: {
      up10pct:   { label: 'Stock up 10%+ on day?',     value: dayGainPct >= 10, detail: `${dayGainPct.toFixed(1)}%` },
      aboveVWAP: { label: 'Price above VWAP (5-min)?', value: price > vwap,     detail: `VWAP $${vwap?.toFixed(2)}` },
      ema9Up:    { label: '9 EMA sloping up (5-min)?', value: ema9Sloping,      detail: `EMA $${ema9?.toFixed(2)}` },
      volDry:    { label: 'Volume dried up?',           value: volDry,           detail: 'prev < 50% avg' },
      volSurge:  { label: 'Volume surge on candle?',    value: volSurge,         detail: 'cur > 150% avg' },
      pullback:  { label: 'Pullback ≤ 50% of move?',   value: pullback.valid,   detail: pullback.pct !== null ? `${pullback.pct.toFixed(0)}% retraced` : 'no pole found' },
    },
    sell: {
      belowVWAP:  { label: 'Price below VWAP?',             value: price < vwap,  detail: `VWAP $${vwap?.toFixed(2)}` },
      belowEMA9:  { label: 'Price below 9 EMA?',            value: price < ema9,  detail: `EMA $${ema9?.toFixed(2)}` },
      macdNeg:    { label: 'MACD histogram negative?',       value: histNeg,       detail: histDetail },
      candleUnder:{ label: 'Candle closed below prev low?',  value: candleUnder,   detail: `C $${currClose.toFixed(2)} < L $${prevLow.toFixed(2)}` },
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