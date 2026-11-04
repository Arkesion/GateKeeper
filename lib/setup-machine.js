'use strict';

const { calcExpAverageTOS } = require('./indicators');
const { findPivotHighs, isHighVolumeSellBar, formatChartHm } = require('./signals');
const { config } = require('./store');

const SEGMENTS = { IDLE: 1, SURGE: 2, PULLBACK: 3, ARMED: 4, TRIGGERED: 5, FAILED: 0 };
const SOURCES = [
  'Surge: Web page, "moving with high volume". The 10-bar high and 20-bar average are MY OWN.',
  'Pullback: Web page, "1-3 candle pause".',
  'Bull flag: Ross, citation to add. The same pole, continued past 3 candles.',
  'Retrace: Web page, "shallow". 50% from the highest surge close down to the leg low is MY OWN.',
  'Flag range: MY OWN. Consolidation high minus low under 50% of the pole high minus the pole low.',
  'Flag length: MY OWN. At most 15 candles.',
  '9 EMA: MY OWN. No pullback close under the 9 EMA.',
  'Volume: Web page, "volume tapers". Each micro-pullback bar is under the surge average. A bull flag average under the pole average is MY OWN.',
  'Heavy selling: a red pullback candle above the largest green of the run. Same check as the high-volume sell chip.',
  'Trigger: Web page, "first 1-minute candle breaks its own high after the pullback". A bull flag uses the consolidation high.',
  'Snap: Web page, "might wait for that clean breakout level". Half dollar, whole dollar, or pivot high within 3¢ above.',
  'Stop: pullback or flag low minus 1¢, web page/PDF. The 20¢ cap under the trigger is MY OWN.'
];

function round2(n) {
  return Math.round(n * 100) / 100;
}

function pxText(n) {
  return Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '';
}

function volK(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '';
  if (Math.abs(value) >= 1000) return `${Math.round(value / 1000)}K`;
  return String(Math.round(value));
}

function isGreen(bar) {
  return Number.isFinite(bar?.open) && Number.isFinite(bar?.close) && bar.close > bar.open;
}

function isRed(bar) {
  return Number.isFinite(bar?.open) && Number.isFinite(bar?.close) && bar.close < bar.open;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatEtHms(ms) {
  if (!Number.isFinite(ms)) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(ms));
  const get = type => parts.find(part => part.type === type)?.value || '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${hour}:${get('minute')}:${get('second')}`;
}

function dollarKind(price) {
  const cents = Math.round(price * 100) % 100;
  return cents === 0 ? 'whole dollar' : 'half dollar';
}

function snapTrigger(raw, bars) {
  const ceiling = raw + 0.03;
  const levels = [];
  const step = Math.ceil((raw + 1e-9) * 2) / 2;
  if (step > raw + 1e-9 && step <= ceiling + 1e-9) levels.push({ price: step, kind: dollarKind(step) });
  for (const pivot of findPivotHighs(bars)) {
    if (pivot.price > raw + 1e-9 && pivot.price <= ceiling + 1e-9) {
      levels.push({ price: pivot.price, kind: 'pivot' });
    }
  }
  if (!levels.length) return { price: raw, kind: null };
  let best = levels[0];
  for (const level of levels.slice(1)) {
    if (level.price < best.price - 1e-9) best = level;
    else if (Math.abs(level.price - best.price) <= 1e-9 && best.kind === 'pivot') best = level;
  }
  return best;
}

function sourceLabel(source, snap) {
  if (!snap.kind) return source;
  return `snapped to $${round2(snap.price).toFixed(2)} (${snap.kind})`;
}

function planFrom(raw, pullback, priorBars, source) {
  const snap = snapTrigger(raw, priorBars);
  const trigger = snap.price;
  const low = Math.min(...pullback.map(bar => bar.low));
  const stop = Math.max(low - 0.01, trigger - 0.20);
  const r = trigger - stop;
  return {
    trigger: round2(trigger),
    stop: round2(stop),
    r: round2(r),
    r1: round2(trigger + r),
    r2: round2(trigger + 2 * r),
    r3: round2(trigger + 3 * r),
    pullback_low: round2(low),
    trigger_label: sourceLabel(source, snap)
  };
}

function replaySetup(completedBars, options = {}) {
  const bars = [...(completedBars || [])].filter(bar => Number.isFinite(bar?.datetime))
    .sort((a, b) => a.datetime - b.datetime);
  const closes = bars.map(bar => Number.isFinite(bar.close) ? bar.close : null);
  const emas = closes.every(Number.isFinite) ? calcExpAverageTOS(closes, 9) : closes.map(() => null);
  const frames = [];
  const transitions = [];
  let phase = 'IDLE';
  let surge = null;
  let pullback = [];
  let failReason = '';
  let failDetail = '';
  let hold = 0;
  let triggeredAt = null;
  let triggeredPrice = null;
  let plan = null;
  let pattern = null;
  let loggedTrigger = null;
  let loggedStop = null;
  let loggedR = null;
  let loggedPattern = null;

  function patternMark() {
    return pattern ? ` (${pattern})` : '';
  }

  function headlineFor(state) {
    if (state === 'SURGE') return 'SURGE: new high on volume';
    if (state === 'PULLBACK') {
      const n = pullback.length;
      return `PULLBACK: ${n} candle${n === 1 ? '' : 's'}`;
    }
    if (state === 'ARMED') return `ARMED: $${pxText(plan?.trigger)}${patternMark()}`;
    if (state === 'TRIGGERED') return `TRIGGERED: broke $${pxText(plan?.trigger)}${patternMark()}`;
    if (state === 'FAILED') return `FAILED: ${failReason}${patternMark()}`;
    return 'IDLE: needs a new high on volume';
  }

  function quoteSubline(state) {
    const label = plan?.trigger_label || '';
    let body = label;
    if (Number.isFinite(plan?.trigger) && Number.isFinite(options.lastPrice)) {
      const cents = Math.round((plan.trigger - options.lastPrice) * 100);
      const sign = cents > 0 ? '+' : '';
      body = label ? `${sign}${cents}c · ${label}` : `${sign}${cents}c`;
    }
    if (state === 'TRIGGERED') {
      const clock = formatEtHms(triggeredAt);
      if (clock) body = body ? `${clock} · ${body}` : clock;
    }
    return body;
  }

  function reason() {
    return headlineFor(phase);
  }

  function legFrom(bar, index) {
    const prior = bars.slice(Math.max(0, index - (legLookback - 1)), index);
    const lows = prior.map(item => item.low).concat(bar.low).filter(Number.isFinite);
    return {
      high: bar.high,
      low: lows.length ? Math.min(...lows) : bar.low,
      highestClose: bar.close,
      bodyTop: Math.max(bar.open, bar.close),
      volumes: [Number(bar.volume) || 0],
      started: bar.datetime ?? null
    };
  }

  function showingPlan() {
    return phase === 'ARMED' || phase === 'TRIGGERED';
  }

  function publish(bar, crossed, why) {
    const lows = pullback.map(item => item.low).filter(Number.isFinite);
    const armed = showingPlan();
    frames.push({
      time: bar?.datetime ?? null,
      state: phase,
      pattern: (armed || phase === 'FAILED') ? pattern : null,
      reason: reason(),
      why: why || '',
      crossed: Boolean(crossed),
      pullback_low: lows.length ? Math.min(...lows) : null,
      trigger: armed ? plan?.trigger ?? null : null,
      stop: armed ? plan?.stop ?? null : null
    });
  }

  function move(to, bar, nextReason, live) {
    const levels = plan || {};
    const nextTrigger = levels.trigger ?? null;
    const nextStop = levels.stop ?? null;
    const nextR = levels.r ?? null;
    const nextPattern = pattern || null;
    const same = to === phase;
    const armedUpdate = to === 'ARMED' && same && (
      nextTrigger !== loggedTrigger || nextStop !== loggedStop || nextR !== loggedR || nextPattern !== loggedPattern
    );
    if (same && to !== 'PULLBACK' && !armedUpdate) return;
    const subline = to === 'FAILED'
      ? failDetail
      : (to === 'ARMED' || to === 'TRIGGERED') ? quoteSubline(to) : '';
    transitions.push({
      at: bar?.datetime ?? null,
      from: phase,
      to,
      pattern: nextPattern,
      trigger: nextTrigger,
      stop: nextStop,
      r: nextR,
      reason: headlineFor(to),
      subline,
      live: Boolean(live)
    });
    phase = to;
    loggedTrigger = nextTrigger;
    loggedStop = nextStop;
    loggedR = nextR;
    loggedPattern = nextPattern;
  }

  function clearLeg() {
    surge = null;
    pullback = [];
    plan = null;
    pattern = null;
    failReason = '';
    failDetail = '';
    triggeredAt = null;
    triggeredPrice = null;
  }

  function fail(bar, text, detail, dropBreak) {
    failReason = text;
    failDetail = detail || '';
    if (dropBreak && pullback.length && pullback[pullback.length - 1] === bar) pullback.pop();
    if (!pattern && pullback.length) {
      pattern = pullback.length >= 4 ? 'Bull Flag' : 'Micro-Pullback';
    }
    move('FAILED', bar, '', false);
    hold = 1;
    plan = null;
    publish(bar, false);
  }

  const baseline = options.surge_volume_baseline || config.surgeVolumeBaseline || '20bar';
  const requireGreen = options.surge_requires_green != null
    ? options.surge_requires_green
    : config.surgeRequiresGreen !== false;
  const retraceRef = options.retrace_reference || config.retraceReference || 'highest_close';
  const legLookback = Number(options.leg_lookback_bars) || config.legLookbackBars || 5;
  const flagMaxBars = Number(options.flag_max_bars) || config.flagMaxBars || 15;
  const avgDaily = Number(options.avg_daily_volume);

  function isOpenBar(bar) {
    return formatEtHms(bar?.datetime).startsWith('09:30');
  }

  function priorVolumes(index) {
    if (baseline === '10bar_ex_open') {
      const prior = bars.slice(Math.max(0, index - 10), index);
      if (prior.length < 10) return null;
      return prior.filter(bar => !isOpenBar(bar)).map(bar => Number(bar.volume) || 0);
    }
    if (index < 20) return null;
    return bars.slice(index - 20, index).map(bar => Number(bar.volume) || 0);
  }

  function volumeOk(index) {
    if (baseline === 'rvol_time_of_day') {
      if (!(avgDaily > 0)) return false;
      return Number(bars[index].volume) > avgDaily / 390;
    }
    const volumes = priorVolumes(index);
    if (!volumes || !volumes.length) return false;
    return Number(bars[index].volume) > average(volumes);
  }

  function volumeNote(index) {
    if (baseline === 'rvol_time_of_day') {
      if (!(avgDaily > 0)) return 'no daily average';
      const line = avgDaily / 390;
      return `volume ${bars[index].volume} vs daily/390 ${line.toFixed(0)}`;
    }
    const volumes = priorVolumes(index);
    if (!volumes || !volumes.length) return baseline === '10bar_ex_open' ? 'need 10 prior bars' : 'need 20 prior bars';
    return `volume ${bars[index].volume} vs ${baseline} avg ${average(volumes).toFixed(0)}`;
  }

  function newTenHigh(bar, prior) {
    const window = prior.slice(-10);
    if (window.length < 10) return false;
    return bar.high > Math.max(...window.map(item => item.high));
  }

  function poleTop() {
    if (retraceRef === 'body_top') return surge.bodyTop;
    if (retraceRef === 'highest_close') return surge.highestClose;
    return surge.high;
  }

  function brokePriorLow(bar) {
    if (pullback.length < 2) return false;
    const priorLow = Math.min(...pullback.slice(0, -1).map(item => item.low));
    return bar.low < priorLow;
  }

  function chartOf(bar) {
    return formatChartHm(bar?.datetime) || '';
  }

  function evaluatePullback(bar, index) {
    const flag = pullback.length >= 4;
    if (pullback.length) pattern = flag ? 'Bull Flag' : 'Micro-Pullback';
    const stamp = chartOf(bar);
    if (pullback.some(item => isHighVolumeSellBar(item, bars))) {
      const item = pullback.find(candle => isHighVolumeSellBar(candle, bars)) || bar;
      const green = surge?.volumes?.length ? Math.max(...surge.volumes) : 0;
      fail(bar, 'heavy selling', `${stamp} · red ${volK(item.volume)} vs green ${volK(green)}`);
      return;
    }
    if (!flag && brokePriorLow(bar)) {
      const priorLow = Math.min(...pullback.slice(0, -1).map(item => item.low));
      fail(bar, 'below pullback low', `${stamp} · ${pxText(bar.low)} vs low ${pxText(priorLow)}`, true);
      return;
    }
    if (flag && pullback.length > flagMaxBars) {
      fail(bar, 'flag too long', `${stamp} · ${pullback.length} candles`);
      return;
    }
    const ema = emas[index];
    if (Number.isFinite(ema) && bar.close < ema) {
      fail(bar, 'lost 9 EMA', `${stamp} · close ${pxText(bar.close)} vs 9 EMA ${pxText(ema)}`);
      return;
    }
    const low = Math.min(...pullback.map(item => item.low));
    const high = Math.max(...pullback.map(item => item.high));
    const top = poleTop();
    const span = top - surge.low;
    const overHalf = span > 0 && top - low > span * 0.5;
    const flagDeep = span > 0 && top - low >= span * 0.5;
    const retracePct = span > 0 ? Math.round((top - low) / span * 100) : 0;
    if (!flag && overHalf) {
      fail(bar, 'retrace over 50%', `${stamp} · ${retracePct}% of the pole`);
      return;
    }
    if (flag && flagDeep) {
      fail(bar, 'flag too deep', `${stamp} · ${retracePct}% of the pole`);
      return;
    }
    if (flag) {
      const poleRange = surge.high - surge.low;
      if (poleRange > 0 && high - low >= poleRange * 0.5) {
        fail(bar, 'flag too loose', `${stamp} · range ${pxText(high - low)} vs half the pole ${pxText(poleRange * 0.5)}`);
        return;
      }
      const surgeAvg = average(surge.volumes);
      const flagAvg = average(pullback.map(item => Number(item.volume) || 0));
      if (!(flagAvg < surgeAvg)) {
        fail(bar, "volume didn't taper", `${stamp} · avg ${Math.round(flagAvg)} vs pole ${Math.round(surgeAvg)}`);
        return;
      }
      if (brokePriorLow(bar)) {
        const priorLow = Math.min(...pullback.slice(0, -1).map(item => item.low));
        fail(bar, 'below flag low', `${stamp} · ${pxText(bar.low)} vs low ${pxText(priorLow)}`, true);
        return;
      }
    }
    const surgeAvg = average(surge.volumes);
    const tapered = pullback.every(item => Number(item.volume) < surgeAvg);
    const shallow = span > 0 && top - low < span * 0.5;
    const heldEma = pullback.every(item => {
      const at = bars.indexOf(item);
      return !Number.isFinite(emas[at]) || item.close >= emas[at];
    });
    if (flag) {
      const text = `${pullback.length}-candle bull flag`;
      plan = planFrom(high, pullback, bars.slice(0, index), 'flag high');
      pattern = 'Bull Flag';
      if (phase === 'SURGE') move('PULLBACK', bar, text);
      move('ARMED', bar, text);
      publish(bar, false);
      return;
    }
    const text = `${pullback.length}-candle pullback`;
    if (tapered && shallow && heldEma) {
      plan = planFrom(pullback[pullback.length - 1].high, pullback, bars.slice(0, index), 'pullback high');
      pattern = 'Micro-Pullback';
      if (phase === 'SURGE') move('PULLBACK', bar, text);
      move('ARMED', bar, text);
    } else if (phase === 'SURGE' || phase === 'ARMED') {
      plan = null;
      pattern = null;
      move('PULLBACK', bar, text);
    }
    publish(bar, false);
  }

  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index];
    if (hold > 0) {
      hold -= 1;
      phase = 'FAILED';
      publish(bar, false);
      continue;
    }
    if (phase === 'FAILED') {
      move('IDLE', bar, 'Needs a new high on volume.');
      clearLeg();
    }

    if (phase === 'IDLE') {
      const greenOk = !requireGreen || isGreen(bar);
      const highOk = newTenHigh(bar, bars.slice(0, index));
      const volOk = volumeOk(index);
      if (greenOk && highOk && volOk) {
        surge = legFrom(bar, index);
        pullback = [];
        move('SURGE', bar, 'New high on volume.');
      }
      const missing = [];
      if (!greenOk) missing.push('not green');
      if (!highOk) missing.push('not a new 10-bar high');
      if (!volOk) missing.push(volumeNote(index));
      publish(bar, false, missing.length ? missing.join('; ') : '');
      continue;
    }

    if (phase === 'SURGE') {
      const ema = emas[index];
      if (Number.isFinite(ema) && bar.close < ema) {
        const stamp = formatChartHm(bar.datetime) || '';
        fail(bar, 'lost 9 EMA', `${stamp} · close ${pxText(bar.close)} vs 9 EMA ${pxText(ema)}`);
        continue;
      }
      const madeHigh = bar.high > surge.high;
      if (!isRed(bar) && madeHigh) {
        surge.high = Math.max(surge.high, bar.high);
        surge.low = Math.min(surge.low, bar.low);
        surge.highestClose = Math.max(surge.highestClose, bar.close);
        surge.bodyTop = Math.max(surge.bodyTop, bar.open, bar.close);
        surge.volumes.push(Number(bar.volume) || 0);
        publish(bar, false);
        continue;
      }
      pullback = [bar];
      evaluatePullback(bar, index);
      continue;
    }

    if (phase === 'PULLBACK' || phase === 'ARMED') {
      const armedTrigger = plan?.trigger;
      if (phase === 'ARMED' && Number.isFinite(armedTrigger) && bar.high > armedTrigger) {
        if (bar.close > armedTrigger) {
          surge.high = Math.max(surge.high, bar.high);
          surge.low = Math.min(surge.low, bar.low);
          surge.highestClose = Math.max(surge.highestClose, bar.close);
          surge.bodyTop = Math.max(surge.bodyTop, bar.open, bar.close);
          surge.volumes.push(Number(bar.volume) || 0);
          pullback = [];
          plan = null;
          pattern = null;
          move('SURGE', bar, 'New high on volume.');
          publish(bar, true);
        } else {
          const stamp = formatChartHm(bar.datetime) || '';
          fail(bar, 'closed back under the trigger', `${stamp} · close ${pxText(bar.close)} vs ${pxText(armedTrigger)}`);
        }
        continue;
      }
      pullback.push(bar);
      evaluatePullback(bar, index);
    }
  }

  const forming = options.forming;
  const lastPrice = Number.isFinite(options.lastPrice) ? options.lastPrice : null;
  if (phase === 'ARMED' && plan && (forming || lastPrice != null)) {
    const liveHigh = Math.max(
      Number.isFinite(forming?.high) ? forming.high : -Infinity,
      lastPrice != null ? lastPrice : -Infinity
    );
    const liveLow = Math.min(
      Number.isFinite(forming?.low) ? forming.low : Infinity,
      lastPrice != null ? lastPrice : Infinity
    );
    if (Number.isFinite(plan.pullback_low) && liveLow < plan.pullback_low) {
      const ref = forming || bars[bars.length - 1];
      const stamp = formatChartHm(ref?.datetime) || '';
      failReason = pattern === 'Bull Flag' ? 'below flag low' : 'below pullback low';
      failDetail = `${stamp} · ${pxText(liveLow)} vs low ${pxText(plan.pullback_low)}`;
      move('FAILED', ref, '', true);
      hold = 1;
      plan = null;
    } else if (liveHigh > plan.trigger) {
      triggeredAt = Number.isFinite(options.printMs) ? options.printMs : forming?.datetime;
      triggeredPrice = lastPrice != null ? lastPrice : liveHigh;
      move('TRIGGERED', forming || bars[bars.length - 1], '', true);
    }
  } else if (phase === 'IDLE' && forming && bars.length) {
    const last = bars.length - 1;
    if ((!requireGreen || isGreen(forming)) && newTenHigh(forming, bars) && volumeOk(last)) {
      surge = legFrom(forming, bars.length);
      surge.volumes = [Number(bars[last].volume) || 0];
      move('SURGE', forming, 'New high on volume.', true);
    }
  }

  const showPlan = phase === 'ARMED' || phase === 'TRIGGERED' ? plan : null;
  return {
    state: phase,
    pattern: (showingPlan() || phase === 'FAILED') ? pattern : null,
    reason: reason(),
    subline: phase === 'FAILED' ? failDetail : (showingPlan() ? quoteSubline(phase) : ''),
    segments: SEGMENTS[phase] ?? 0,
    pullback_candles: pullback.length,
    surge_at: (phase === 'SURGE' || phase === 'PULLBACK' || phase === 'ARMED' || phase === 'TRIGGERED') && surge
      ? surge.started ?? null
      : null,
    surge_high: surge ? round2(surge.high) : null,
    surge_low: surge ? round2(surge.low) : null,
    pullback_low: showPlan?.pullback_low ?? null,
    trigger: showPlan?.trigger ?? null,
    trigger_label: showPlan?.trigger_label ?? null,
    stop: showPlan?.stop ?? null,
    r: showPlan?.r ?? null,
    r1: showPlan?.r1 ?? null,
    r2: showPlan?.r2 ?? null,
    r3: showPlan?.r3 ?? null,
    triggered_at: phase === 'TRIGGERED' ? triggeredAt : null,
    triggered_price: phase === 'TRIGGERED' && Number.isFinite(triggeredPrice) ? round2(triggeredPrice) : null,
    sources: SOURCES,
    transitions,
    frames,
    latest_bar: bars.length ? bars[bars.length - 1].datetime : null
  };
}

module.exports = { replaySetup, SOURCES };
