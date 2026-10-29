'use strict';
const { quoteBidAskSpread } = require('./schwab');
const {
  sortCandles,
  getEtDateString,
  getEtHourMinute,
  getEtMinutes,
  getMarketSession,
  PRE_OPEN_ET,
  RTH_OPEN_ET
} = require('./session');
const {
  calcExpAverageTOS,
  getCompleted1mBars
} = require('./indicators');

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
const HV_SELL_VOLUME_RATIO = config.hvSellVolumeRatio;
const HV_SELL_BODY_MULTIPLE = config.hvSellBodyMultiple;
const HV_SELL_BODY_LOOKBACK = config.hvSellBodyLookback;

const DOT_SOURCE = {
  macd: "Ross's videos, per Kevin; citation to add",
  no_hv_sell: "Red bar volume above the buying (green) bars' volume, or a large red candle. Ross's videos, per Kevin; final bars only",
  resistance: 'PDF criterion 2: no nearby resistance',
  front_side: 'Web page: higher highs and higher lows, early in the breakout',
  giveback: 'Web page: shallow pullback; pitfall, too deep',
  spread_ok: 'Web page pitfall: wide spreads; 10¢ is MY OWN',
  vwap: 'Not a micro-pullback criterion; value shown only',
  emas: 'MY OWN; might be useful',
  support: 'MY OWN (v1)'
};
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
const FRONT_SIDE_CHOP_RANGE_RATIO = config.frontSideChopRangeRatio;
const FRONT_SIDE_CHOP_NO_HH_BARS = config.frontSideChopNoHHBars;
const FRONT_SIDE_CHOP_MIN_MIXED_BARS = config.frontSideChopMinMixedBars;
const GIVEBACK_MIN_GREEN_BARS = config.givebackMinGreenBars;
const GIVEBACK_LOOKBACK_BARS = config.givebackLookbackBars;
const GIVEBACK_MOVE_MIN_USD = config.givebackMoveMinUsd;
const GIVEBACK_WARN_RATIO = config.givebackWarnRatio;
const GIVEBACK_FAIL_RATIO = config.givebackFailRatio;
const MAX_BID_ASK_SPREAD_USD = config.maxBidAskSpreadUsd;
const NASDAQ_HALT_POLL_MS = config.nasdaqHaltPollMs;
const LUDP_PAUSE_MS = config.ludpPauseMs;
const NASDAQ_HALT_RPC_URL = config.nasdaqHaltRpcUrl;
const BACKOFF_MS = config.backoffMs;

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
    key_level_candidates_up: aboveAlts.slice(0, 5).map(formatKeyLevelCandidate),
    key_level_candidates_down: belowAlts.slice(0, 5).map(formatKeyLevelCandidate)
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function lastFinite(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (Number.isFinite(arr[i])) return arr[i];
  }
  return null;
}

/** User-facing session label for the context grid (not internal RTH/PRE codes). */
function contextMarketSession(now = Date.now()) {
  const s = getMarketSession(now);
  switch (s) {
    case 'PRE': return 'Pre-Market';
    case 'RTH': return 'Market Open';
    case 'POST': return 'After Hours';
    case 'CLOSED': return 'Closed';
    default: return 'Closed';
  }
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
  if (!isBearishBar(bar)) return false;
  const vol = bar.volume;
  if (!Number.isFinite(vol) || vol <= 0) return false;
  const idx = completedBars.indexOf(bar);
  if (idx < 0) return false;

  const run = findBullishRunBeforeBar(bar, completedBars);
  let greenVols = [];
  if (run?.length) {
    greenVols = run.map(b => b.volume).filter(v => Number.isFinite(v) && v > 0);
  } else {
    const windowStart = bar.datetime - WARNING_WINDOW_MS;
    greenVols = completedBars
      .filter(b => b.datetime >= windowStart && b.datetime < bar.datetime && isBullishBar(b))
      .map(b => b.volume)
      .filter(v => Number.isFinite(v) && v > 0);
  }
  const peakVol = greenVols.length ? Math.max(...greenVols) : 0;
  if (peakVol > 0 && vol > peakVol * HV_SELL_VOLUME_RATIO) return true;

  const prior = completedBars.slice(Math.max(0, idx - HV_SELL_BODY_LOOKBACK), idx);
  if (!prior.length) return false;
  const avgBody = prior.reduce((sum, candle) => sum + barBodySize(candle), 0) / prior.length;
  return avgBody > 0 && barBodySize(bar) >= avgBody * HV_SELL_BODY_MULTIPLE;
}

function isHighVolumeBuyBar(bar, completedBars) {
  return isHighVolumeBar(bar, completedBars, 'buy');
}

/** Bar volume below half of run peak or half of run average (tape pause after impulse). */
function isTapeSlowVsRun(bar, run) {
  const vol = bar?.volume;
  if (!Number.isFinite(vol) || vol <= 0 || !run?.length) return false;
  const vols = run.map(b => b.volume).filter(Number.isFinite);
  if (!vols.length) return false;
  const peakVol = Math.max(...vols);
  const avgVol = vols.reduce((s, v) => s + v, 0) / vols.length;
  if (!Number.isFinite(peakVol) || peakVol <= 0 || !Number.isFinite(avgVol) || avgVol <= 0) {
    return false;
  }
  return vol < peakVol * TAPE_SLOW_RATIO || vol < avgVol * TAPE_SLOW_RATIO;
}

function isTapeSlowdownBullRunBar(bar, completedBars) {
  const run = findBullishRunBeforeBar(bar, completedBars);
  if (!run?.length) return false;
  return isTapeSlowVsRun(bar, run);
}

function isTapeSlowdownBearRunBar(bar, completedBars) {
  const run = findBearishRunBeforeBar(bar, completedBars);
  if (!run?.length) return false;
  return isTapeSlowVsRun(bar, run);
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

/** High-to-low range across bars in a giveback run. */
function givebackRunMoveSize(run) {
  if (!run?.length) return 0;
  const highs = run.map(b => b.high).filter(Number.isFinite);
  const lows = run.map(b => b.low).filter(Number.isFinite);
  if (!highs.length || !lows.length) return 0;
  return Math.max(...highs) - Math.min(...lows);
}

/**
 * Giveback run: 2+ consecutive greens, or one green whose range moved enough.
 */
function qualifiesAsGivebackRun(run) {
  if (!run?.length) return false;
  const move = givebackRunMoveSize(run);
  if (run.length >= GIVEBACK_MIN_GREEN_BARS) {
    return run.every(isBullishBar);
  }
  return run.length === 1 && isBullishBar(run[0]) && move >= GIVEBACK_MOVE_MIN_USD;
}

/**
 * Most recent contiguous green chain before pullback reds at the end.
 * Walks backward; 1-bar stubs qualify only when move >= givebackMoveMinUsd.
 */
function findMostRecentBullishRun(bars) {
  const sorted = sortCandles(bars);
  const run = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (isBullishBar(sorted[i])) {
      run.unshift(sorted[i]);
    } else if (qualifiesAsGivebackRun(run)) {
      return run;
    } else {
      run.length = 0;
    }
  }
  return qualifiesAsGivebackRun(run) ? run : null;
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

/** Bullish run immediately before a bar (HV sell); allows single-bar impulses. */
function findBullishRunBeforeBar(bar, completedBars) {
  const sorted = sortCandles(completedBars);
  const idx = sorted.indexOf(bar);
  if (idx <= 0) return null;
  const prior = sorted.slice(Math.max(0, idx - FRONT_SIDE_LOOKBACK_BARS), idx);
  const run = findRecentBullishRunForFrontSide(prior);
  if (run?.length) return run;
  const last = prior[prior.length - 1];
  if (last && isBullishBar(last)) return [last];
  return null;
}

/** Trailing consecutive bearish 1m bars at end of series. */
function findTrailingBearishRun(bars, minLen = FRONT_SIDE_MIN_GREEN_BARS) {
  const sorted = sortCandles(bars);
  const run = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (isBearishBar(sorted[i])) run.unshift(sorted[i]);
    else break;
  }
  return run.length >= minLen ? run : null;
}

/** Longest consecutive red run in window. */
function findLongestBearishRunInWindow(bars, minLen = FRONT_SIDE_MIN_GREEN_BARS) {
  const sorted = sortCandles(bars);
  let best = null;
  let i = 0;
  while (i < sorted.length) {
    if (!isBearishBar(sorted[i])) {
      i++;
      continue;
    }
    const run = [];
    while (i < sorted.length && isBearishBar(sorted[i])) {
      run.push(sorted[i]);
      i++;
    }
    if (run.length >= minLen && (!best || run.length > best.length)) best = run;
  }
  return best;
}

/** Recent red run: skip up to 2 small bullish bars at the end, then trailing reds. */
function findRecentBearishRunForFrontSide(bars) {
  const sorted = sortCandles(bars);
  let end = sorted.length;
  let skipped = 0;
  while (end > 0 && skipped < 2) {
    const b = sorted[end - 1];
    if (isBullishBar(b) && barBodyRatio(b) < FRONT_SIDE_SMALL_BODY_RATIO) {
      end--;
      skipped++;
    } else {
      break;
    }
  }
  const trailing = findTrailingBearishRun(sorted.slice(0, end));
  if (trailing) return trailing;
  return findLongestBearishRunInWindow(sorted);
}

/** Bearish run immediately before a bar (tape slowdown after sell run). */
function findBearishRunBeforeBar(bar, completedBars) {
  const sorted = sortCandles(completedBars);
  const idx = sorted.indexOf(bar);
  if (idx <= 0) return null;
  const prior = sorted.slice(Math.max(0, idx - FRONT_SIDE_LOOKBACK_BARS), idx);
  const run = findRecentBearishRunForFrontSide(prior);
  if (run?.length) return run;
  const last = prior[prior.length - 1];
  if (last && isBearishBar(last)) return [last];
  return null;
}

/** Green impulse for giveback: most recent chain in lookback (not only trailing greens). */
function findTrailingBullishRunCompleted(completedBars) {
  const window = sortCandles(completedBars).slice(-GIVEBACK_LOOKBACK_BARS);
  return findMostRecentBullishRun(window);
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

function isNearRunPeak(price, runHigh, runRange) {
  return runRange > 0 && Number.isFinite(price) && Number.isFinite(runHigh) &&
    price >= runHigh - runRange * FRONT_SIDE_NEAR_PEAK_PCT;
}

function runLastBarIndex(run, bars) {
  const sorted = sortCandles(bars);
  let lastIdx = -1;
  for (const b of run) {
    const i = sorted.findIndex(s =>
      s === b || (s?.datetime != null && s.datetime === b?.datetime)
    );
    if (i > lastIdx) lastIdx = i;
  }
  return lastIdx;
}

function hasNewHighInRecentBars(bars, runHigh, count) {
  const recent = sortCandles(bars).slice(-count);
  if (!recent.length || !Number.isFinite(runHigh)) return false;
  return recent.some(b => Number.isFinite(b.high) && b.high >= runHigh);
}

function runTouchesRecentBars(run, bars, count = 2) {
  const sorted = sortCandles(bars);
  const tail = sorted.slice(-count);
  return run.some(rb => tail.some(tb =>
    tb === rb || (tb?.datetime != null && tb.datetime === rb?.datetime)
  ));
}

/**
 * Sideways / chop after impulse: mixed tape, boxed range, stale run, or lower highs off peak.
 */
function isSidewaysOrChoppy(bars, run, price, runHigh, runRange) {
  const completed = bars.length > 1 ? bars.slice(0, -1) : bars;
  const window = completed.slice(-FRONT_SIDE_CHOP_MIN_MIXED_BARS);
  if (window.length < 3) return false;

  const bulls = window.filter(isBullishBar).length;
  const bears = window.filter(isBearishBar).length;
  if (bulls >= 2 && bears >= 2) return true;

  if (runRange > 0) {
    const highs = window.map(b => b.high).filter(Number.isFinite);
    const lows = window.map(b => b.low).filter(Number.isFinite);
    if (highs.length && lows.length) {
      const recentRange = Math.max(...highs) - Math.min(...lows);
      if (recentRange < runRange * FRONT_SIDE_CHOP_RANGE_RATIO) return true;
    }
  }

  const sorted = sortCandles(bars);
  const runEndIdx = runLastBarIndex(run, sorted);
  const barsSinceRun = sorted.length - 1 - runEndIdx;
  if (runEndIdx >= 0 && barsSinceRun >= 3 &&
      !hasNewHighInRecentBars(sorted, runHigh, FRONT_SIDE_CHOP_NO_HH_BARS)) {
    return true;
  }

  if (hasLowerHighs(bars) && !isNearRunPeak(price, runHigh, runRange)) {
    return true;
  }

  return false;
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

  if (isSidewaysOrChoppy(bars, run, price, runHigh, runRange)) {
    return fail('choppy', 'Choppy / sideways — not front side');
  }

  const holdFloor = runRange > 0
    ? runLow + runRange * FRONT_SIDE_MIN_HOLD_PCT
    : runLow;
  const lastTwo = completed.slice(-2);
  const recentBearish = lastTwo.filter(isBearishBar);
  const smallConsolidation = recentBearish.length > 0 &&
    recentBearish.every(b => barBodyRatio(b) < FRONT_SIDE_SMALL_BODY_RATIO);
  const nearPeak = isNearRunPeak(price, runHigh, runRange);

  if (run.length >= 3 && runRange > 0 && nearPeak) {
    return ok('trending', 'Front-side run near highs');
  }

  if (runRange > 0 && price >= holdFloor && smallConsolidation && nearPeak) {
    return ok('consolidating', 'Small pullback — still on front side');
  }

  const lastCompletedBar = completed.length ? completed[completed.length - 1] : null;
  if (lastCompletedBar && isBullishBar(lastCompletedBar) && price >= holdFloor &&
      (runTouchesRecentBars(run, bars, 2) || nearPeak)) {
    return ok('front_side', 'Buy-side run intact');
  }

  if (hasLowerHighs(bars) && Number.isFinite(ema9) && price >= ema9) {
    return warn('weakening', 'Lower highs — watch for backside');
  }

  const chopWindow = completed.slice(-FRONT_SIDE_CHOP_MIN_MIXED_BARS);
  const bulls = chopWindow.filter(isBullishBar).length;
  const bears = chopWindow.filter(isBearishBar).length;
  if (bulls < 2 && bears >= 2) {
    return fail('choppy', 'Choppy — no clear buy-side control');
  }

  if (price >= holdFloor) {
    return warn('weakening', 'Pullback — still above run floor');
  }

  return fail('backside', 'Backside / lost front-side structure');
}

/**
 * Row 2 — giveback from most recent green chain vs live price.
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
      state: 'red',
      phase: 'no_run',
      reason: 'No recent green run'
    };
  }

  const moveSize = givebackRunMoveSize(run);
  const moveHigh = Math.max(...run.map(b => b.high).filter(Number.isFinite));
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

  addTimedWarning(codes, bars, 'tape_slowdown_bull_run',
    findAllWarningBarsInLookback(completed1m, isTapeSlowdownBullRunBar, now), now);
  addTimedWarning(codes, bars, 'tape_slowdown_bear_run',
    findAllWarningBarsInLookback(completed1m, isTapeSlowdownBearRunBar, now), now);

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
  const resistance = levelSignals?.resistance;
  const resistanceOk = resistance?.state === 'green' &&
    ['clear', 'broke_through', 'no_resistance_above'].includes(resistance.phase);
  const aligned = Boolean(
    frontSide?.macd &&
    frontSide?.no_hv_sell &&
    frontSide?.spread_ok &&
    resistanceOk &&
    momentum?.front_side?.state === 'green' &&
    giveback?.state === 'green'
  );
  return aligned ? 'ALIGNED' : 'NOT_ALIGNED';
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
  candles1m, momentum, giveback,
  front_side, macdBarCount,
  keyLevels, level_signals, quote, now = Date.now()
}) {
  const nl = lines => lines.join('\n');
  const spread = quoteBidAskSpread(quote);
  const barLine = c => `${formatEtHm(c.datetime)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)} V=${c.volume}`;

  const fs = momentum?.front_side;
  const momLines = [
    `Source: ${DOT_SOURCE.front_side}`,
    'Series: forming 1m bar included.',
    'Row 2 — Front side: buy-side structure (not HH ladder).',
    'GREEN: active push near highs or fresh green run; small pullback OK only near peak.',
    'RED: below 9 EMA, reversal, backside LLs, below run low, or chop/sideways after impulse.',
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
    `Source: ${DOT_SOURCE.giveback}`,
    'Row 2 — Giveback: pullback from most recent green-chain high vs chain range.',
    'Series: forming 1m bar included.',
    `Lookback ${GIVEBACK_LOOKBACK_BARS} 1m bars.`,
    `Run: ${GIVEBACK_MIN_GREEN_BARS}+ green bars, or 1 green with range ≥ $${GIVEBACK_MOVE_MIN_USD.toFixed(2)}.`,
    `Green shallow pullback; yellow ${(GIVEBACK_WARN_RATIO * 100).toFixed(0)}–${(GIVEBACK_FAIL_RATIO * 100).toFixed(0)}%;`,
    `red >${(GIVEBACK_FAIL_RATIO * 100).toFixed(0)}% giveback or no recent green run.`
  ];
  const gbWindow = sortCandles(candles1m || []).slice(-GIVEBACK_LOOKBACK_BARS);
  const gbRun = findMostRecentBullishRun(gbWindow);
  if (gbRun?.length) {
    gbLines.push(`Green run (${gbRun.length} bars):`);
    gbRun.forEach(c => gbLines.push(`  ${barLine(c)}`));
  }
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
    day_change_pct: nl(
      Number.isFinite(prevClose) && prevClose !== 0
        ? [
          '((lastPrice - previousClose) / previousClose) × 100',
          `($${price.toFixed(2)} - $${prevClose.toFixed(2)}) / $${prevClose.toFixed(2)}`,
          'Green if > 10%.'
        ]
        : ['Previous close is not available yet.']
    ),
    vwap_delta: nl([
      'Series: forming 1m bar included, with its provisional volume.',
      `VWAP anchor: ${vwapAnchor} (${vwapPack?.tag ?? '—'})`,
      vwap != null ? `Session VWAP: $${vwap.toFixed(2)}` : 'VWAP unavailable (no volume in window)',
      vwap != null ? `Delta: lastPrice - VWAP. Green if price > VWAP.` : '',
      vwap != null ? `Price $${price.toFixed(2)} vs VWAP $${vwap.toFixed(2)}` : ''
    ]),
    ema9_1m: nl([
      'Series: forming 1m bar included.',
      '9 EMA (1m) — TOS ExpAverage, today 4AM ET session only (matches TOS active day).',
      `Value: $${ema9_1m_value?.toFixed(2) ?? '—'} on ${macdBarCount ?? '—'} bars (includes forming).`,
      `Compare to 20 EMA: ${ema9_1m_value > ema20_1m_value ? '9 > 20 (green)' : '9 ≤ 20 (red)'}.`
    ]),
    ema20_1m: nl([
      'Series: forming 1m bar included.',
      '20 EMA (1m) — TOS ExpAverage, same today-session series as 9 EMA.',
      `Value: $${ema20_1m_value?.toFixed(2) ?? '—'}.`
    ]),
    macd_histogram: nl([
      'Series: forming 1m bar included.',
      'MACD (12, 26, 9) — TOS ExpAverage; up to 800 prior 1m bars for EMA warmup.',
      'Histogram: forming 1m bar (live TOS Diff). Compare at same clock time.',
      `Value: ${macd_histogram_value}`,
      'Green if > 0.'
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
        `Source: ${DOT_SOURCE.emas}`,
        'Context only. Does not affect ALIGNED.',
        'Series: forming 1m bar included.',
        `9 EMA $${ema9_1m_value?.toFixed(2) ?? '—'} vs 20 EMA $${ema20_1m_value?.toFixed(2) ?? '—'}`
      ]),
      macd: nl([
        `Source: ${DOT_SOURCE.macd}`,
        'Series: forming 1m bar included.',
        'Gospel: MACD histogram > 0.',
        `Histogram = ${macd_histogram_value}`,
        `→ ${front_side.macd ? 'GREEN' : 'RED'}`
      ]),
      vwap: nl([
        `Source: ${DOT_SOURCE.vwap}`,
        'Context only. Does not affect ALIGNED.',
        'Series: forming 1m bar included, with its provisional volume.',
        vwap != null ? `Price $${price.toFixed(2)} vs VWAP $${vwap.toFixed(2)}` : 'No VWAP'
      ]),
      no_hv_sell: nl([
        `Source: ${DOT_SOURCE.no_hv_sell}`,
        'Series: final 1m bars only.',
        'Gospel: no high-volume sell in the last 8 minutes.',
        `Red volume above ${HV_SELL_VOLUME_RATIO}× the largest green bar in the current run, or in the 8-minute lookback when there is no run.`,
        `Or a red body ≥ ${HV_SELL_BODY_MULTIPLE}× the average body of the last ${HV_SELL_BODY_LOOKBACK} bars.`,
        `→ ${front_side.no_hv_sell ? 'GREEN' : 'RED (HV sell in window)'}`
      ]),
      spread_ok: nl([
        `Source: ${DOT_SOURCE.spread_ok}`,
        'Series: quote, not bars.',
        `Gospel: ask − bid ≤ $${MAX_BID_ASK_SPREAD_USD.toFixed(2)}.`,
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
          `Source: ${DOT_SOURCE.resistance}`,
          'Series: forming 1m bar may test the level.',
          'Gospel — resistance. Testing within 3¢ at level; approach 3–10¢.',
          level_signals.resistance.reason,
          `Phase: ${level_signals.resistance.phase} · state: ${level_signals.resistance.state}`
        ])
      : '',
    level_support: level_signals?.support
      ? nl([
          `Source: ${DOT_SOURCE.support}`,
          'Context only. Does not affect ALIGNED.',
          'Series: forming 1m bar may test the level.',
          level_signals.support.reason,
          `Phase: ${level_signals.support.phase} · state: ${level_signals.support.state}`
        ])
      : ''
  };
}
module.exports = {
  KEY_LEVEL_KIND_LABEL,
  KEY_LEVEL_KIND_PRIORITY,
  collectPsychLevels,
  findPivotHighs,
  findPivotLows,
  levelTolerance,
  countResistanceTouches,
  countSupportTouches,
  countOpenCloseTouches,
  isWholeDollarPrice,
  isHalfDollarPrice,
  getPremarketExtremes,
  annotateKeyLevel,
  psychLevelBonus,
  buildTouchResistanceClusters,
  buildTouchSupportClusters,
  scoreResistanceCandidate,
  finalizeResistancePick,
  pickMostRecentPivot,
  pickKeyLevelUp,
  pickKeyLevelDown,
  dedupeKeyLevels,
  formatKeyLevelCandidate,
  calcKeyLevels,
  round2,
  lastFinite,
  contextMarketSession,
  formatEtHm,
  minuteClosePulseFromBars,
  isToppingTailBar,
  isBottomingTailBar,
  isDojiBar,
  isBullishBar,
  isBearishBar,
  priorBarsBefore,
  isDojiOnBullishRunBar,
  isDojiOnBearishRunBar,
  isHighVolumeBar,
  isHighVolumeSellBar,
  isHighVolumeBuyBar,
  isTapeSlowdownBullRunBar,
  isTapeSlowdownBearRunBar,
  barsInWarningWindow,
  findMostRecentWarningBar,
  findAllWarningBarsInLookback,
  formatWarningBarTimes,
  hasHighVolSellInLookback,
  addTimedWarning,
  barBodyRatio,
  barBodySize,
  findTrailingBullishRun,
  findMostRecentBullishRun,
  findLongestBullishRunInWindow,
  findRecentBullishRunForFrontSide,
  findTrailingBullishRunCompleted,
  hasTwoConsecutiveLowerLows,
  hasLowerHighs,
  avgBullishBodySize,
  computeFrontSideSignal,
  computeGivebackSignal,
  computeWarnings,
  barTestsResistance,
  barTestsSupport,
  crossedAboveRecently,
  crossedBelowRecently,
  computeResistanceSignal,
  computeSupportSignal,
  formatLevelWarningDetail,
  mergeLevelWarnings,
  row1AllGreen,
  row2AllGreen,
  trafficBanner,
  keyLevelHintLines,
  buildCalcHints
};
