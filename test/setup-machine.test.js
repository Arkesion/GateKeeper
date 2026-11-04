'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { replaySetup } = require('../lib/setup-machine');

const START = Date.parse('2026-10-30T13:30:00Z');
const KNOWN = new Set(['IDLE', 'SURGE', 'PULLBACK', 'ARMED', 'TRIGGERED', 'FAILED']);

function bar(index, fields) {
  return {
    datetime: START + index * 60000,
    open: 4,
    high: 4.10,
    low: 3.98,
    close: 4.02,
    volume: 100,
    ...fields
  };
}

function base(count = 20) {
  const bars = [];
  for (let i = 0; i < count; i++) bars.push(bar(i));
  return bars;
}

function etHm(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(ms));
  const get = type => parts.find(part => part.type === type).value;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${hour}:${get('minute')}`;
}

test('clean surge, two-candle pullback, armed, triggered, then surge', () => {
  const bars = base();
  bars.push(bar(20, { open: 4.10, high: 4.30, low: 4.12, close: 4.28, volume: 250 }));
  bars.push(bar(21, { open: 4.28, high: 4.45, low: 4.25, close: 4.42, volume: 180 }));
  bars.push(bar(22, { open: 4.42, high: 4.40, low: 4.32, close: 4.34, volume: 40 }));
  bars.push(bar(23, { open: 4.34, high: 4.36, low: 4.33, close: 4.35, volume: 30 }));
  const armed = replaySetup(bars);
  assert.equal(armed.state, 'ARMED');
  assert.equal(armed.pattern, 'Micro-Pullback');
  assert.equal(armed.pullback_candles, 2);
  assert.equal(armed.trigger, 4.36);
  assert.equal(armed.trigger_label, 'pullback high');
  assert.equal(armed.reason, 'ARMED: $4.36 (Micro-Pullback)');
  const names = armed.transitions.map(step => step.to);
  assert.ok(names.includes('SURGE'));
  assert.ok(names.includes('PULLBACK'));
  assert.ok(names.includes('ARMED'));

  const live = replaySetup(bars, {
    forming: { datetime: START + 24 * 60000, open: 4.35, high: 4.42, low: 4.34, close: 4.41, volume: 10 },
    lastPrice: 4.41,
    printMs: START + 24 * 60000 + 12000
  });
  assert.equal(live.state, 'TRIGGERED');
  assert.equal(live.pattern, 'Micro-Pullback');
  assert.equal(live.reason, 'TRIGGERED: broke $4.36 (Micro-Pullback)');
  assert.match(live.subline, /^09:54:12 · /);

  bars.push(bar(24, { open: 4.35, high: 4.50, low: 4.34, close: 4.48, volume: 80 }));
  const again = replaySetup(bars);
  assert.equal(again.state, 'SURGE');
  assert.equal(again.frames[24].crossed, true);
});

test('the label switches to Bull Flag at candle 4 and the trigger moves to the consolidation high', () => {
  const bars = base();
  bars.push(bar(20, { open: 4.10, high: 4.30, low: 4.12, close: 4.28, volume: 250 }));
  bars.push(bar(21, { open: 4.28, high: 4.45, low: 4.25, close: 4.42, volume: 180 }));
  bars.push(bar(22, { open: 4.42, high: 4.40, low: 4.32, close: 4.34, volume: 40 }));
  bars.push(bar(23, { open: 4.34, high: 4.36, low: 4.33, close: 4.35, volume: 30 }));
  bars.push(bar(24, { open: 4.35, high: 4.35, low: 4.33, close: 4.34, volume: 20 }));
  const third = replaySetup(bars);
  assert.equal(third.state, 'ARMED');
  assert.equal(third.pattern, 'Micro-Pullback');
  assert.equal(third.trigger, 4.35);
  bars.push(bar(25, { open: 4.34, high: 4.34, low: 4.33, close: 4.33, volume: 20 }));
  const flag = replaySetup(bars);
  assert.equal(flag.state, 'ARMED');
  assert.equal(flag.pattern, 'Bull Flag');
  assert.equal(flag.trigger, 4.40);
  assert.equal(flag.trigger_label, 'flag high');
  const flip = flag.transitions.filter(step => step.to === 'ARMED');
  assert.equal(flip.at(-1).pattern, 'Bull Flag');
  assert.equal(flip.at(-1).trigger, 4.40);
  assert.equal(flip.at(-1).from, 'ARMED');
});

test('a close under the 9 EMA fails without a deep retrace', () => {
  const bars = base();
  bars.push(bar(20, { open: 4.10, high: 4.50, low: 3.50, close: 4.40, volume: 400 }));
  const before = replaySetup(bars);
  assert.equal(before.state, 'SURGE');
  bars.push(bar(21, { open: 4.40, high: 4.42, low: 4.02, close: 4.02, volume: 30 }));
  const failed = replaySetup(bars);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.reason, 'FAILED: lost 9 EMA');
  assert.equal(failed.pattern, null);
});

test('a retrace over 50% fails', () => {
  const bars = base();
  bars.push(bar(20, { open: 4.10, high: 5.00, low: 4.00, close: 4.90, volume: 400 }));
  bars.push(bar(21, { open: 4.90, high: 4.92, low: 4.20, close: 4.70, volume: 30 }));
  const failed = replaySetup(bars);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.reason, 'FAILED: retrace over 50% (Micro-Pullback)');
});

test('trigger snaps to the half dollar within 3c and steps down', () => {
  const bars = base();
  bars.push(bar(20, { open: 4.10, high: 4.60, low: 4.20, close: 4.55, volume: 300 }));
  bars.push(bar(21, { open: 4.55, high: 4.48, low: 4.40, close: 4.46, volume: 40 }));
  const snapped = replaySetup(bars);
  assert.equal(snapped.state, 'ARMED');
  assert.equal(snapped.trigger, 4.5);
  bars.push(bar(22, { open: 4.46, high: 4.40, low: 4.41, close: 4.42, volume: 30 }));
  const lower = replaySetup(bars);
  assert.equal(lower.state, 'ARMED');
  assert.equal(lower.trigger, 4.4);
});

test('stop uses the 20c cap under the trigger', () => {
  const bars = base();
  bars.push(bar(20, { open: 4.20, high: 5.00, low: 4.00, close: 4.90, volume: 400 }));
  bars.push(bar(21, { open: 4.90, high: 4.80, low: 4.55, close: 4.70, volume: 20 }));
  const armed = replaySetup(bars);
  assert.equal(armed.state, 'ARMED');
  assert.equal(armed.trigger, 4.8);
  assert.equal(armed.stop, 4.6);
  assert.equal(armed.r, 0.2);
  assert.equal(armed.r2, 5.2);
});

test('leg low is the lowest of the five bars ending at the surge bar', () => {
  const bars = base();
  bars[19] = bar(19, { low: 3.50 });
  bars.push(bar(20, { open: 4.10, high: 4.30, low: 4.12, close: 4.28, volume: 250 }));
  const surge = replaySetup(bars);
  assert.equal(surge.state, 'SURGE');
  assert.equal(surge.surge_low, 3.5);
});

function around(level) {
  const bars = base();
  for (let i = 0; i < 20; i++) {
    bars[i] = bar(i, {
      open: level,
      high: round(level + 0.05),
      low: round(level - 0.02),
      close: round(level + 0.02),
      volume: 100
    });
  }
  return bars;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

test('a 6-candle tight low-volume consolidation arms as a Bull Flag at its high', () => {
  const bars = base();
  bars.push(bar(20, { open: 4.10, high: 4.30, low: 4.12, close: 4.28, volume: 250 }));
  bars.push(bar(21, { open: 4.28, high: 4.45, low: 4.25, close: 4.42, volume: 180 }));
  for (let i = 0; i < 6; i++) {
    bars.push(bar(22 + i, { open: 4.40, high: 4.40, low: 4.34, close: 4.36, volume: 20 }));
  }
  const flag = replaySetup(bars);
  assert.equal(flag.state, 'ARMED');
  assert.equal(flag.pattern, 'Bull Flag');
  assert.equal(flag.pullback_candles, 6);
  assert.equal(flag.trigger, 4.40);
  assert.equal(flag.trigger_label, 'flag high');
  assert.ok(flag.stop <= flag.trigger);
  assert.equal(flag.r, round(flag.trigger - flag.stop));
});

test('a 6-candle flag fails when it is deep, loose, or heavier than the pole', () => {
  const deep = around(4.40);
  deep.push(bar(20, { open: 4.50, high: 4.90, low: 4.55, close: 4.80, volume: 400 }));
  for (let i = 0; i < 5; i++) {
    deep.push(bar(21 + i, { open: 4.78, high: 4.76, low: 4.70, close: 4.74, volume: 20 }));
  }
  deep.push(bar(26, { open: 4.74, high: 4.74, low: 4.50, close: 4.70, volume: 20 }));
  assert.equal(replaySetup(deep).reason, 'FAILED: flag too deep (Bull Flag)');

  const loose = around(4.40);
  loose.push(bar(20, { open: 4.55, high: 5.00, low: 4.40, close: 4.60, volume: 400 }));
  for (let i = 0; i < 5; i++) {
    loose.push(bar(21 + i, { open: 4.80, high: 4.97, low: 4.68, close: 4.80, volume: 20 }));
  }
  loose.push(bar(26, { open: 4.80, high: 4.99, low: 4.68, close: 4.90, volume: 20 }));
  const looseSetup = replaySetup(loose);
  assert.equal(looseSetup.reason, 'FAILED: flag too loose (Bull Flag)');

  const heavy = around(4.40);
  heavy.push(bar(20, { open: 4.50, high: 4.90, low: 4.55, close: 4.80, volume: 400 }));
  for (let i = 0; i < 5; i++) {
    heavy.push(bar(21 + i, { open: 4.78, high: 4.76, low: 4.70, close: 4.74, volume: 20 }));
  }
  heavy.push(bar(26, { open: 4.72, high: 4.75, low: 4.70, close: 4.74, volume: 5000 }));
  assert.equal(replaySetup(heavy).reason, "FAILED: volume didn't taper (Bull Flag)");
});

test('a red pullback heavier than the largest surge candle fails, and a forming bar does not re-arm', () => {
  const bars = base();
  bars.push(bar(20, { open: 4.12, high: 4.20, low: 4.14, close: 4.18, volume: 200 }));
  bars.push(bar(21, { open: 4.18, high: 4.32, low: 4.20, close: 4.30, volume: 220 }));
  bars.push(bar(22, { open: 4.30, high: 4.44, low: 4.32, close: 4.42, volume: 240 }));
  bars.push(bar(23, { open: 4.42, high: 4.60, low: 4.44, close: 4.56, volume: 800 }));
  const surged = replaySetup(bars);
  assert.equal(surged.state, 'SURGE');
  bars.push(bar(24, { open: 4.56, high: 4.54, low: 4.48, close: 4.50, volume: 900 }));
  const failed = replaySetup(bars);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.reason, 'FAILED: heavy selling (Micro-Pullback)');
  assert.match(failed.subline, /red 900 vs green 800/);
  const forming = replaySetup(bars, {
    forming: { datetime: START + 25 * 60000, open: 4.50, high: 4.52, low: 4.49, close: 4.51, volume: 30 }
  });
  assert.equal(forming.state, 'FAILED');
  assert.equal(forming.reason, 'FAILED: heavy selling (Micro-Pullback)');
});

test('a flag longer than 15 candles fails flag too long', () => {
  const bars = around(4.40);
  bars.push(bar(20, { open: 4.50, high: 4.90, low: 4.55, close: 4.80, volume: 400 }));
  for (let i = 0; i < 15; i++) {
    bars.push(bar(21 + i, { open: 4.78, high: 4.76, low: 4.70, close: 4.74, volume: 20 }));
  }
  const held = replaySetup(bars);
  assert.equal(held.state, 'ARMED');
  assert.equal(held.pattern, 'Bull Flag');
  bars.push(bar(36, { open: 4.74, high: 4.75, low: 4.70, close: 4.73, volume: 20 }));
  assert.equal(replaySetup(bars).reason, 'FAILED: flag too long (Bull Flag)');
});

test('a whole dollar within 3c snaps for a micro-pullback and a bull flag', () => {
  const micro = around(4.70);
  micro.push(bar(20, { open: 4.80, high: 5.20, low: 4.85, close: 5.10, volume: 400 }));
  micro.push(bar(21, { open: 5.10, high: 4.99, low: 4.94, close: 4.96, volume: 30 }));
  micro.push(bar(22, { open: 4.96, high: 4.98, low: 4.94, close: 4.95, volume: 20 }));
  const microSetup = replaySetup(micro);
  assert.equal(microSetup.pattern, 'Micro-Pullback');
  assert.equal(microSetup.trigger, 5);
  assert.equal(microSetup.trigger_label, 'snapped to $5.00 (whole dollar)');

  const flag = around(4.70);
  flag.push(bar(20, { open: 4.80, high: 5.20, low: 4.85, close: 5.10, volume: 400 }));
  for (let i = 0; i < 6; i++) {
    flag.push(bar(21 + i, { open: 5.05, high: 4.98, low: 4.94, close: 4.96, volume: 20 }));
  }
  const flagSetup = replaySetup(flag);
  assert.equal(flagSetup.pattern, 'Bull Flag');
  assert.equal(flagSetup.trigger, 5);
  assert.equal(flagSetup.trigger_label, 'snapped to $5.00 (whole dollar)');
});

test('TNMG 09:30 through 10:10 reports the setup sequence', () => {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'tnmg-2026-10-30.json'),
    'utf8'
  ));
  const through = fixture.bars.filter(item => etHm(item.datetime) <= '10:10');
  const replay = replaySetup(through);
  const window = replay.frames.filter(frame => {
    const hm = etHm(frame.time);
    return hm >= '09:30' && hm <= '10:10';
  });
  assert.ok(window.length > 30);
  const wick = window.find(frame => etHm(frame.time) === '09:41');
  assert.equal(wick.state, 'IDLE');
  let last = '';
  for (const frame of window) {
    assert.ok(KNOWN.has(frame.state), frame.state);
    const hm = etHm(frame.time);
    assert.ok(hm >= last);
    last = hm;
    const mark = frame.crossed ? ' crossed' : '';
    console.log(`tnmg setup ${hm} ${frame.state}${mark} ${frame.reason}`);
  }
});
