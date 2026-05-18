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

// Step 1: Login redirect
app.get('/login', (req, res) => {
  const authUrl = `${SCHWAB_AUTH_URL}?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(authUrl);
});

// Step 2: Schwab redirects back here with auth code
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('No auth code received.');

  try {
    const response = await axios.post(SCHWAB_TOKEN_URL,
      new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: redirectUri
      }),
      {
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type':  'application/x-www-form-urlencoded'
        }
      }
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

// Refresh token if expired
async function ensureToken() {
  if (!accessToken) throw new Error('Not authenticated');
  if (Date.now() < tokenExpiry - 60000) return;

  const response = await axios.post(SCHWAB_TOKEN_URL,
    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken
    }),
    {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type':  'application/x-www-form-urlencoded'
      }
    }
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
function calcEMA(candles, period) {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
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
  const prev   = candles.slice(0, -1);
  const emaNow  = calcEMA(candles, period);
  const emaPrev = calcEMA(prev, period);
  return emaNow > emaPrev;
}

function calcMACD(candles) {
  if (candles.length < 26) return null;
  const ema12 = calcEMA(candles, 12);
  const ema26 = calcEMA(candles, 26);
  return ema12 - ema26;
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
  const upperWick = c.high - c.close;
  return (upperWick / range) > 0.6;
}

function checkCandleUnderCandle(candles) {
  if (candles.length < 2) return false;
  const curr = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  return curr.close < prev.low;
}

// Pullback ≤ 50% of prior move (Bull Flag / Micro Pullback)
// Looks back up to 10 candles for the pole high, then measures the pullback
function checkPullback(candles) {
  if (candles.length < 5) return { valid: false, pct: null };

  const recent = candles.slice(-10);

  // Find the highest high in the recent window (pole top)
  let poleHighIdx = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].high > recent[poleHighIdx].high) poleHighIdx = i;
  }

  // Need at least one candle before and after the high
  if (poleHighIdx === 0 || poleHighIdx === recent.length - 1) {
    return { valid: false, pct: null };
  }

  // Pole bottom: lowest low before the pole high
  const beforePole = recent.slice(0, poleHighIdx);
  const poleBottom = Math.min(...beforePole.map(c => c.low));
  const poleTop    = recent[poleHighIdx].high;
  const poleSize   = poleTop - poleBottom;

  if (poleSize <= 0) return { valid: false, pct: null };

  // Pullback: lowest low after the pole high to current price
  const afterPole    = recent.slice(poleHighIdx + 1);
  const pullbackLow  = Math.min(...afterPole.map(c => c.low));
  const pullbackSize = poleTop - pullbackLow;
  const pullbackPct  = (pullbackSize / poleSize) * 100;

  return {
    valid: pullbackPct <= 50,
    pct:   pullbackPct
  };
}

// VWAP break during consolidation
// Detects if price crossed below VWAP within the last 5 candles while consolidating
function checkVWAPBreakDuringConsolidation(candles, vwap) {
  if (candles.length < 6) return false;

  const window = candles.slice(-6, -1); // last 5 completed candles

  // Consolidation: candles not swinging wildly — range < 3% of price
  const avgClose = window.reduce((s, c) => s + c.close, 0) / window.length;
  const maxHigh  = Math.max(...window.map(c => c.high));
  const minLow   = Math.min(...window.map(c => c.low));
  const swing    = (maxHigh - minLow) / avgClose;
  const isConsolidating = swing < 0.03;

  if (!isConsolidating) return false;

  // Any candle in the window closed below VWAP
  return window.some(c => c.close < vwap);
}

async function buildSignals(symbol) {
  const [quote, candles5m] = await Promise.all([
    getQuote(symbol),
    getPriceHistory(symbol, 'day', 1, 'minute', 5)
  ]);

  if (!quote || candles5m.length < 30) return null;

  const price      = quote.lastPrice;
  const openPrice  = quote.openPrice;
  const dayGainPct = ((price - openPrice) / openPrice) * 100;

  const vwap        = calcVWAP(candles5m);
  const ema9        = calcEMA(candles5m, 9);
  const ema9Sloping = calcEMASlope(candles5m, 9);
  const macd        = calcMACD(candles5m);
  const volDry      = checkVolumeDry(candles5m);
  const volSurge    = checkVolumeSurge(candles5m);
  const toppingTail = checkToppingTail(candles5m);
  const candleUnder = checkCandleUnderCandle(candles5m);
  const pullback    = checkPullback(candles5m);
  const vwapBreak   = checkVWAPBreakDuringConsolidation(candles5m, vwap);

  return {
    symbol,
    price,
    buy: {
      up10pct:   { label: 'Stock up 10%+ on day?',     value: dayGainPct >= 10,  detail: `${dayGainPct.toFixed(1)}%` },
      aboveVWAP: { label: 'Price above VWAP (5-min)?', value: price > vwap,      detail: `VWAP $${vwap?.toFixed(2)}` },
      ema9Up:    { label: '9 EMA sloping up (5-min)?', value: ema9Sloping,       detail: `EMA $${ema9?.toFixed(2)}` },
      volDry:    { label: 'Volume dried up?',           value: volDry,            detail: 'prev < 50% avg' },
      volSurge:  { label: 'Volume surge on candle?',    value: volSurge,          detail: 'cur > 150% avg' },
      pullback:  { label: 'Pullback ≤ 50% of move?',   value: pullback.valid,    detail: pullback.pct !== null ? `${pullback.pct.toFixed(0)}% retraced` : 'no pole found' },
    },
    sell: {
      belowVWAP:  { label: 'Price below VWAP?',             value: price < vwap,   detail: `VWAP $${vwap?.toFixed(2)}` },
      belowEMA9:  { label: 'Price below 9 EMA?',            value: price < ema9,   detail: `EMA $${ema9?.toFixed(2)}` },
      macdNeg:    { label: 'MACD negative?',                 value: macd < 0,       detail: `MACD ${macd?.toFixed(3)}` },
      candleUnder:{ label: 'Candle closed below prev low?',  value: candleUnder,    detail: 'exit signal' },
      toppingTail:{ label: 'Topping tail detected?',         value: toppingTail,    detail: 'wick > 60% range' },
      vwapBreak:  { label: 'VWAP break in consolidation?',   value: vwapBreak,      detail: 'cross below VWAP' },
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