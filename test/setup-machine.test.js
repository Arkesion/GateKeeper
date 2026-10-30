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
  assert.equal(armed.pullback_candles, 2);
  assert.equal(armed.trigger, 4.36);
  assert.equal(armed.reason, '2-candle pullback');
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
  assert.equal(live.reason, '09:54:12 at $4.41');

  bars.push(bar(24, { open: 4.35, high: 4.50, low: 4.34, close: 4.48, volume: 80 }));
  const again = replaySetup(bars);
  assert.equal(again.state, 'SURGE');
  assert.equal(again.frames[24].crossed, true);
});

test('four pullback candles fail, and a red fourth says so', () => {
  const bars = base();
  bars.push(bar(20, { open: 4.10, high: 4.30, low: 4.12, close: 4.28, volume: 250 }));
  bars.push(bar(21, { open: 4.28, high: 4.45, low: 4.25, close: 4.42, volume: 180 }));
  bars.push(bar(22, { open: 4.42, high: 4.40, low: 4.32, close: 4.34, volume: 40 }));
  bars.push(bar(23, { open: 4.34, high: 4.36, low: 4.33, close: 4.35, volume: 30 }));
  bars.push(bar(24, { open: 4.35, high: 4.35, low: 4.33, close: 4.34, volume: 20 }));
  const third = replaySetup(bars);
  assert.equal(third.state, 'ARMED');
  assert.equal(third.pullback_candles, 3);
  bars.push(bar(25, { open: 4.34, high: 4.34, low: 4.33, close: 4.33, volume: 20 }));
  const failed = replaySetup(bars);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.reason, 'Failed: 4th red candle');
  bars.push(bar(26, { open: 4.33, high: 4.34, low: 4.32, close: 4.33, volume: 20 }));
  assert.equal(replaySetup(bars).state, 'FAILED');
  bars.push(bar(27, { open: 4.33, high: 4.34, low: 4.32, close: 4.34, volume: 20 }));
  assert.equal(replaySetup(bars).state, 'IDLE');
});

test('a close under the 9 EMA fails without a deep retrace', () => {
  const bars = base();
  bars.push(bar(20, { open: 4.10, high: 4.50, low: 3.50, close: 4.40, volume: 400 }));
  const before = replaySetup(bars);
  assert.equal(before.state, 'SURGE');
  bars.push(bar(21, { open: 4.40, high: 4.42, low: 4.02, close: 4.02, volume: 30 }));
  const failed = replaySetup(bars);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.reason, 'Failed: close below the 9 EMA');
});

test('a retrace over 50% fails', () => {
  const bars = base();
  bars.push(bar(20, { open: 4.10, high: 5.00, low: 4.00, close: 4.90, volume: 400 }));
  bars.push(bar(21, { open: 4.90, high: 4.92, low: 4.20, close: 4.70, volume: 30 }));
  const failed = replaySetup(bars);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.reason, 'Failed: retrace over 50%');
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
