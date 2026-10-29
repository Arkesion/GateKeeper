'use strict';
const { getPriceHistory } = require('./schwab');

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

const NY_TZ = 'America/New_York';

const etFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function etParts(ms) {
  const parts = etFormatter.formatToParts(new Date(ms));
  const get = type => parts.find(part => part.type === type).value;
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    minute: Number(get('minute')),
    second: Number(get('second'))
  };
}

function getEtDateString(ms) {
  return etParts(ms).date;
}

function getEtHourMinute(ms) {
  const parts = etParts(ms);
  return { h: parts.hour, m: parts.minute };
}

function getEtSecond(ms) {
  return etParts(ms).second;
}

function stampBarEt(bar) {
  if (!bar || bar.datetime == null) return bar;
  if (bar.etStamp === bar.datetime && bar.etDate != null && bar.etMinute != null) return bar;
  const parts = etParts(bar.datetime);
  bar.etDate = parts.date;
  bar.etMinute = parts.hour * 60 + parts.minute;
  bar.etStamp = bar.datetime;
  return bar;
}

function stampBars(bars) {
  if (!bars) return bars;
  for (const bar of bars) stampBarEt(bar);
  return bars;
}

function nthSunday(year, monthIndex, n) {
  const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  return 1 + ((7 - firstWeekday) % 7) + (n - 1) * 7;
}

/** Minutes to add to an Eastern wall clock to reach UTC. Keyed by the civil date. */
function etOffsetMinutes(year, month, day, hour, minute) {
  const startDay = nthSunday(year, 2, 2);
  const endDay = nthSunday(year, 10, 1);
  const mins = hour * 60 + minute;
  const afterStart = month > 3 ||
    (month === 3 && (day > startDay || (day === startDay && mins >= 3 * 60)));
  const beforeEnd = month < 11 ||
    (month === 11 && (day < endDay || (day === endDay && mins < 2 * 60)));
  return afterStart && beforeEnd ? 4 * 60 : 5 * 60;
}

function etToUtc(dateStr, hour, minute) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const offset = etOffsetMinutes(year, month, day, hour, minute);
  return Date.UTC(year, month - 1, day, hour, minute + offset);
}

const boundsByDate = new Map();

function boundsForDate(dateStr) {
  const hit = boundsByDate.get(dateStr);
  if (hit) return hit;
  const bounds = {
    ethStartMs: etToUtc(dateStr, 4, 0),
    rthOpenMs: etToUtc(dateStr, 9, 30),
    rthCloseMs: etToUtc(dateStr, 16, 0),
    ethEndMs: etToUtc(dateStr, 20, 0)
  };
  boundsByDate.set(dateStr, bounds);
  return bounds;
}

function utcFromEtDateTime(dateStr, hour, minute) {
  const bounds = boundsForDate(dateStr);
  if (hour === 4 && minute === 0) return bounds.ethStartMs;
  if (hour === 9 && minute === 30) return bounds.rthOpenMs;
  if (hour === 16 && minute === 0) return bounds.rthCloseMs;
  if (hour === 20 && minute === 0) return bounds.ethEndMs;
  const key = `${hour}:${minute}`;
  if (!bounds.extra) bounds.extra = new Map();
  const cached = bounds.extra.get(key);
  if (cached != null) return cached;
  const utc = etToUtc(dateStr, hour, minute);
  bounds.extra.set(key, utc);
  return utc;
}

/** First few seconds of each ET minute: pull quote + 1m so :00 flash has fresh bar. */
function triggerMinuteEdgeRefresh(symbol) {
  if (!symbol) return;
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
      if (c?.datetime == null) continue;
      stampBarEt(c);
      map.set(c.datetime, c);
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
  const onClockToday = sorted.filter(c => {
    stampBarEt(c);
    return c.etDate === todayStr &&
      c.datetime >= ethStartMs &&
      c.datetime <= cap;
  });
  if (onClockToday.length > 0) return todayStr;
  return stampBarEt(sorted[sorted.length - 1]).etDate;
}

function filterSessionDayBars(candles, sessionDay, now = Date.now()) {
  if (!candles?.length) return [];
  const sorted = sortCandles(candles);
  const { ethStartMs, capEndMs } = getEthDayBoundsForDay(sessionDay, now);
  const cap = Math.min(now, capEndMs);
  let bars = sorted.filter(c => {
    stampBarEt(c);
    return c.etDate === sessionDay &&
      c.datetime >= ethStartMs &&
      c.datetime <= cap;
  });
  if (bars.length < 26) {
    bars = sorted.filter(c => {
      stampBarEt(c);
      return c.etDate === sessionDay &&
        c.datetime >= ethStartMs &&
        c.datetime <= capEndMs;
    });
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
  const revertedToFull = bars.length >= MACD_MIN_BARS && pick.length < MACD_MIN_BARS;
  if (revertedToFull) return bars;
  return pick;
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

/**
 * 1m bars for VWAP — full ETH session from 4:00 AM ET (TOS VWAP 0,0,DAY).
 * No gap trim: excluding pre-gap volume raises VWAP vs TOS on gap-up names.
 */
function buildVwap1mBars(candleSources, quote, now = Date.now()) {
  const merged = mergeCandleSources(...candleSources);
  if (!merged.length) return [];

  const sessionDay = inferSessionDayFromCandles(merged, now);
  let bars = filterSessionDayBars(merged, sessionDay, now);

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

  const onToday = c => {
    stampBarEt(c);
    return c.etDate === today;
  };
  const inMins = (c, lo, hi) => {
    stampBarEt(c);
    return c.etMinute >= lo && c.etMinute < hi;
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
    filterCandle: c => {
      stampBarEt(c);
      return c.etDate === bounds.today &&
        c.datetime >= bounds.ethStartMs &&
        c.datetime <= bounds.capEndMs;
    }
  };
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
  return stampBarEt(sorted[sorted.length - 1]).etDate;
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
    filterCandle: c => {
      stampBarEt(c);
      return c.etDate === sessionDay &&
        c.datetime >= ethStartMs &&
        c.datetime <= cap;
    }
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

/** Daily bars for key levels (prior session HOD/LOD); cached per symbol. */
async function getDailyCandles(symbol) {
  return getPriceHistory(symbol, 'month', 2, 'daily', 1, {
    needExtendedHoursData: false
  });
}

function getSession1mFetchRange(now = Date.now()) {
  const sessionDay = getEtDateString(now);
  const { ethStartMs, capEndMs } = getEthDayBoundsForDay(sessionDay, now);
  const endMs = isGatekeeperOpen(now) ? Math.min(now, capEndMs) : capEndMs;
  return { startDate: ethStartMs, endDate: endMs };
}

async function getSession1mCandles(symbol, now = Date.now()) {
  if (isGatekeeperOpen(now)) {
    const { startDate, endDate } = getSession1mFetchRange(now);
    const ethEarlyCutoff = startDate + 30 * 60 * 1000;

    const [rangeBars, dayBars] = await Promise.all([
      getPriceHistory(symbol, null, null, 'minute', 1, {
        needExtendedHoursData: true,
        startDate,
        endDate
      }),
      getPriceHistory(symbol, 'day', 10, 'minute', 1, {
        needExtendedHoursData: true
      })
    ]);

    let merged = mergeCandleSources(rangeBars, dayBars);
    const firstMs = sortCandles(merged)[0]?.datetime;
    if (firstMs == null || firstMs > ethEarlyCutoff) {
      const monthBars = await getPriceHistory(symbol, 'month', 1, 'minute', 1, {
        needExtendedHoursData: true,
        startDate,
        endDate
      });
      merged = mergeCandleSources(merged, monthBars);
    }

    return sortCandles(merged).filter(
      c => c.datetime >= startDate && c.datetime <= endDate
    );
  }
  return getPriceHistory(symbol, 'day', 5, 'minute', 1, {
    needExtendedHoursData: true
  });
}

/** 1m history for MACD warmup — always merge multi-day with today's session. */
async function getIndicator1mCandles(symbol, now = Date.now()) {
  if (isGatekeeperOpen(now)) {
    const [session, dayBars] = await Promise.all([
      getSession1mCandles(symbol, now),
      getPriceHistory(symbol, 'day', INDICATOR_1M_PERIOD, 'minute', 1, {
        needExtendedHoursData: true
      })
    ]);
    return mergeCandleSources(dayBars, session);
  }
  return getPriceHistory(symbol, 'day', INDICATOR_1M_PERIOD, 'minute', 1, {
    needExtendedHoursData: true
  });
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
    sorted.push(stampBarEt({
      datetime: qBucket, open: price, high: price, low: price, close: price, volume: 0
    }));
  }
  return sorted;
}

function shouldPatchQuote(candles, quote, bucketMs = 60 * 1000) {
  if (!candles?.length || !quote?.quoteTime) return false;
  return quote.quoteTime > candles[candles.length - 1].datetime + bucketMs;
}
module.exports = {
  NY_TZ,
  stampBarEt,
  stampBars,
  boundsForDate,
  getEtDateString,
  getEtHourMinute,
  getEtSecond,
  utcFromEtDateTime,
  CLOSED_LOOKBACK_MS,
  ETH_OPEN_ET,
  ETH_CLOSE_ET,
  PRE_OPEN_ET,
  RTH_OPEN_ET,
  RTH_CLOSE_ET,
  POST_CLOSE_ET,
  getEthDayBounds,
  getEthDayBoundsForDay,
  mergeCandleSources,
  inferSessionDayFromCandles,
  filterSessionDayBars,
  trimPreGapBars,
  buildSession1mBars,
  buildVwap1mBars,
  buildIndicator1mBars,
  isGatekeeperOpen,
  getEtMinutes,
  getMarketSession,
  getSessionConfig,
  getVwapConfig,
  isVwapPartialEth,
  formatVwapTag,
  sortCandles,
  getLastCandleEtDate,
  buildVwapPackFrom1m,
  vwapCfgForSessionBars,
  resolveVwapPackFrom1m,
  getDailyCandles,
  getSession1mFetchRange,
  getSession1mCandles,
  getIndicator1mCandles,
  isQuoteValid,
  applyLiveQuoteToCandles,
  shouldPatchQuote
};
