'use strict';
const { SchwabError, ensureSchwabAuth } = require('./auth');
const { getQuote } = require('./schwab');
const {
  buildSession1mBars,
  buildIndicator1mBars,
  buildVwap1mBars,
  sessionLow,
  getMarketSession,
  getVwapConfig,
  vwapCfgForSessionBars,
  resolveVwapPackFrom1m,
  isQuoteValid,
  getSession1mCandles,
  getIndicator1mCandles,
  getDailyCandles,
  stampBars
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
  calcKeyLevels,
  computeFrontSideSignal,
  computeGivebackSignal,
  computeResistanceSignal,
  computeSupportSignal,
  trafficBanner,
  buildCalcHints,
  activeEvent,
  isHighVolumeSellBar,
  isLargeSellCandleBar,
  isToppingTailBar,
  macdGospelPositive,
  buildNotes,
  relativeVolume,
  rvolColor
} = require('./signals');
const { replaySetup } = require('./setup-machine');
const { applyMarket, failingChecks, loadSession } = require('./trades');
const { getAccountSnapshot } = require('./providers/webull-provider');
const { tapeSlowdown, tapeLog } = require('./tape');
const fs = require('fs');
const { quoteBidAskSpread, isSpreadAcceptable } = require('./schwab');
const { computeTradingStatus } = require('./halts');

const store = require('./store');
const { config } = store;
const { getProvider } = require('./providers');

const TICKER_SUGGESTIONS = config.tickerSuggestions;
const QUOTE_POLL_MS = config.quotePollMs;
const CANDLE_POLL_MS = config.candlePollMs;
const DAILY_CACHE_MS = config.dailyCacheMs;
const INDICATOR_1M_CACHE_MS = config.indicator1mCacheMs;
const MACD_MIN_BARS = config.macdMinBars;
const MACD_MIN_BARS_SPARSE = config.macdMinBarsSparse;
const SESSION_MIN_BARS = config.sessionMinBars;

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

  const { quote, candles1m: candles1mRaw, candles1mMacd, dailyCandles, quoteFetched, ticks } = cache;
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
  const front_side_macd = macdGospelPositive(macd_histogram_value);

  const completed1m = getCompleted1mBars(candles1mLive);
  let forming1m = null;
  if (candles1mLive.length >= 1) {
    forming1m = candles1mLive[candles1mLive.length - 1];
  }
  const eventBars = getCompleted1mBars(indicator1m);
  const indicatorLast = eventBars.length ? eventBars[eventBars.length - 1].datetime : null;
  let formingEvent = null;
  if (indicator1m.length) {
    const lastInd = [...indicator1m].sort((a, b) => a.datetime - b.datetime).at(-1);
    const done = eventBars.at(-1);
    if (!done || lastInd.datetime !== done.datetime) formingEvent = lastInd;
  }

  const hvSell = activeEvent(eventBars, isHighVolumeSellBar, now);
  const bigRed = activeEvent(eventBars, isLargeSellCandleBar, now, bar => bar.open);
  const toppingTail = activeEvent(eventBars, isToppingTailBar, now, bar => bar.high);
  const spread = quoteBidAskSpread(quote);
  const spread_ok = isSpreadAcceptable(quote);
  const front_side = {
    macd: front_side_macd,
    no_hv_sell: hvSell.phase !== 'fail',
    no_big_red: bigRed.phase !== 'fail',
    no_topping_tail: toppingTail.phase !== 'fail',
    spread_ok,
    hv_sell_phase: hvSell.phase,
    hv_sell_time: hvSell.time,
    hv_sell_age: hvSell.age_min,
    big_red_phase: bigRed.phase,
    big_red_time: bigRed.time,
    big_red_age: bigRed.age_min,
    topping_tail_phase: toppingTail.phase,
    topping_tail_time: toppingTail.time,
    topping_tail_age: toppingTail.age_min
  };
  const front_side_signal = computeFrontSideSignal(
    indicator1m, price, ema9_1m_value, ema20_1m_value
  );
  const momentum = { front_side: front_side_signal };
  const giveback = computeGivebackSignal(eventBars, price);
  computeTradingStatus(symbol, quote, now);

  const keyLevels = calcKeyLevels(session1m, dailyCandles, price, prevClose, ema9_1m_value, vwap, now);
  const level_signals = {
    resistance: computeResistanceSignal(price, dailyCandles, now),
    support: computeSupportSignal(
      price, keyLevels.key_level_down, completed1m, forming1m
    )
  };

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
  const notes = buildNotes(eventBars, {
    vwap,
    ema9: ema9_1m_value,
    ema20: ema20_1m_value,
    support: keyLevels.key_level_down?.price,
    resistance: keyLevels.key_level_up?.price
  });
  const noteBarMs = eventBars.length ? eventBars[eventBars.length - 1].datetime : null;
  const eventsStale = eventsAreStale(noteBarMs, indicatorLast);
  const rvol = relativeVolume(dailyCandles, session1m, now);
  const setup = replaySetup(eventBars, {
    forming: formingEvent,
    lastPrice: price,
    printMs: Number.isFinite(Number(quote.lastPrintAt)) ? Number(quote.lastPrintAt) : null
  });
  const tape = tapeSlowdown(ticks, now, setup?.surge_at, config.tapeSlowdownRatio);
  if (tape) {
    notes.unshift({
      side: 'NEUTRAL',
      time: null,
      text: tape.text,
      hover: tape.hover,
      caution: true
    });
  }

  const lastPrintAt = Number(quote.lastPrintAt);

  return {
    status: 'ok',
    symbol,
    last_print_at: Number.isFinite(lastPrintAt) ? lastPrintAt : null,
    traffic_light_raw,
    front_side,
    momentum,
    giveback,
    notes,
    tape,
    events_stale: eventsStale,
    setup,
    entry_bar_low: eventBars.length ? eventBars[eventBars.length - 1].low : null,
    context: {
      price: round2(price),
      day_change_pct: Number.isFinite(prevClose) && prevClose !== 0
        ? round2(((price - prevClose) / prevClose) * 100)
        : null,
      vwap_value: vwap != null ? round2(vwap) : null,
      bid_ask_spread: spread != null ? round2(spread) : null,
      ema9_1m_value: round2(ema9_1m_value),
      ema20_1m_value: round2(ema20_1m_value),
      macd_histogram_value,
      key_level_up: keyLevels.key_level_up,
      key_level_down: keyLevels.key_level_down,
      session_high: keyLevels.session_high,
      session_low: sessionLow(vwap1m),
      rvol: Number.isFinite(rvol) ? Math.round(rvol * 10) / 10 : null,
      rvol_color: rvolColor(rvol),
      daily_resistance: level_signals.resistance?.level_price != null ? {
        price: level_signals.resistance.level_price,
        pct: level_signals.resistance.distance_pct,
        label: level_signals.resistance.distance_label,
        near: level_signals.resistance.state === 'red'
      } : null,
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

const TICK_RECOMPUTE_MS = 250;
const lastTickRecompute = new Map();
const tickRecomputeTimer = new Map();

function recomputeNow(symbol) {
  const pending = tickRecomputeTimer.get(symbol);
  if (pending) {
    clearTimeout(pending);
    tickRecomputeTimer.delete(symbol);
  }
  lastTickRecompute.set(symbol, Date.now());
  recomputeAndCacheState(symbol);
}

function scheduleTickRecompute(symbol) {
  const now = Date.now();
  const earliest = (lastTickRecompute.get(symbol) || 0) + TICK_RECOMPUTE_MS;
  if (now >= earliest) {
    lastTickRecompute.set(symbol, now);
    recomputeAndCacheState(symbol);
    return;
  }
  if (tickRecomputeTimer.has(symbol)) return;
  const timer = setTimeout(() => {
    tickRecomputeTimer.delete(symbol);
    lastTickRecompute.set(symbol, Date.now());
    if (symbol === store.activeSymbol) recomputeAndCacheState(symbol);
  }, earliest - now);
  if (typeof timer.unref === 'function') timer.unref();
  tickRecomputeTimer.set(symbol, timer);
}

const loggedSetup = new Set();
const signalSeen = new Map();

function eventsAreStale(noteBarMs, indicatorBarMs) {
  const note = Number(noteBarMs);
  const indicator = Number(indicatorBarMs);
  if (!Number.isFinite(note) || !Number.isFinite(indicator)) return false;
  return indicator - note > 2 * 60 * 1000;
}

function signalLogPath() {
  return process.env.SIGNAL_LOG || '/data/signal.log';
}

function writeSignal(row) {
  try {
    fs.appendFileSync(signalLogPath(), JSON.stringify(row) + '\n');
  } catch {
    // A missing log path must not stop the state refresh.
  }
}

function chipRows(state) {
  const front = state.front_side || {};
  const giveback = state.giveback || {};
  return [
    { name: 'macd', phase: front.macd === false ? 'fail' : 'pass', time: null },
    { name: 'hv_sell', phase: front.hv_sell_phase || 'pass', time: front.hv_sell_time || null },
    { name: 'big_red', phase: front.big_red_phase || 'pass', time: front.big_red_time || null },
    { name: 'tail', phase: front.topping_tail_phase || 'pass', time: front.topping_tail_time || null },
    { name: 'spread', phase: front.spread_ok === false ? 'fail' : 'pass', time: null },
    { name: 'giveback', phase: giveback.state || null, time: null }
  ];
}

function logSignalState(symbol, state, verdict) {
  const stamp = new Date().toISOString();
  const prior = signalSeen.get(symbol) || { chips: new Set(), notes: new Set(), setup: null, tape: '' };
  const first = !signalSeen.has(symbol);
  const chips = chipRows(state);
  const notes = state.notes || [];
  const setup = state.setup || {};
  const setupKey = `${setup.state}|${setup.reason}|${setup.trigger}|${setup.stop}`;
  if (first || prior.setup !== setupKey) {
    writeSignal({
      kind: 'setup',
      t: stamp,
      symbol,
      state: setup.state || null,
      reason: setup.reason || null,
      trigger: setup.trigger ?? null,
      stop: setup.stop ?? null,
      verdict: verdict || null
    });
  }
  for (const chip of chips) {
    const key = `${chip.name}|${chip.phase}|${chip.time}`;
    if (!first && prior.chips.has(key)) continue;
    writeSignal({ kind: 'chip', t: stamp, symbol, name: chip.name, phase: chip.phase, time: chip.time, verdict: verdict || null });
    prior.chips.add(key);
  }
  for (const note of notes) {
    const key = `${note.time}|${note.side}|${note.text}`;
    if (!first && prior.notes.has(key)) continue;
    writeSignal({ kind: 'note', t: stamp, symbol, time: note.time || null, side: note.side || null, text: note.text || null });
    prior.notes.add(key);
  }
  const tapeKey = state.tape ? String(state.tape.pct) : '';
  if (state.tape && (first || prior.tape !== tapeKey)) {
    writeSignal({ kind: 'tape_slowdown', t: stamp, symbol, ...tapeLog(state.tape) });
  }
  prior.tape = tapeKey;
  prior.setup = setupKey;
  signalSeen.set(symbol, prior);
  logSetupTransitions(symbol, setup, verdict);
}

function logSetupTransitions(symbol, setup, verdict) {
  if (!setup?.transitions?.length) return;
  const latest = setup.latest_bar;
  for (const step of setup.transitions) {
    if (step.at !== latest && !step.live) continue;
    const key = `${symbol}|${step.at}|${step.from}|${step.to}`;
    if (loggedSetup.has(key)) continue;
    loggedSetup.add(key);
    writeSignal({
      kind: 'setup_transition',
      t: new Date(step.at).toISOString(),
      symbol,
      from: step.from,
      to: step.to,
      trigger: step.trigger ?? null,
      stop: step.stop ?? null,
      reason: step.reason || null,
      verdict: verdict || null
    });
  }
}

function resetSignalLog() {
  loggedSetup.clear();
  signalSeen.clear();
}

function recomputeAndCacheState(symbol) {
  if (symbol !== store.activeSymbol) return;
  const started = Date.now();
  try {
    const state = computeStateFromCache(symbol);
    const elapsed = Date.now() - started;
    if (elapsed > 200) {
      const bars = state?.detail?.raw_bars;
      const barNote = Number.isFinite(bars) ? ` bars=${bars}` : '';
      process.stderr.write(
        `state recompute ${symbol} ${elapsed}ms status=${state?.status || 'unknown'}${barNote}\n`
      );
    }
    if (state.status === 'insufficient_data' || state.status === 'invalid_symbol') {
      store.responseCache[symbol] = state;
      return;
    }
    if (state.status === 'ok') {
      const { traffic_light_raw, ...statePublic } = state;
      const confirmed = updateTrafficLightConfirmed(symbol, traffic_light_raw);
      logSignalState(symbol, state, confirmed);
      if (statePublic.setup) {
        const rest = { ...statePublic.setup };
        delete rest.frames;
        delete rest.transitions;
        delete rest.latest_bar;
        statePublic.setup = rest;
      }
      const account = getAccountSnapshot();
      const book = applyMarket({
        symbol,
        price: state.context?.price,
        now: Date.now(),
        setup: state.setup,
        lastBarLow: state.entry_bar_low,
        failing: failingChecks(state.front_side, state.momentum, state.giveback),
        account
      });
      delete statePublic.entry_bar_low;
      store.responseCache[symbol] = {
        ...statePublic,
        ...book,
        orders_stream: account?.ordersStream || null,
        positions_poll_at: account?.positionsPollAt || null,
        open_positions: account?.openPositions ?? null,
        provider: config.marketDataProvider,
        market_session: getMarketSession(Date.now()),
        traffic_light_confirmed: confirmed
      };
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
    stampBars(update.bars);
    entry.candles1m = update.bars;
    entry.candles1mMacd = update.bars;
  }
  if (Array.isArray(update.ticks)) entry.ticks = update.ticks;
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
  if (symbol === store.activeSymbol) {
    if (update.immediate) recomputeNow(symbol);
    else scheduleTickRecompute(symbol);
  }
}

function isDataStale() {
  return getProvider().isDataStale();
}

async function isStreamTaken() {
  const provider = getProvider();
  if (typeof provider.getStreamStatus !== 'function') return false;
  return (await provider.getStreamStatus()) === 'stream_taken';
}

async function ensureDailyVolume(symbol) {
  const provider = getProvider();
  if (typeof provider.ensureDaily !== 'function') return;
  const { getEtDateString } = require('./session');
  const today = getEtDateString(Date.now());
  const entry = store.marketDataCache[symbol] || {};
  if (entry.dailyVolumeDay === today && Array.isArray(entry.dailyCandles)) return;
  const bars = await provider.ensureDaily(symbol);
  if (!store.marketDataCache[symbol]) store.marketDataCache[symbol] = {};
  store.marketDataCache[symbol].dailyCandles = bars;
  store.marketDataCache[symbol].dailyVolumeDay = today;
  if (symbol === store.activeSymbol) recomputeNow(symbol);
}

async function releaseSymbol(symbol) {
  symbol = String(symbol || '').toUpperCase();
  if (!symbol) return { ok: false, status: 400 };
  const session = loadSession(Date.now());
  if (session.open && String(session.open.symbol || '').toUpperCase() === symbol) {
    return { ok: false, status: 409, error: 'open position' };
  }
  delete store.marketDataCache[symbol];
  delete store.responseCache[symbol];
  if (config.marketDataProvider === 'webull') {
    const provider = getProvider();
    if (typeof provider.unstream === 'function') await provider.unstream(symbol);
  } else if (store.activeSymbol === symbol) {
    stopSymbolRefresh();
    store.activeSymbol = '';
  }
  return { ok: true };
}

async function setActiveSymbol(symbol) {
  if (config.marketDataProvider === 'webull') {
    store.activeSymbol = symbol;
    if (!symbol) return;
    await getProvider().stream(symbol);
    ensureDailyVolume(symbol).catch(err => {
      console.warn(`Daily volume (${symbol}):`, err.message);
    });
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
  eventsAreStale,
  logSignalState,
  resetSignalLog,
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
  releaseSymbol,
  setActiveSymbol,
  triggerMinuteEdgeRefresh
};
