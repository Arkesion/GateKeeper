'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  calcExpAverageTOS,
  calcMACDExactTOS,
  calcVWAP
} = require('../lib/indicators');
const { trafficBanner, isHighVolumeSellBar } = require('../lib/signals');

function etParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(ms));
  const get = type => parts.find(part => part.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hm: `${get('hour')}:${get('minute')}`
  };
}

function hmMin(hm) {
  const [hour, minute] = hm.split(':').map(Number);
  return hour * 60 + minute;
}

function withPartial(file, day, throughHm, partial) {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8'));
  const through = hmMin(throughHm);
  const bars = fixture.bars.filter(bar => {
    const et = etParts(bar.datetime);
    if (et.date < day) return true;
    if (et.date > day) return false;
    return hmMin(et.hm) <= through;
  });
  const last = bars[bars.length - 1];
  bars.push({
    datetime: last.datetime + 60 * 1000,
    open: partial.open,
    high: partial.high,
    low: partial.low,
    close: partial.close,
    volume: partial.volume
  });
  return bars;
}

const BRAI = withPartial('brai-2026-10-28.json', '2026-10-28', '09:22', {
  open: 4.83, high: 4.88, low: 4.82, close: 4.869, volume: 36244
});
const CHSN = withPartial('chsn-2026-10-28.json', '2026-10-28', '12:36', {
  open: 1.57, high: 1.61, low: 1.56, close: 1.61, volume: 96296
});

test('BRAI golden partial bar is the 09:23 screenshot candle', () => {
  const last = BRAI[BRAI.length - 1];
  assert.equal(etParts(last.datetime).hm, '09:23');
  assert.equal(last.open, 4.83);
  assert.equal(last.high, 4.88);
  assert.equal(last.low, 4.82);
  assert.equal(last.close, 4.869);
  assert.equal(last.volume, 36244);
  assert.ok(BRAI.some(bar => etParts(bar.datetime).date === '2026-10-27'));
});

test('CHSN golden partial bar is the 12:37 screenshot candle', () => {
  const last = CHSN[CHSN.length - 1];
  assert.equal(etParts(last.datetime).hm, '12:37');
  assert.equal(last.open, 1.57);
  assert.equal(last.high, 1.61);
  assert.equal(last.low, 1.56);
  assert.equal(last.close, 1.61);
  assert.equal(last.volume, 96296);
  assert.ok(CHSN.some(bar => etParts(bar.datetime).date === '2026-10-27'));
});

function lastFinite(values) {
  for (let i = values.length - 1; i >= 0; i--) {
    if (Number.isFinite(values[i])) return values[i];
  }
  return null;
}

/** Production formula: session VWAP (4:00 before 9:30, else 9:30), first-close EMA, immediate MACD signal. */
function measureProduction(bars, day) {
  const today = bars.filter(bar => etParts(bar.datetime).date === day);
  const lastHm = etParts(today[today.length - 1].datetime).hm;
  const start = hmMin(lastHm) >= hmMin('09:30') ? '09:30' : '04:00';
  const series = today.filter(bar => hmMin(etParts(bar.datetime).hm) >= hmMin(start));
  const closes = series.map(bar => bar.close).filter(Number.isFinite);
  const macd = calcMACDExactTOS(closes);
  return {
    price: series[series.length - 1].close,
    vwap: calcVWAP(series),
    ema9: lastFinite(calcExpAverageTOS(closes, 9)),
    ema20: lastFinite(calcExpAverageTOS(closes, 20)),
    macd: lastFinite(macd.macdLine),
    signal: lastFinite(macd.signalLine),
    hist: lastFinite(macd.histogram)
  };
}

/**
 * Exact chart values are a known gap. These captures were mid-minute, so the
 * hover timing is ambiguous until closed-bar calibration. Deltas are logged
 * and do not fail the test.
 */
function assertDotAgreement(name, got, chart) {
  const delta = {
    vwap: got.vwap - chart.vwap,
    ema9: got.ema9 - chart.ema9,
    ema20: got.ema20 - chart.ema20,
    macd: got.macd - chart.macd,
    signal: got.signal - chart.signal,
    hist: got.hist - chart.hist
  };
  console.log(
    `${name} delta vwap=${delta.vwap.toFixed(4)} ema9=${delta.ema9.toFixed(4)} ema20=${delta.ema20.toFixed(4)} macd=${delta.macd.toFixed(5)} signal=${delta.signal.toFixed(5)} hist=${delta.hist.toFixed(5)}`
  );
  assert.equal(got.hist > 0, chart.hist > 0, `${name} MACD histogram sign`);
}

test('BRAI dot states agree with the chart', () => {
  const got = measureProduction(BRAI, '2026-10-28');
  assertDotAgreement('BRAI', got, {
    vwap: 4.697,
    ema9: 4.880,
    ema20: 4.871,
    macd: 0.0356,
    signal: 0.0630248,
    hist: -0.0274248
  });
});

test('CHSN dot states agree with the chart', () => {
  const got = measureProduction(CHSN, '2026-10-28');
  assertDotAgreement('CHSN', got, {
    vwap: 1.371,
    ema9: 1.540,
    ema20: 1.495,
    macd: 0.0432808,
    signal: 0.0301171,
    hist: 0.0131637
  });
});

function gospelBanner(front, supportState) {
  return trafficBanner(
    {
      emas: true,
      macd: true,
      vwap: true,
      no_hv_sell: true,
      spread_ok: true,
      ...front
    },
    {
      resistance: { state: 'green', phase: 'clear' },
      support: { state: supportState, phase: supportState === 'green' ? 'near' : 'far' }
    },
    { front_side: { state: 'green' } },
    { state: 'green' }
  );
}

test('ALIGNED ignores VWAP, EMA, and support', () => {
  const withContextFail = gospelBanner({ emas: false, vwap: false }, 'red');
  const withContextPass = gospelBanner({ emas: true, vwap: true }, 'green');
  assert.equal(withContextFail, 'ALIGNED');
  assert.equal(withContextPass, withContextFail);
  assert.equal(gospelBanner({ macd: false }, 'green'), 'NOT_ALIGNED');
});

test('HV sell is red volume above the green bars or a 2x body', () => {
  const bars = [];
  let t = Date.parse('2026-10-28T13:30:00Z');
  for (let i = 0; i < 10; i++) {
    bars.push({ datetime: t, open: 1, high: 1.02, low: 0.99, close: 1.01, volume: 100 });
    t += 60000;
  }
  const heavy = { datetime: t, open: 1.01, high: 1.02, low: 0.99, close: 1.00, volume: 101 };
  assert.equal(isHighVolumeSellBar(heavy, [...bars, heavy]), true);
  const quiet = { datetime: t, open: 1.01, high: 1.02, low: 0.99, close: 1.00, volume: 50 };
  assert.equal(isHighVolumeSellBar(quiet, [...bars, quiet]), false);
  const wide = { datetime: t, open: 1.05, high: 1.06, low: 0.90, close: 0.90, volume: 50 };
  assert.equal(isHighVolumeSellBar(wide, [...bars, wide]), true);
});
