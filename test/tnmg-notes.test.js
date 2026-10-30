'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { calcVWAP, getCompleted1mBars } = require('../lib/indicators');
const { trafficBanner } = require('../lib/signals');
const {
  isHighVolumeSellBar,
  isHighVolumeBuyBar,
  isBullishBar,
  isBearishBar,
  isToppingTailBar,
  formatEtHm,
  formatChartHm,
  pricePillLabel,
  activeEvent,
  zoomWindow,
  macdGospelPositive,
  buildNotes,
  relativeVolume,
  rvolColor,
  computeResistanceSignal,
  computeGivebackSignal,
  computeFrontSideSignal,
  activeToppingTail,
  isLargeSellCandleBar,
  latestHvSellTime,
  latestLargeSellTime
} = require('../lib/signals');
const { buildSession1mBars, buildIndicator1mBars, sessionLow } = require('../lib/session');
const { eventsAreStale, logSignalState, resetSignalLog } = require('../lib/state');

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
  assert.ok(pause, 'a tight bar under the prior high is consolidating');
  assert.equal(pause.side, 'NEUTRAL');
  const wide = synth.slice(0, 4).concat([{
    datetime: t + 60000, open: 4.15, high: 4.5, low: 4.0, close: 4.2, volume: 1000
  }]);
  assert.equal(buildNotes(wide, { vwap: 5, ema9: 4.5, ema20: 4.6 })
    .some(note => note.text.startsWith('Consolidating near $')), false);
  const tight = synth.slice(0, 4).concat([{
    datetime: t + 120000, open: 4.15, high: 4.16, low: 4.14, close: 4.145, volume: 100000
  }]);
  assert.ok(buildNotes(tight, { vwap: 5, ema9: 4.5, ema20: 4.6 })
    .some(note => note.text.startsWith('Consolidating near $')));
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
  assert.equal(tail && tail.time, '09:42');
  assert.equal(buy && buy.side, 'BULL');
  assert.equal(buy && buy.time, '10:03');
  assert.equal(held && held.side, 'BULL');
  assert.equal(held && held.time, '10:16');
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
  const penny = computeResistanceSignal(3.41, [bar(yesterday, 3.42)], now);
  assert.equal(penny.state, 'red');
  assert.equal(penny.distance_label, '+1¢');
  assert.equal(penny.reason, 'Daily res. 3.42 +1¢');
  const flat = computeResistanceSignal(3.424, [bar(yesterday, 3.426)], now);
  assert.equal(flat.distance_label, '+0¢');
  assert.equal(flat.reason, 'Daily res. 3.43 +0¢');
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

test('event checks fail for 5 minutes, caution through 15, then clear', () => {
  const tail = barAt('09:41');
  const closed = bars.filter(bar => bar.datetime <= tail.datetime);
  const closeAt = tail.datetime + 60000;
  const fresh = activeEvent(closed, isToppingTailBar, closeAt + 60 * 1000, bar => bar.high);
  assert.equal(fresh.phase, 'fail');
  assert.equal(fresh.time, '09:42');
  const caution = activeEvent(closed, isToppingTailBar, closeAt + 9 * 60 * 1000, bar => bar.high);
  assert.equal(caution.phase, 'caution');
  assert.equal(caution.time, '09:42');
  assert.equal(caution.age_min, 9);
  const gone = activeEvent(closed, isToppingTailBar, closeAt + 16 * 60 * 1000, bar => bar.high);
  assert.equal(gone.phase, 'pass');
  const later = {
    datetime: tail.datetime + 60000,
    open: tail.high,
    high: tail.high + 0.05,
    low: tail.high,
    close: tail.high + 0.02,
    volume: 1000
  };
  const cleared = activeEvent([tail, later], isToppingTailBar, later.datetime + 30000, bar => bar.high);
  assert.equal(cleared.phase, 'pass');
  const red = { datetime: closeAt, open: 4, high: 4.2, low: 3.6, close: 3.7, volume: 1000 };
  const isRed = bar => bar.volume === 1000;
  const still = activeEvent([red], isRed, closeAt + 60000, bar => bar.open);
  assert.equal(still.phase, 'fail');
  const back = { datetime: closeAt + 60000, open: 3.8, high: 4.1, low: 3.75, close: 4.05, volume: 10 };
  const opened = activeEvent([red, back], isRed, back.datetime + 30000, bar => bar.open);
  assert.equal(opened.phase, 'pass');
});

test('zoom keeps price in the middle and includes a nearby level', () => {
  const tight = zoomWindow(3.54, []);
  assert.ok(Math.abs((tight.hi - tight.lo) - 0.15) < 1e-9);
  assert.ok(Math.abs(((tight.lo + tight.hi) / 2) - 3.54) < 1e-9);
  const near = zoomWindow(3.54, [3.40, 3.70]);
  assert.ok(near.lo <= 3.40 + 1e-9);
  assert.ok(near.hi >= 3.70 - 1e-9);
  assert.ok(near.hi - near.lo <= 0.60 + 1e-9);
  const span = near.hi - near.lo;
  assert.ok(3.54 >= near.lo + span * 0.2 - 1e-9);
  assert.ok(3.54 <= near.hi - span * 0.2 + 1e-9);
  const far = zoomWindow(3.54, [5.00]);
  assert.ok(far.hi < 5);
  assert.ok(far.hi - far.lo <= 0.60 + 1e-9);
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
  assert.equal(formatChartHm(sell.datetime), '11:11');
  assert.equal(isHighVolumeSellBar(sell, series), true);
  assert.equal(isLargeSellCandleBar(sell, series), true);
  assert.equal(latestHvSellTime(series, now), '11:11');
  assert.equal(latestLargeSellTime(series, now), '11:11');
});

test('chart label is the 12:20 start bar plus one minute', () => {
  // Closed HTTP bar, TNMG 2026-10-30. Start 16:20Z is 12:20 ET. High 3.60, volume 78594.
  const start = Date.parse('2026-10-30T16:20:00.000Z');
  const bar = { datetime: start, open: 3.48, high: 3.6, low: 3.47, close: 3.55, volume: 78594 };
  assert.equal(formatEtHm(bar.datetime), '12:20');
  assert.equal(bar.volume, 78594);
  assert.equal(bar.high, 3.6);
  assert.equal(formatChartHm(bar.datetime), '12:21');
});

test('a near-zero giveback leg does not print a huge percent', () => {
  const start = Date.parse('2026-10-30T18:00:00Z');
  const tiny = [
    { datetime: start, open: 4.00, high: 4.01, low: 4.00, close: 4.01, volume: 1000 },
    { datetime: start + 60000, open: 4.01, high: 4.02, low: 4.01, close: 4.02, volume: 1000 }
  ];
  const small = computeGivebackSignal(tiny, 3.50);
  assert.equal(small.pct, null);
  assert.equal(small.state, 'green');
  assert.equal(small.phase, 'move_too_small');
  const leg = [
    { datetime: start, open: 4.00, high: 4.10, low: 4.00, close: 4.08, volume: 1000 },
    { datetime: start + 60000, open: 4.08, high: 4.12, low: 4.05, close: 4.11, volume: 1000 }
  ];
  const dumped = computeGivebackSignal(leg, 3.11);
  assert.equal(dumped.pct, 100);
  assert.equal(dumped.state, 'red');
  const above = computeGivebackSignal(leg, 4.20);
  assert.equal(above.pct, 0);
  assert.equal(above.state, 'green');
  const none = computeGivebackSignal([
    { datetime: start, open: 4.10, high: 4.12, low: 4.00, close: 4.02, volume: 1000 }
  ], 4.02);
  assert.equal(none.pct, null);
  assert.equal(none.state, 'red');
});

test('the 13:57 buy and the 14:10 sell are events when those bars are present', () => {
  // HTTP bars, TNMG 2026-10-30, from the 13:47 start through the 14:10 start.
  // Chart times are one minute later. A four-minute halt ends at the 13:16 start bar.
  const bars = [{"datetime":1793382420000,"open":3.7136,"high":3.7136,"low":3.68,"close":3.6901,"volume":24186},{"datetime":1793382480000,"open":3.6902,"high":3.72,"low":3.68,"close":3.7143,"volume":10191},{"datetime":1793382540000,"open":3.7002,"high":3.74,"low":3.7001,"close":3.73,"volume":26478},{"datetime":1793382600000,"open":3.73,"high":3.77,"low":3.72,"close":3.77,"volume":18835},{"datetime":1793382660000,"open":3.76,"high":3.89,"low":3.71,"close":3.72,"volume":113159},{"datetime":1793382720000,"open":3.729,"high":3.75,"low":3.7,"close":3.72,"volume":44734},{"datetime":1793382780000,"open":3.735,"high":3.7499,"low":3.7,"close":3.7186,"volume":16879},{"datetime":1793382840000,"open":3.715,"high":3.7798,"low":3.715,"close":3.77,"volume":42265},{"datetime":1793382900000,"open":3.75,"high":3.88,"low":3.75,"close":3.8683,"volume":75585},{"datetime":1793382960000,"open":3.86,"high":4.02,"low":3.83,"close":3.99,"volume":246138},{"datetime":1793383020000,"open":3.995,"high":4.04,"low":3.9,"close":3.96,"volume":237191},{"datetime":1793383080000,"open":3.96,"high":4.012,"low":3.94,"close":3.9535,"volume":118597},{"datetime":1793383140000,"open":3.94,"high":3.94,"low":3.87,"close":3.92,"volume":109081},{"datetime":1793383200000,"open":3.9267,"high":3.95,"low":3.84,"close":3.8787,"volume":74820},{"datetime":1793383260000,"open":3.88,"high":3.9,"low":3.86,"close":3.8801,"volume":28950},{"datetime":1793383320000,"open":3.885,"high":4.01,"low":3.86,"close":3.985,"volume":148011},{"datetime":1793383380000,"open":3.9801,"high":4.1,"low":3.94,"close":3.9599,"volume":167885},{"datetime":1793383440000,"open":3.97,"high":4.045,"low":3.959,"close":4.015,"volume":88877},{"datetime":1793383500000,"open":4.011,"high":4.07,"low":3.96,"close":3.965,"volume":135672},{"datetime":1793383560000,"open":3.96,"high":4,"low":3.88,"close":3.89,"volume":114607},{"datetime":1793383620000,"open":3.8999,"high":3.92,"low":3.8635,"close":3.89,"volume":63571},{"datetime":1793383680000,"open":3.88,"high":3.92,"low":3.8601,"close":3.89,"volume":31591},{"datetime":1793383740000,"open":3.89,"high":3.89,"low":3.71,"close":3.829,"volume":230678},{"datetime":1793383800000,"open":3.8101,"high":3.8499,"low":3.8,"close":3.8035,"volume":35125}];
  const buy = bars.find(bar => bar.volume === 246138);
  const sell = bars.find(bar => bar.volume === 230678);
  assert.equal(formatChartHm(buy.datetime), '13:57');
  assert.equal(isHighVolumeBuyBar(buy, bars), true);
  assert.equal(formatChartHm(sell.datetime), '14:10');
  assert.equal(isHighVolumeSellBar(sell, bars), true);
  const notes = buildNotes(bars, {});
  assert.equal(notes.find(note => note.text === 'Large buy volume').time, '13:57');
  assert.equal(notes.find(note => note.text === 'High-volume sell').time, '14:10');
  assert.ok(notes[0].time > '13:16');
});

test('price pill keeps one level name and counts the rest', () => {
  const names = [
    { name: '9 EMA', role: 'ema9' },
    { name: 'Pivot', role: 'pivot' },
    { name: 'Resistance · Pivot', role: 'resistance' },
    { name: 'VWAP', role: 'vwap' }
  ];
  const pill = pricePillLabel(names, false);
  assert.equal(pill.label, 'PRICE · Resistance · Pivot +3');
  assert.equal(pill.title, 'Resistance · Pivot · VWAP · 9 EMA · Pivot');
  assert.equal(pricePillLabel([], false).label, 'PRICE');
});

test('a post-halt topping tail under the gap floor still reaches the note, the chip, and the log', () => {
  const start = Date.parse('2026-10-30T17:30:00.000Z');
  const bars = [];
  for (let i = 0; i < 26; i++) {
    bars.push({
      datetime: start + i * 60000,
      open: 4.50, high: 4.60, low: 4.40, close: 4.55, volume: 1000
    });
  }
  for (let i = 30; i < 45; i++) {
    bars.push({
      datetime: start + i * 60000,
      open: 3.80, high: 3.84, low: 3.78, close: 3.80, volume: 1000
    });
  }
  const tailAt = start + 45 * 60000;
  bars.push({
    datetime: tailAt,
    open: 3.78, high: 4.00, low: 3.66, close: 3.70, volume: 1000
  });
  bars.push({
    datetime: start + 46 * 60000,
    open: 3.70, high: 3.74, low: 3.66, close: 3.72, volume: 1000
  });
  const now = start + 55 * 60000;
  const quote = { closePrice: 3, lastPrice: 4 };
  const session = buildSession1mBars([bars], quote, now);
  const indicator = buildIndicator1mBars([bars], quote, now);
  assert.equal(session[session.length - 1].datetime, start + 25 * 60000);
  assert.ok(indicator.some(bar => bar.datetime === tailAt));
  const completed = getCompleted1mBars(indicator, now);
  const notes = buildNotes(completed, {});
  const tailNote = notes.find(note => note.text === 'Topping tail');
  assert.equal(tailNote.time, formatChartHm(tailAt));
  const chip = activeEvent(completed, isToppingTailBar, now, bar => bar.high);
  assert.equal(chip.time, formatChartHm(tailAt));
  const logPath = path.join(os.tmpdir(), `gk-signal-${process.pid}.log`);
  fs.writeFileSync(logPath, '');
  const previous = process.env.SIGNAL_LOG;
  process.env.SIGNAL_LOG = logPath;
  resetSignalLog();
  try {
    logSignalState('TNMG', {
      front_side: {
        macd: true,
        spread_ok: true,
        topping_tail_phase: chip.phase,
        topping_tail_time: chip.time
      },
      notes,
      setup: { state: 'IDLE', reason: 'test' },
      giveback: {}
    }, 'NOT ALIGNED');
  } finally {
    if (previous == null) delete process.env.SIGNAL_LOG;
    else process.env.SIGNAL_LOG = previous;
    resetSignalLog();
  }
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const chart = formatChartHm(tailAt);
  assert.ok(lines.some(row => row.kind === 'note' && row.text === 'Topping tail' && row.time === chart));
  assert.ok(lines.some(row => row.kind === 'chip' && row.name === 'tail' && row.time === chart));
  fs.unlinkSync(logPath);
});

test('events are stale only when the note bar lags the indicator bar by more than two minutes', () => {
  const start = Date.parse('2026-10-30T17:30:00.000Z');
  assert.equal(eventsAreStale(start, start + 3 * 60000), true);
  assert.equal(eventsAreStale(start, start + 2 * 60000), false);
  assert.equal(eventsAreStale(start, start), false);
});

test('a 2.95 low on the 4:00 series stays 2.95 beside a 3.00 bar', () => {
  const open = Date.parse('2026-10-30T08:00:00.000Z');
  const low = sessionLow([
    { datetime: open, open: 3.10, high: 3.20, low: 3.05, close: 3.12, volume: 1000 },
    { datetime: open + (3 * 60 + 1) * 60000, open: 3.05, high: 3.10, low: 2.95, close: 3.02, volume: 1000 },
    { datetime: open + 4 * 60 * 60000, open: 3.02, high: 3.08, low: 3.00, close: 3.04, volume: 1000 }
  ]);
  assert.equal(low, 2.95);
});
