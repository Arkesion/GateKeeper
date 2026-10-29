'use strict';
const { SchwabError, ensureSchwabAuth } = require('./auth');
const { getQuote } = require('./schwab');
const {
  buildSession1mBars,
  buildIndicator1mBars,
  buildVwap1mBars,
  getVwapConfig,
  vwapCfgForSessionBars,
  resolveVwapPackFrom1m,
  isQuoteValid,
  getSession1mCandles,
  getIndicator1mCandles,
  getDailyCandles
} = require('./session');
const {
  calcExpAverageTOS,
  calcMACDExactTOS,
  getCompleted1mBars,
  getIndicatorCloses,
  buildMacdCloseSeries,
  resolveMacdHistogram,
  calcVWAP,
  resolveVwapCandlesForCompute
} = require('./indicators');
const {
  round2,
  lastFinite,
  contextMarketSession,
  calcKeyLevels,
  computeFrontSideSignal,
  computeGivebackSignal,
  computeWarnings,
  computeResistanceSignal,
  computeSupportSignal,
  mergeLevelWarnings,
  trafficBanner,
  minuteClosePulseFromBars,
  buildCalcHints,
  hasHighVolSellInLookback
} = require('./signals');
const { quoteBidAskSpread, isSpreadAcceptable } = require('./schwab');
const { computeTradingStatus } = require('./halts');

const store = require('./store');
const { config } = store;
const { getProvider } = require('./providers');

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

function updateTrafficLightConfirmed(symbol, raw) {
  let entry = store.stateCache[symbol];
  if (!entry || entry.confirmed == null) {
    store.stateCache[symbol] = { confirmed: raw, pending: null, pending_count: 0 };
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
  const cache = store.marketDataCache[symbol];
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
  const macdSeries = buildMacdCloseSeries(sources, quote, now);

  if (session1m.length < MACD_MIN_BARS || closesInd.length < MACD_MIN_BARS) {
    console.warn(
      `[${symbol}] session=${session1m.length} indicator=${indicator1m.length} closes=${closesInd.length} raw=${candles1mRaw?.length ?? 0}`
    );
  }

  const pmCfg = getVwapConfig(now);
  const vwap1m = buildVwap1mBars(sources, quote, now);
  const vwapCfg = vwapCfgForSessionBars(vwap1m, pmCfg, now);
  let { vwapPack, vwapAnchor } = resolveVwapPackFrom1m(vwap1m, vwapCfg, now);

  const missing = [];
  if (!quote?.lastPrice || !Number.isFinite(quote.lastPrice)) {
    missing.push('quote');
  }

  if (session1m.length < SESSION_MIN_BARS) missing.push('1m_candles');
  const macdFloor = macdSeries.closes.length >= MACD_MIN_BARS ? MACD_MIN_BARS : MACD_MIN_BARS_SPARSE;
  if (macdSeries.closes.length < macdFloor) missing.push('1m_candles');

  const insufficientDetail = {
    session_bars: session1m.length,
    indicator_bars: indicator1m.length,
    raw_bars: candles1mRaw?.length ?? 0,
    required_session_bars: SESSION_MIN_BARS,
    required_indicator_bars: MACD_MIN_BARS
  };

  const vwapResolve = resolveVwapCandlesForCompute(
    vwap1m, quote, pmCfg, vwapPack, vwapAnchor
  );
  const candlesVwap = vwapResolve.candlesVwap;
  vwapAnchor = vwapResolve.vwapAnchor;

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

  const { histogram: histWarmup } = calcMACDExactTOS(macdSeries.closes);
  const macd_histogram_value = resolveMacdHistogram(
    histWarmup, macdSeries.bars, macdSeries.sessionDay, macdSeries.ethStartMs, macdSeries.capEndMs, now, true
  );

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
  if (candles1mLive.length >= 1) {
    forming1m = candles1mLive[candles1mLive.length - 1];
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
  const giveback = computeGivebackSignal(session1m, price);
  const warningResult = computeWarnings(candles1mLive, completedInd, now);

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
    candles1m: indicator1m, momentum,
    giveback,
    front_side,
    macdBarCount: session1m.length,
    keyLevels,
    level_signals,
    quote,
    now
  });

  const traffic_light_raw = trafficBanner(front_side, level_signals, momentum, giveback);

  const lastPrintAt = Number(quote.lastPrintAt);

  return {
    status: 'ok',
    symbol,
    last_print_at: Number.isFinite(lastPrintAt) ? lastPrintAt : null,
    traffic_light_raw,
    front_side,
    momentum,
    giveback,
    level_signals,
    warnings: warningResult.codes,
    warning_bars: warningResult.bars,
    context: {
      price: round2(price),
      day_change_pct: Number.isFinite(prevClose) && prevClose !== 0
        ? round2(((price - prevClose) / prevClose) * 100)
        : null,
      vwap_value: vwap != null ? round2(vwap) : null,
      vwap_delta_dollars: vwap != null ? round2(vwapDeltaDollars) : null,
      vwap_delta_pct: vwap != null ? round2(vwapDeltaPct) : null,
      bid_ask_spread: spread != null ? round2(spread) : null,
      ema9_1m_value: round2(ema9_1m_value),
      ema20_1m_value: round2(ema20_1m_value),
      macd_histogram_value,
      key_level_up: keyLevels.key_level_up,
      key_level_down: keyLevels.key_level_down,
      market_session: contextMarketSession(now),
      trading_status: tradingStatus,
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
      store.responseCache[symbol] = { status: 'auth_failed' };
      return;
    }
    if (err.code === 'rate_limited') {
      store.responseCache[symbol] = { status: 'rate_limited' };
      return;
    }
  }
  const detail = err.status ? `${err.message} (${err.status})` : err.message;
  console.error(`Refresh error (${symbol}):`, detail);
}

function recomputeAndCacheState(symbol) {
  if (symbol !== store.activeSymbol) return;
  try {
    const state = computeStateFromCache(symbol);
    if (state.status === 'insufficient_data' || state.status === 'invalid_symbol') {
      store.responseCache[symbol] = state;
      return;
    }
    if (state.status === 'ok') {
      const { traffic_light_raw, ...statePublic } = state;
      const confirmed = updateTrafficLightConfirmed(symbol, traffic_light_raw);
      store.responseCache[symbol] = { ...statePublic, traffic_light_confirmed: confirmed };
    }
  } catch (err) {
    cacheRefreshError(symbol, err);
  }
}

async function refreshQuote(symbol) {
  if (symbol !== store.activeSymbol) return;
  if (store.refreshInFlight.quote) return;
  store.refreshInFlight.quote = true;
  try {
    if (!(await ensureSchwabAuth())) return;
    const quote = await getQuote(symbol);
    if (symbol !== store.activeSymbol) return;
    if (!store.marketDataCache[symbol]) store.marketDataCache[symbol] = {};
    store.marketDataCache[symbol].quoteFetched = true;
    store.marketDataCache[symbol].quote = isQuoteValid(quote) ? quote : null;
    recomputeAndCacheState(symbol);
  } catch (err) {
    cacheRefreshError(symbol, err);
  } finally {
    store.refreshInFlight.quote = false;
  }
}

async function refreshCandles(symbol) {
  if (symbol !== store.activeSymbol) return;
  if (store.refreshInFlight.candles) return;
  store.refreshInFlight.candles = true;
  try {
    if (!(await ensureSchwabAuth())) return;
    const entry = store.marketDataCache[symbol] || {};
    const needDaily = !entry.dailyCandles || Date.now() - (entry.dailyFetchedAt || 0) > DAILY_CACHE_MS;
    const needInd = !entry.candles1mMacd || Date.now() - (entry.candles1mMacdFetchedAt || 0) > INDICATOR_1M_CACHE_MS;

    const [candles1m, candles1mMacd] = await Promise.all([
      getSession1mCandles(symbol),
      needInd ? getIndicator1mCandles(symbol) : Promise.resolve(entry.candles1mMacd)
    ]);
    if (symbol !== store.activeSymbol) return;
    if (!store.marketDataCache[symbol]) store.marketDataCache[symbol] = {};
    store.marketDataCache[symbol].candles1m = candles1m;
    if (needInd && candles1mMacd) {
      store.marketDataCache[symbol].candles1mMacd = candles1mMacd;
      store.marketDataCache[symbol].candles1mMacdFetchedAt = Date.now();
    }

    if (needDaily) {
      try {
        const dailyCandles = await getDailyCandles(symbol);
        if (symbol !== store.activeSymbol) return;
        store.marketDataCache[symbol].dailyCandles = dailyCandles;
        store.marketDataCache[symbol].dailyFetchedAt = Date.now();
      } catch (err) {
        console.warn(`Daily history failed (${symbol}):`, err.message);
      }
    }

    recomputeAndCacheState(symbol);
  } catch (err) {
    cacheRefreshError(symbol, err);
  } finally {
    store.refreshInFlight.candles = false;
  }
}

function stopSymbolRefresh() {
  if (store.refreshTimers.quote) {
    clearInterval(store.refreshTimers.quote);
    store.refreshTimers.quote = null;
  }
  if (store.refreshTimers.candles) {
    clearInterval(store.refreshTimers.candles);
    store.refreshTimers.candles = null;
  }
  store.refreshInFlight.quote = false;
  store.refreshInFlight.candles = false;
}

function startSymbolRefresh(symbol) {
  stopSymbolRefresh();
  refreshQuote(symbol);
  refreshCandles(symbol);
  store.refreshTimers.quote = setInterval(() => refreshQuote(symbol), QUOTE_POLL_MS);
  store.refreshTimers.candles = setInterval(() => refreshCandles(symbol), CANDLE_POLL_MS);
}

function applyMarketData(symbol, update) {
  if (!store.marketDataCache[symbol]) store.marketDataCache[symbol] = {};
  const entry = store.marketDataCache[symbol];
  if (update.bars) {
    entry.candles1m = update.bars;
    entry.candles1mMacd = update.bars;
  }
  if (update.quote && Number.isFinite(Number(update.quote.lastPrice))) {
    const quote = update.quote;
    entry.quote = {
      ...quote,
      lastPrice: Number(quote.lastPrice),
      closePrice: quote.closePrice == null ? null : Number(quote.closePrice),
      bidPrice: quote.bidPrice == null ? null : Number(quote.bidPrice),
      askPrice: quote.askPrice == null ? null : Number(quote.askPrice)
    };
    entry.quoteFetched = true;
  }
  if (symbol === store.activeSymbol) recomputeAndCacheState(symbol);
}

function isDataStale() {
  return getProvider().isDataStale();
}

async function isStreamTaken() {
  const provider = getProvider();
  if (typeof provider.getStreamStatus !== 'function') return false;
  return (await provider.getStreamStatus()) === 'stream_taken';
}

async function setActiveSymbol(symbol) {
  if (config.marketDataProvider === 'webull') {
    store.activeSymbol = symbol;
    if (!symbol) return;
    await getProvider().stream(symbol);
    return;
  }
  if (store.activeSymbol === symbol) return;
  store.activeSymbol = symbol;
  if (!symbol) {
    stopSymbolRefresh();
    return;
  }
  await getProvider().stream(symbol);
}

function triggerMinuteEdgeRefresh(symbol) {
  if (config.marketDataProvider === 'webull') return;
  if (!symbol) return;
  const { getEtSecond, getEtHourMinute, getEtDateString } = require('./session');
  const now = Date.now();
  if (getEtSecond(now) > 3) return;
  const { h, m } = getEtHourMinute(now);
  const edgeKey = `${getEtDateString(now)}T${h}:${String(m).padStart(2, '0')}`;
  if (!store.marketDataCache[symbol]) store.marketDataCache[symbol] = {};
  if (store.marketDataCache[symbol].minuteEdgeKey === edgeKey) return;
  store.marketDataCache[symbol].minuteEdgeKey = edgeKey;
  refreshQuote(symbol);
  refreshCandles(symbol);
}

module.exports = {
  updateTrafficLightConfirmed,
  computeStateFromCache,
  cacheRefreshError,
  recomputeAndCacheState,
  refreshQuote,
  refreshCandles,
  stopSymbolRefresh,
  startSymbolRefresh,
  applyMarketData,
  isDataStale,
  isStreamTaken,
  setActiveSymbol,
  triggerMinuteEdgeRefresh
};
