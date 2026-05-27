'use strict';
const {
  sortCandles,
  applyLiveQuoteToCandles,
  shouldPatchQuote,
  getEthDayBounds,
  getEtDateString
} = require('./session');

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
module.exports = {
  calcExpAverageTOS,
  calcMACDExactTOS,
  getCompleted1mBars,
  getIndicatorCloses,
  calcVWAP,
  resolveVwapCandlesForCompute
};
