'use strict';

const { calcExpAverageTOS } = require('./indicators');
const { findPivotHighs } = require('./signals');
const { config } = require('./store');

const SEGMENTS = { IDLE: 1, SURGE: 2, PULLBACK: 3, ARMED: 4, TRIGGERED: 5, FAILED: 0 };
const SOURCES = [
  'Surge: Web page, "moving with high volume". The 10-bar high and 20-bar average are MY OWN.',
  'Pullback: Web page, "1-3 candle pause".',
  'Retrace: Web page, "shallow". 50% from the highest surge close down to the leg low is MY OWN.',
  '9 EMA: MY OWN. No pullback close under the 9 EMA.',
  'Volume: Web page, "volume tapers". Pullback volume under the surge bars\' average.',
  'Trigger: Web page, "first 1-minute candle breaks its own high after the pullback".',
  'Snap: Web page, "might wait for that clean breakout level". Half dollar, whole dollar, or pivot high within 3¢ above.',
  'Stop: pullback low minus 1¢, web page/PDF. The 20¢ cap under the trigger is MY OWN.',
  'Failed: Web page, "that\'s lunch", plus a retrace over 50%, a close under the 9 EMA, or a print under the pullback low.'
];

function round2(n) {
  return Math.round(n * 100) / 100;
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

function snapTrigger(raw, bars) {
  const ceiling = raw + 0.03;
  const levels = [];
  const step = Math.ceil((raw + 1e-9) * 2) / 2;
  if (step > raw + 1e-9 && step <= ceiling + 1e-9) levels.push(step);
  for (const pivot of findPivotHighs(bars)) {
    if (pivot.price > raw + 1e-9 && pivot.price <= ceiling + 1e-9) levels.push(pivot.price);
  }
  if (!levels.length) return raw;
  return Math.min(...levels);
}

function planFrom(raw, pullback, priorBars) {
  const trigger = snapTrigger(raw, priorBars);
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
    pullback_low: round2(low)
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
  let hold = 0;
  let triggeredAt = null;
  let triggeredPrice = null;
  let plan = null;

  function reason() {
    if (phase === 'FAILED') return failReason;
    if (phase === 'ARMED' || phase === 'PULLBACK') return `${pullback.length}-candle pullback`;
    if (phase === 'SURGE') return 'New high on volume.';
    if (phase === 'TRIGGERED') {
      const clock = formatEtHms(triggeredAt);
      const px = Number.isFinite(triggeredPrice) ? triggeredPrice.toFixed(2) : '';
      return clock ? `${clock} at $${px}` : '';
    }
    return 'Needs a new high on volume.';
  }

  function legFrom(bar, index) {
    const prior = bars.slice(Math.max(0, index - (legLookback - 1)), index);
    const lows = prior.map(item => item.low).concat(bar.low).filter(Number.isFinite);
    return {
      high: bar.high,
      low: lows.length ? Math.min(...lows) : bar.low,
      highestClose: bar.close,
      bodyTop: Math.max(bar.open, bar.close),
      volumes: [Number(bar.volume) || 0]
    };
  }

  function publish(bar, crossed, why) {
    frames.push({
      time: bar?.datetime ?? null,
      state: phase,
      reason: reason(),
      why: why || '',
      crossed: Boolean(crossed)
    });
  }

  function move(to, bar, nextReason, live) {
    if (to === phase && to !== 'PULLBACK') return;
    const levels = plan || {};
    transitions.push({
      at: bar?.datetime ?? null,
      from: phase,
      to,
      trigger: levels.trigger ?? null,
      stop: levels.stop ?? null,
      reason: nextReason || '',
      live: Boolean(live)
    });
    phase = to;
  }

  function clearLeg() {
    surge = null;
    pullback = [];
    plan = null;
    triggeredAt = null;
    triggeredPrice = null;
  }

  function fail(bar, text) {
    failReason = text;
    move('FAILED', bar, text);
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
  const pullbackFailAt = Number(options.pullback_fail_at) || 4;
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

  function evaluatePullback(bar, index) {
    if (pullback.length >= pullbackFailAt) {
      const nth = pullback.length === 4 ? '4th' : `${pullback.length}th`;
      fail(bar, isRed(bar) ? `Failed: ${nth} red candle` : `Failed: ${nth} pullback candle`);
      return;
    }
    const ema = emas[index];
    if (Number.isFinite(ema) && bar.close < ema) {
      fail(bar, 'Failed: close below the 9 EMA');
      return;
    }
    if (pullback.length > 1) {
      const priorLow = Math.min(...pullback.slice(0, -1).map(item => item.low));
      if (bar.low < priorLow) {
        fail(bar, 'Failed: below pullback low');
        return;
      }
    }
    const low = Math.min(...pullback.map(item => item.low));
    const top = retraceRef === 'highest_close' ? surge.highestClose
      : retraceRef === 'body_top' ? surge.bodyTop
      : surge.high;
    const span = top - surge.low;
    if (span > 0 && top - low > span * 0.5) {
      fail(bar, 'Failed: retrace over 50%');
      return;
    }
    const surgeAvg = average(surge.volumes);
    const tapered = pullback.every(item => Number(item.volume) < surgeAvg);
    const shallow = span > 0 && top - low < span * 0.5;
    const heldEma = pullback.every(item => {
      const at = bars.indexOf(item);
      return !Number.isFinite(emas[at]) || item.close >= emas[at];
    });
    const text = `${pullback.length}-candle pullback`;
    if (tapered && shallow && heldEma) {
      plan = planFrom(pullback[pullback.length - 1].high, pullback, bars.slice(0, index));
      if (phase === 'SURGE') move('PULLBACK', bar, text);
      if (phase !== 'ARMED') move('ARMED', bar, text);
    } else if (phase === 'SURGE' || phase === 'ARMED') {
      plan = null;
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
        fail(bar, 'Failed: close below the 9 EMA');
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
          move('SURGE', bar, 'New high on volume.');
          publish(bar, true);
        } else {
          fail(bar, 'Failed: closed back under the trigger');
        }
        continue;
      }
      const priorLow = pullback.length ? Math.min(...pullback.map(item => item.low)) : null;
      if (Number.isFinite(priorLow) && bar.low < priorLow) {
        fail(bar, 'Failed: below pullback low');
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
      failReason = 'Failed: below pullback low';
      move('FAILED', forming || bars[bars.length - 1], failReason, true);
      hold = 1;
      plan = null;
    } else if (liveHigh > plan.trigger) {
      triggeredAt = Number.isFinite(options.printMs) ? options.printMs : forming?.datetime;
      triggeredPrice = lastPrice != null ? lastPrice : liveHigh;
      const clock = formatEtHms(triggeredAt);
      move('TRIGGERED', forming || bars[bars.length - 1], `${clock} at $${Number(triggeredPrice).toFixed(2)}`, true);
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
    reason: reason(),
    segments: SEGMENTS[phase] ?? 0,
    pullback_candles: pullback.length,
    surge_high: surge ? round2(surge.high) : null,
    surge_low: surge ? round2(surge.low) : null,
    pullback_low: showPlan?.pullback_low ?? null,
    trigger: showPlan?.trigger ?? null,
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
