'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { calcVWAP } = require('../lib/indicators');
const { trafficBanner } = require('../lib/signals');
const {
  isHighVolumeSellBar,
  isBullishBar,
  isBearishBar,
  isToppingTailBar,
  formatEtHm,
  macdGospelPositive,
  buildNotes,
  relativeVolume,
  rvolColor,
  computeResistanceSignal,
  computeFrontSideSignal,
  activeToppingTail,
  isLargeSellCandleBar,
  latestHvSellTime,
  latestLargeSellTime
} = require('../lib/signals');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/tnmg-2026-10-30.json'),
  'utf8'
));
const bars = fixture.bars;

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

function barAt(hm) {
  const bar = bars.find(item => etHm(item.datetime) === hm);
  assert.ok(bar, `missing ${hm}`);
  return bar;
}

test('MACD gospel is histogram above 0, not the MACD line', () => {
  const macdLine = 0.04;
  const signalLine = 0.06;
  const histogram = macdLine - signalLine;
  assert.ok(macdLine > 0);
  assert.ok(histogram < 0);
  assert.equal(macdGospelPositive(histogram), false);
  assert.equal(macdGospelPositive(0.02), true);
});

test('HV-sell cites only red bars and labels the bar start', () => {
  const green = barAt('10:02');
  const red = barAt('10:03');
  assert.equal(isBullishBar(green), true, '10:02 start is the large green buy');
  assert.equal(formatEtHm(green.datetime), '10:02');
  assert.equal(isHighVolumeSellBar(green, bars), false);
  assert.equal(isBearishBar(red), true, '10:03 start is red, not the green buy');
  assert.equal(formatEtHm(red.datetime), '10:03');
  for (const bar of bars) {
    if (!isHighVolumeSellBar(bar, bars)) continue;
    assert.equal(isBearishBar(bar), true, formatEtHm(bar.datetime));
    assert.equal(formatEtHm(bar.datetime), etHm(bar.datetime));
  }
});

test('4.67 wick is a topping tail; 09:48 and 09:52 dojis are not', () => {
  const wick = barAt('09:41');
  assert.ok(wick.high >= 4.66 && wick.high < 4.68);
  assert.equal(isToppingTailBar(wick, bars), true);
  assert.equal(isToppingTailBar(barAt('09:48'), bars), false);
  assert.equal(isToppingTailBar(barAt('09:52'), bars), false);
});

test('notes are one side each, one bar each, and do not change ALIGNED', () => {
  const notes = buildNotes(bars, { vwap: 4.5, ema9: 4.4, ema20: 4.45 });
  const sides = new Set(['BEAR', 'NEUTRAL', 'BULL']);
  const times = notes.map(note => note.time);
  assert.equal(new Set(times).size, times.length);
  for (const note of notes) assert.ok(sides.has(note.side));
  const consolidating = notes.filter(note => note.text.startsWith('Consolidating near $'));
  for (const note of consolidating) assert.equal(note.side, 'NEUTRAL');
  const belowEma = notes.filter(note => note.text === 'Below 9/20 EMA');
  assert.ok(belowEma.length <= 1);
  const belowVwap = notes.find(note => note.text === 'Below VWAP');
  if (belowVwap) assert.equal(belowVwap.side, 'BEAR');

  let t = Date.parse('2026-10-30T14:00:00.000Z');
  const synth = [];
  for (let i = 0; i < 4; i++) {
    synth.push({ datetime: t, open: 4, high: 4.2, low: 3.98, close: 4.15, volume: 100000 });
    t += 60000;
  }
  synth.push({ datetime: t, open: 4.15, high: 4.16, low: 4.14, close: 4.145, volume: 1000 });
  const quiet = buildNotes(synth, { vwap: 5, ema9: 4.5, ema20: 4.6 });
  const pause = quiet.find(note => note.text.startsWith('Consolidating near $'));
  assert.ok(pause, 'tape slowdown is a consolidating note');
  assert.equal(pause.side, 'NEUTRAL');
  assert.equal(quiet.filter(note => note.text === 'Below 9/20 EMA').length, 1);
  assert.equal(trafficBanner(
    { macd: true, no_hv_sell: true, no_big_red: true, no_topping_tail: true, spread_ok: true },
    { resistance: { state: 'red', phase: 'near' } },
    { front_side: { state: 'green' } },
    { state: 'green' }
  ), 'ALIGNED');
});

test('TNMG notes name the tail, the support hold, and the large buy', () => {
  const supportBar = barAt('09:52');
  const notes = buildNotes(bars, { support: supportBar.low });
  const tail = notes.find(note => note.text === 'Topping tail');
  const held = notes.find(note => note.text.startsWith('Held support'));
  const buy = notes.find(note => note.text === 'Large buy volume');
  assert.equal(tail && tail.side, 'BEAR');
  assert.equal(tail && tail.time, '09:41');
  assert.equal(buy && buy.side, 'BULL');
  assert.equal(buy && buy.time, '10:02');
  assert.equal(held && held.side, 'BULL');
  assert.equal(held && held.time, '10:15');
});

test('RVOL uses the prior 10 completed days and not today', () => {
  const now = Date.parse('2026-10-30T15:00:00Z');
  const midnight = Date.parse('2026-10-30T04:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const daily = [];
  for (let i = 1; i <= 10; i++) {
    daily.push({ datetime: midnight - i * day, volume: 100000, open: 1, high: 1, low: 1, close: 1 });
  }
  daily.push({ datetime: midnight, volume: 9000000, open: 1, high: 1, low: 1, close: 1 });
  const session = [{ datetime: now, volume: 600000, open: 1, high: 1, low: 1, close: 1 }];
  assert.equal(relativeVolume(daily, session, now), 6);
  assert.equal(rvolColor(6), '#FBBF24');
  assert.equal(rvolColor(20), '#1FC08A');
  assert.equal(rvolColor(20.1), '#C4B5FD');
  assert.equal(relativeVolume([], session, now), null);
});

test('daily resistance fails only when the nearest prior high is within 10%', () => {
  const now = Date.parse('2026-10-30T15:14:00Z');
  const yesterday = Date.parse('2026-10-29T04:00:00Z');
  const today = Date.parse('2026-10-30T04:00:00Z');
  const bar = (datetime, high) => ({ datetime, high, low: 1, open: 1, close: 1, volume: 1 });
  const far = computeResistanceSignal(3.23, [bar(yesterday, 3.65)], now);
  assert.equal(far.state, 'green');
  assert.equal(far.distance_pct, 13);
  const near = computeResistanceSignal(3.23, [bar(yesterday, 3.50)], now);
  assert.equal(near.state, 'red');
  assert.equal(near.level_price, 3.5);
  assert.equal(near.reason, 'Daily res. 3.50 +8%');
  const ignored = computeResistanceSignal(3.23, [bar(yesterday, 4), bar(today, 3.30)], now);
  assert.equal(ignored.state, 'green');
  assert.equal(ignored.level_price, 4);
  assert.equal(computeResistanceSignal(3.23, [], now).phase, 'no_daily_data');
  const front = computeFrontSideSignal(
    [{ datetime: now, open: 3.3, high: 3.4, low: 3.2, close: 3.35, volume: 1 }],
    3.1,
    3.2,
    3.15
  );
  assert.notEqual(front.phase, 'below_ema9');
});

test('VWAP anchor sweep at 09:56 is reported and does not change the formula', () => {
  const end = barAt('09:56');
  const through = bars.filter(bar => bar.datetime <= end.datetime);
  const anchors = [4 * 60, 7 * 60, 9 * 60 + 30];
  const scored = [];
  for (const anchor of anchors) {
    for (const premarket of [true, false]) {
      const slice = through.filter(bar => {
        const mins = Number(etHm(bar.datetime).slice(0, 2)) * 60 + Number(etHm(bar.datetime).slice(3));
        if (mins < anchor) return false;
        if (!premarket && mins < 9 * 60 + 30) return false;
        return true;
      });
      const vwap = calcVWAP(slice);
      const label = `${String(Math.floor(anchor / 60)).padStart(2, '0')}:${String(anchor % 60).padStart(2, '0')} ${premarket ? 'with-premarket' : 'rth-only'}`;
      scored.push({ label, vwap, delta: vwap - 4.317 });
      assert.equal(Number.isFinite(vwap), true, label);
    }
  }
  scored.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
  const rth = scored.find(row => row.label === '09:30 rth-only');
  assert.ok(Math.abs(rth.vwap - 4.317) < 0.002, rth.vwap);
  for (const row of scored) {
    console.log(`tnmg vwap ${row.label} ${row.vwap.toFixed(4)} delta=${row.delta.toFixed(4)}`);
  }
});

test('topping tail chip cites 09:41 through 09:44 and clears once 09:44 has closed', () => {
  function closedBefore(hm) {
    return bars.filter(bar => bar.datetime < barAt(hm).datetime);
  }
  for (const hm of ['09:42', '09:43', '09:44']) {
    const hit = activeToppingTail(closedBefore(hm));
    assert.equal(formatEtHm(hit.datetime), '09:41', hm);
  }
  assert.equal(activeToppingTail(closedBefore('09:45')), null);
});

test('11:10 volume and body chips cite that bar separately', () => {
  const recorded = [
    { open: 3.225, high: 3.269, low: 3.2202, close: 3.26, volume: 48458 },
    { open: 3.259, high: 3.27, low: 3.18, close: 3.2101, volume: 76643 },
    { open: 3.2201, high: 3.235, low: 3.1901, close: 3.2301, volume: 31275 },
    { open: 3.22, high: 3.2601, low: 3.205, close: 3.2099, volume: 28391 },
    { open: 3.21, high: 3.215, low: 3.19, close: 3.2101, volume: 26491 },
    { open: 3.20, high: 3.24, low: 3.15, close: 3.17, volume: 98815 }
  ];
  const start = Date.parse('2026-10-30T15:05:00.000Z');
  const series = recorded.map((bar, index) => ({ ...bar, datetime: start + index * 60000 }));
  const sell = series[series.length - 1];
  const now = sell.datetime + 30000;
  assert.equal(formatEtHm(sell.datetime), '11:10');
  assert.equal(isHighVolumeSellBar(sell, series), true);
  assert.equal(isLargeSellCandleBar(sell, series), true);
  assert.equal(latestHvSellTime(series, now), '11:10');
  assert.equal(latestLargeSellTime(series, now), '11:10');
});
