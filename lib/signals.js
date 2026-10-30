'use strict';
const { quoteBidAskSpread } = require('./schwab');
const {
  sortCandles,
  stampBarEt,
  getEtDateString,
  getEtHourMinute,
  PRE_OPEN_ET,
  RTH_OPEN_ET
} = require('./session');
const {
  calcExpAverageTOS,
  getCompleted1mBars
} = require('./indicators');

const { config } = require('./store');

const WARNING_WINDOW_MS = config.warningWindowMs;
const TOPPING_TAIL_WICK_RATIO = config.toppingTailWickRatio;
const BOTTOMING_TAIL_WICK_RATIO = config.bottomingTailWickRatio;
const TAIL_RANGE_MULTIPLE = config.tailRangeMultiple;
const TAIL_RANGE_LOOKBACK = config.tailRangeLookback;
const TAIL_EXTREME_LOOKBACK = config.tailExtremeLookback;
const TOPPING_TAIL_NEAR_HIGH_PCT = config.toppingTailNearHighPct;
const DOJI_BODY_RATIO = config.dojiBodyRatio;
const DOJI_RUN_LOOKBACK = config.dojiRunLookback;
const DOJI_RUN_MIN_SAME_DIR = config.dojiRunMinSameDir;
const HIGH_VOL_RATIO = config.highVolRatio;
const HIGH_VOL_PRIOR_BARS = config.highVolPriorBars;
const HV_SELL_VOLUME_RATIO = config.hvSellVolumeRatio;
const HV_SELL_BODY_MULTIPLE = config.hvSellBodyMultiple;
const HV_SELL_BODY_LOOKBACK = config.hvSellBodyLookback;

const DOT_SOURCE = {
  macd: 'Histogram above 0 (MACD line above its signal line). Ross\'s videos, per Kevin; citation to add',
  no_hv_sell: 'Red bar volume above the largest green bar of the current run, last 8 minutes. Final bars only',
  no_big_red: 'Red body at least 2× the median body of the prior 10 bars, last 8 minutes. Final bars only',
  no_topping_tail: 'Topping tail in the last 3 closed bars, cleared if a later bar closes above its high',
  resistance: 'Daily chart only: no prior-day high within 10% above price. Intraday pivots are ladder levels, not a check',
  front_side: 'Web page: higher highs and higher lows, early in the breakout',
  giveback: 'Web page: shallow pullback; pitfall, too deep',
  spread_ok: 'Web page pitfall: wide spreads; 10¢ is MY OWN',
  vwap: 'Session VWAP, since 4:00 in premarket and since 9:30 after the open. Value shown only',
  emas: 'MY OWN; might be useful',
  support: 'MY OWN (v1)'
};
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
    stampBarEt(c);
    if (c.etDate !== sessionDay) return false;
    return c.etMinute >= PRE_OPEN_ET && c.etMinute < RTH_OPEN_ET;
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
    .filter(c => {
      stampBarEt(c);
      return c.etDate !== sessionDay;
    });
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
    session_high: Number.isFinite(sessionHod) ? round2(sessionHod) : null,
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

function formatEtHm(ms) {
  const { h, m } = getEtHourMinute(ms);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Webull stores the bar open. The chart labels the bar close, one minute later.
function formatChartHm(ms) {
  const start = Number(ms);
  if (!Number.isFinite(start)) return null;
  return formatEtHm(start + 60000);
}

const PILL_RANK = { resistance: 0, support: 1, vwap: 2, ema9: 3, ema20: 3 };

function pricePillLabel(names, sameEntry) {
  const ordered = (names || []).slice().sort((a, b) => (PILL_RANK[a.role] ?? 9) - (PILL_RANK[b.role] ?? 9));
  const head = sameEntry ? 'PRICE = ENTRY' : 'PRICE';
  if (!ordered.length) return { label: head, title: '' };
  const extra = ordered.length - 1;
  const label = extra
    ? `${head} · ${ordered[0].name} +${extra}`
    : `${head} · ${ordered[0].name}`;
  return { label, title: ordered.map(item => item.name).join(' · ') };
}

function relativeVolume(dailyCandles, sessionBars, now = Date.now()) {
  const today = getEtDateString(now);
  const prior = sortCandles(dailyCandles || []).filter(bar => {
    stampBarEt(bar);
    return bar.etDate < today && Number.isFinite(bar.volume) && bar.volume > 0;
  }).slice(-10);
  if (!prior.length) return null;
  const average = prior.reduce((sum, bar) => sum + bar.volume, 0) / prior.length;
  if (!(average > 0)) return null;
  let todayVolume = 0;
  for (const bar of sessionBars || []) {
    stampBarEt(bar);
    if (bar.etDate !== today) continue;
    if (Number.isFinite(bar.volume) && bar.volume > 0) todayVolume += bar.volume;
  }
  return todayVolume / average;
}

function rvolColor(multiple) {
  if (!Number.isFinite(multiple)) return null;
  for (const band of config.rvolBands || []) {
    if (band.above != null && multiple > band.above) return band.color;
    if (band.above == null && multiple >= band.min) return band.color;
  }
  return null;
}

function macdGospelPositive(histogram) {
  return Number.isFinite(histogram) && histogram > 0;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function tailWindow(completedBars, bar) {
  const prior = priorBarsBefore(completedBars || [], bar, Math.max(0, TAIL_EXTREME_LOOKBACK - 1));
  return [...prior, bar];
}

function tailRangeIsMeaningful(bar, completedBars) {
  const range = bar.high - bar.low;
  const prior = priorBarsBefore(completedBars || [], bar, TAIL_RANGE_LOOKBACK);
  const ranges = prior.map(candle => candle.high - candle.low).filter(value => value > 0);
  const typical = median(ranges);
  if (typical == null) return true;
  return range >= typical * TAIL_RANGE_MULTIPLE;
}

function isToppingTailBar(bar, completedBars) {
  if (!bar || isDojiBar(bar)) return false;
  const range = bar.high - bar.low;
  if (!(range > 0)) return false;
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  if (upperWick / range < TOPPING_TAIL_WICK_RATIO) return false;
  if (!tailRangeIsMeaningful(bar, completedBars)) return false;
  const windowBars = tailWindow(completedBars, bar);
  const extreme = Math.max(...windowBars.map(candle => candle.high).filter(Number.isFinite));
  if (!Number.isFinite(extreme)) return false;
  return bar.high >= extreme * (1 - TOPPING_TAIL_NEAR_HIGH_PCT);
}

function isBottomingTailBar(bar, completedBars) {
  if (!bar || isDojiBar(bar)) return false;
  const range = bar.high - bar.low;
  if (!(range > 0)) return false;
  const lowerWick = Math.min(bar.open, bar.close) - bar.low;
  if (lowerWick / range < BOTTOMING_TAIL_WICK_RATIO) return false;
  if (!tailRangeIsMeaningful(bar, completedBars)) return false;
  const windowBars = tailWindow(completedBars, bar);
  const extreme = Math.min(...windowBars.map(candle => candle.low).filter(Number.isFinite));
  if (!Number.isFinite(extreme)) return false;
  return bar.low <= extreme * (1 + TOPPING_TAIL_NEAR_HIGH_PCT);
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
  return peakVol > 0 && vol > peakVol * HV_SELL_VOLUME_RATIO;
}

function isLargeSellCandleBar(bar, completedBars) {
  if (!isBearishBar(bar)) return false;
  const idx = completedBars.indexOf(bar);
  if (idx < 0) return false;
  const prior = completedBars.slice(Math.max(0, idx - HV_SELL_BODY_LOOKBACK), idx);
  const bodies = prior.map(barBodySize).filter(value => value > 0);
  const typical = median(bodies);
  return typical > 0 && barBodySize(bar) >= typical * HV_SELL_BODY_MULTIPLE;
}

function isHighVolumeBuyBar(bar, completedBars) {
  return isHighVolumeBar(bar, completedBars, 'buy');
}

/** Closed-bar coil: tight range and no new high. Volume is the live tape warning. */
function isConsolidatingBar(bar, completedBars) {
  if (!bar || !Number.isFinite(bar.high) || !Number.isFinite(bar.low)) return false;
  const range = bar.high - bar.low;
  if (!Number.isFinite(range) || range < 0) return false;
  const prior = priorBarsBefore(completedBars, bar, TAIL_RANGE_LOOKBACK);
  const ranges = prior.map(candle => candle.high - candle.low).filter(value => value > 0);
  const typical = median(ranges);
  if (!(typical > 0) || range > typical * 0.5) return false;
  const highs = prior.map(candle => candle.high).filter(Number.isFinite);
  if (!highs.length) return false;
  return bar.high <= Math.max(...highs);
}

function buildNotes(completedBars, context = {}) {
  const bars = sortCandles(completedBars || []);
  const kinds = [
    {
      id: 'hv_sell',
      side: 'BEAR',
      match: bar => isHighVolumeSellBar(bar, bars),
      text: () => 'High-volume sell'
    },
    {
      id: 'large_buy',
      side: 'BULL',
      match: bar => isHighVolumeBuyBar(bar, bars),
      text: () => 'Large buy volume'
    },
    {
      id: 'topping_tail',
      side: 'BEAR',
      match: bar => isToppingTailBar(bar, bars),
      text: () => 'Topping tail'
    },
    {
      id: 'bottoming_tail',
      side: 'BULL',
      match: bar => isBottomingTailBar(bar, bars),
      text: () => 'Bottoming tail'
    },
    {
      id: 'doji',
      side: 'NEUTRAL',
      match: bar => isDojiOnBullishRunBar(bar, bars) || isDojiOnBearishRunBar(bar, bars),
      text: () => 'Doji'
    },
    {
      id: 'consolidating',
      side: 'NEUTRAL',
      match: bar => isConsolidatingBar(bar, bars),
      text: bar => `Consolidating near $${bar.close.toFixed(2)}`
    },
    {
      id: 'resistance',
      side: 'BEAR',
      match: bar => Number.isFinite(context.resistance) && barTestsResistance(bar, context.resistance),
      text: () => `Resistance $${Number(context.resistance).toFixed(2)}`
    },
    {
      id: 'support',
      side: 'BULL',
      match: bar => Number.isFinite(context.support) && barTestsSupport(bar, context.support),
      text: () => `Held support $${Number(context.support).toFixed(2)}`
    },
    {
      id: 'below_vwap',
      side: 'BEAR',
      match: bar => Number.isFinite(context.vwap) && bar.close < context.vwap,
      text: () => 'Below VWAP'
    },
    {
      id: 'below_ema',
      side: 'BEAR',
      match: bar => (
        (Number.isFinite(context.ema9) && bar.close < context.ema9) ||
        (Number.isFinite(context.ema20) && bar.close < context.ema20)
      ),
      text: () => 'Below 9/20 EMA'
    }
  ];
  const used = new Set();
  const notes = [];
  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i];
    for (const kind of kinds) {
      if (used.has(kind.id)) continue;
      if (!kind.match(bar)) continue;
      used.add(kind.id);
      notes.push({
        side: kind.side,
        time: formatChartHm(bar.datetime),
        text: kind.text(bar),
        datetime: bar.datetime
      });
      break;
    }
  }
  notes.sort((a, b) => b.datetime - a.datetime);
  return notes.map(({ side, time, text }) => ({ side, time, text }));
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

function latestHvSellTime(completedBars, now = Date.now()) {
  const bar = findMostRecentWarningBar(completedBars, isHighVolumeSellBar, now);
  return bar ? formatChartHm(bar.datetime) : null;
}

function latestLargeSellTime(completedBars, now = Date.now()) {
  const bar = findMostRecentWarningBar(completedBars, isLargeSellCandleBar, now);
  return bar ? formatChartHm(bar.datetime) : null;
}

function laterCloseAbove(completedBars, bar, level) {
  if (!Number.isFinite(level)) return false;
  return sortCandles(completedBars).some(later =>
    later.datetime > bar.datetime &&
    Number.isFinite(later.close) &&
    later.close > level
  );
}

function classifyEvent(bar, now) {
  if (!bar) return { phase: 'pass', time: null, age_min: null };
  const age = now - (Number(bar.datetime) + 60000);
  if (age > config.eventCautionMs) return { phase: 'pass', time: null, age_min: null };
  return {
    phase: age <= config.eventFailMs ? 'fail' : 'caution',
    time: formatChartHm(bar.datetime),
    age_min: Math.max(0, Math.floor(age / 60000))
  };
}

function activeEvent(completedBars, predicate, now = Date.now(), clearLevel = null) {
  const cutoff = now - config.eventCautionMs - 60000;
  const bars = sortCandles(completedBars).filter(item => item?.datetime >= cutoff);
  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i];
    if (!predicate(bar, completedBars)) continue;
    if (typeof clearLevel === 'function' && laterCloseAbove(completedBars, bar, clearLevel(bar))) continue;
    return classifyEvent(bar, now);
  }
  return classifyEvent(null, now);
}

function zoomWindow(price, levels) {
  const MIN = 0.15;
  const MAX = 0.60;
  if (!Number.isFinite(price)) return null;
  const finite = (levels || []).map(Number).filter(Number.isFinite);
  const above = finite.filter(level => level > price + 1e-9).sort((a, b) => a - b)[0];
  const below = finite.filter(level => level < price - 1e-9).sort((a, b) => b - a)[0];
  let lo = price - MIN / 2;
  let hi = price + MIN / 2;
  const belowFits = Number.isFinite(below) && price - below <= MAX;
  const aboveFits = Number.isFinite(above) && above - price <= MAX;
  if (belowFits) lo = Math.min(lo, below);
  if (aboveFits) hi = Math.max(hi, above);
  if (hi - lo > MAX) {
    if (belowFits && (!aboveFits || price - below <= above - price)) {
      lo = below;
      hi = lo + MAX;
    } else if (aboveFits) {
      hi = above;
      lo = hi - MAX;
    } else {
      lo = price - MAX / 2;
      hi = price + MAX / 2;
    }
  }
  if (hi - lo < MIN) {
    const mid = (lo + hi) / 2;
    lo = mid - MIN / 2;
    hi = mid + MIN / 2;
  }
  const span = hi - lo;
  if (price < lo + span * 0.2 || price > hi - span * 0.2) {
    lo = price - span / 2;
    hi = price + span / 2;
  }
  return { lo, hi };
}

function activeToppingTail(completedBars) {
  const bars = sortCandles(completedBars || []);
  const recent = bars.slice(-3);
  let hit = null;
  for (const bar of recent) {
    if (!isToppingTailBar(bar, bars)) continue;
    const cleared = bars.some(later =>
      later.datetime > bar.datetime &&
      Number.isFinite(later.close) &&
      later.close > bar.high
    );
    if (!cleared) hit = bar;
  }
  return hit;
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

/** Green impulse for giveback: most recent chain in lookback (not only trailing greens). */
function findTrailingBullishRunCompleted(completedBars) {
  const window = sortCandles(completedBars).slice(-GIVEBACK_LOOKBACK_BARS);
  return findMostRecentBullishRun(window);
}

function pullbackLowAfterRun(completedBars, run) {
  if (!run?.length) return null;
  const end = run[run.length - 1].datetime;
  const lows = sortCandles(completedBars)
    .filter(bar => bar.datetime > end)
    .map(bar => bar.low)
    .filter(Number.isFinite);
  if (!lows.length) return null;
  return Math.min(...lows);
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
    pullback_low: null,
    pct: null
  };
  const run = findTrailingBullishRunCompleted(completedBars);
  if (!run) {
    return {
      ...base,
      pct: null,
      state: 'red',
      phase: 'no_run',
      reason: 'No recent green run'
    };
  }

  const moveSize = givebackRunMoveSize(run);
  const moveHigh = Math.max(...run.map(b => b.high).filter(Number.isFinite));
  const pullback = Math.max(0, moveHigh - price);
  const pullbackLow = pullbackLowAfterRun(completedBars, run);

  base.move_size = round2(moveSize);
  base.pullback = round2(pullback);
  base.pullback_low = pullbackLow != null ? round2(pullbackLow) : null;

  if (!(moveSize >= GIVEBACK_MOVE_MIN_USD)) {
    return {
      ...base,
      pct: null,
      state: 'green',
      phase: 'move_too_small',
      reason: 'Green run too small to score giveback'
    };
  }

  const pct = Math.min(1, pullback / moveSize);
  base.pct = round2(pct * 100);

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

function computeResistanceSignal(price, dailyCandles, now = Date.now()) {
  const clear = {
    state: 'green',
    phase: 'clear',
    reason: 'Daily clear',
    level_price: null,
    level_label: null,
    distance: null,
    distance_pct: null
  };
  if (!Number.isFinite(price) || price <= 0 || !dailyCandles?.length) {
    return { ...clear, phase: 'no_daily_data' };
  }
  const today = getEtDateString(now);
  const highs = sortCandles(dailyCandles).filter(bar => {
    stampBarEt(bar);
    return bar.etDate < today && Number.isFinite(bar.high) && bar.high > price;
  }).map(bar => bar.high);
  if (!highs.length) return clear;
  const level = Math.min(...highs);
  const pct = (level - price) / price;
  const distancePct = Math.round(pct * 100);
  const distanceLabel = pct < 0.01
    ? `+${Math.abs(Math.round((level - price) * 100))}¢`
    : `+${distancePct}%`;
  const fields = {
    level_price: round2(level),
    level_label: 'Daily',
    distance: round2(level - price),
    distance_pct: distancePct,
    distance_label: distanceLabel
  };
  if (pct <= config.dailyResistancePct) {
    return {
      state: 'red',
      phase: 'near',
      reason: `Daily res. ${level.toFixed(2)} ${distanceLabel}`,
      ...fields
    };
  }
  return { ...clear, ...fields };
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

function trafficBanner(frontSide, _levelSignals, momentum, giveback) {
  const aligned = Boolean(
    frontSide?.macd &&
    frontSide?.no_hv_sell &&
    frontSide?.no_big_red &&
    frontSide?.no_topping_tail &&
    frontSide?.spread_ok &&
    momentum?.front_side?.state === 'green' &&
    giveback?.state === 'green'
  );
  return aligned ? 'ALIGNED' : 'NOT_ALIGNED';
}

function keyLevelHintLines(title, price, chosen, alts, extra) {
  const lines = [
    title,
    'Intraday pivot, not a Gospel check. A high is a pivot when none of the 3 bars on the left, or the bars on the right, has a higher high. The right side is 3 bars, or fewer at the end of the series. Lows use the same window. Equal neighbors still count.',
    'Swings use today\'s completed 1-minute bars once at least 7 exist. A 48-bar pass also clusters 5¢ touches.',
    'Nearest is a score, not the closest price: touches × 100, plus a half/whole-dollar bonus, beyond max($0.01, 0.2% of price). Two or more touches win. Ties take the closer price. The most recent swing is always included. Recomputed on every refresh.'
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
  const barLine = c => `${formatChartHm(c.datetime)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)} V=${c.volume}`;

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
      `VWAP since ${vwapAnchor}.`,
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
        `VWAP since ${vwapAnchor}.`,
        'Context only. Does not affect ALIGNED.',
        'Series: forming 1m bar included, with its provisional volume.',
        vwap != null ? `Price $${price.toFixed(2)} vs VWAP $${vwap.toFixed(2)}` : 'No VWAP'
      ]),
      no_hv_sell: nl([
        `Source: ${DOT_SOURCE.no_hv_sell}`,
        'Series: final 1m bars only.',
        'Gospel: no high-volume sell in the last 8 minutes.',
        `Red volume above ${HV_SELL_VOLUME_RATIO}× the largest green bar in the current run, or in the 8-minute lookback when there is no run.`,
        `→ ${front_side.no_hv_sell ? 'GREEN' : 'RED (HV sell in window)'}`
      ]),
      no_big_red: nl([
        `Source: ${DOT_SOURCE.no_big_red}`,
        'Series: final 1m bars only.',
        `Red body ≥ ${HV_SELL_BODY_MULTIPLE}× the median body of the prior ${HV_SELL_BODY_LOOKBACK} bars.`,
        `→ ${front_side.no_big_red ? 'GREEN' : 'RED (large sell candle in window)'}`
      ]),
      no_topping_tail: nl([
        `Source: ${DOT_SOURCE.no_topping_tail}`,
        'Series: final 1m bars only.',
        'Last 3 closed bars. Cleared when a later bar closes above the tail high.',
        `→ ${front_side.no_topping_tail ? 'GREEN' : 'RED'}`
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
          'Series: completed daily highs before today. Today is not a candidate.',
          `Gospel fails when the nearest prior daily high is within ${Math.round(config.dailyResistancePct * 100)}% above price.`,
          'Intraday pivots stay on the ladder and do not affect ALIGNED.',
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
  formatEtHm,
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
  isLargeSellCandleBar,
  isHighVolumeBuyBar,
  macdGospelPositive,
  buildNotes,
  relativeVolume,
  rvolColor,
  barsInWarningWindow,
  findMostRecentWarningBar,
  latestHvSellTime,
  latestLargeSellTime,
  activeToppingTail,
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
  barTestsResistance,
  barTestsSupport,
  crossedAboveRecently,
  crossedBelowRecently,
  computeResistanceSignal,
  computeSupportSignal,
  formatEtHm,
  formatChartHm,
  pricePillLabel,
  activeEvent,
  zoomWindow,
  trafficBanner,
  keyLevelHintLines,
  buildCalcHints
};
