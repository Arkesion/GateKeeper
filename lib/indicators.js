'use strict';
const {
  sortCandles,
  mergeCandleSources,
  inferSessionDayFromCandles,
  applyLiveQuoteToCandles,
  shouldPatchQuote,
  getEthDayBounds,
  getEthDayBoundsForDay,
  getEtDateString,
  stampBarEt
} = require('./session');

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

const MACD_WARMUP_MAX_BARS = 800;

function lastFiniteHist(arr) {
  if (!arr?.length) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (Number.isFinite(arr[i])) return arr[i];
  }
  return null;
}

/** MACD on up to 800 1m bars incl. prior days (TOS EMA warmup), quote-patched. */
function buildMacdCloseSeries(candleSources, quote, now = Date.now()) {
  const merged = mergeCandleSources(...candleSources);
  if (!merged.length) {
    const sessionDay = getEtDateString(now);
    const { ethStartMs, capEndMs } = getEthDayBoundsForDay(sessionDay, now);
    return { closes: [], bars: [], sessionDay, ethStartMs, capEndMs };
  }

  const sessionDay = inferSessionDayFromCandles(merged, now);
  const { ethStartMs, capEndMs } = getEthDayBoundsForDay(sessionDay, now);
  let bars = sortCandles(merged).slice(-MACD_WARMUP_MAX_BARS);
  if (quote) bars = applyLiveQuoteToCandles(bars, quote);

  const closes = bars.map(c => c.close).filter(Number.isFinite);
  return { closes, bars, sessionDay, ethStartMs, capEndMs };
}

/** Pick histogram at today's bar; forming=true aligns with TOS live Diff. */
function resolveMacdHistogram(histogram, bars, sessionDay, ethStartMs, capEndMs, now, forming = true) {
  if (!bars?.length || !histogram?.length) return null;

  const cap = Math.min(now, capEndMs);
  const todayBars = bars.filter(c => {
    stampBarEt(c);
    return c.etDate === sessionDay &&
      c.datetime >= ethStartMs &&
      c.datetime <= cap;
  });
  if (!todayBars.length) return lastFiniteHist(histogram);

  const target = forming
    ? todayBars[todayBars.length - 1]
    : getCompleted1mBars(todayBars).slice(-1)[0];
  if (!target) return lastFiniteHist(histogram);

  const idx = bars.findIndex(b => b.datetime === target.datetime);
  if (idx >= 0 && Number.isFinite(histogram[idx])) return histogram[idx];
  return lastFiniteHist(histogram);
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
  const { capEndMs } = getEthDayBounds(refMs);
  const startMs = pmCfg?.vwapStartMs ?? 0;
  candlesVwap = withVol.filter(c => {
    stampBarEt(c);
    return c.etDate === refDay &&
      c.datetime >= startMs &&
      c.datetime <= capEndMs;
  });
  if (quote && shouldPatchQuote(candlesVwap, quote, bucketMs)) {
    candlesVwap = applyLiveQuoteToCandles(candlesVwap, quote, bucketMs);
  }
  return { candlesVwap, vwapAnchor };
}
module.exports = {
  calcExpAverageTOS,
  calcMACDExactTOS,
  getCompleted1mBars,
  getIndicatorCloses,
  buildMacdCloseSeries,
  resolveMacdHistogram,
  calcVWAP,
  resolveVwapCandlesForCompute
};
