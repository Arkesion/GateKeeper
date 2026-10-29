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

/** Production formula: 4:00 AM ET session, HLC3 VWAP, first-close EMA, immediate MACD signal. */
function measureProduction(bars, day) {
  const today = bars.filter(bar => {
    const et = etParts(bar.datetime);
    return et.date === day && hmMin(et.hm) >= hmMin('04:00');
  });
  const closes = today.map(bar => bar.close).filter(Number.isFinite);
  const macd = calcMACDExactTOS(closes);
  return {
    price: today[today.length - 1].close,
    vwap: calcVWAP(today),
    ema9: lastFinite(calcExpAverageTOS(closes, 9)),
    ema20: lastFinite(calcExpAverageTOS(closes, 20)),
    macd: lastFinite(macd.macdLine),
    signal: lastFinite(macd.signalLine),
    hist: lastFinite(macd.histogram)
  };
}

function above(left, right) {
  return left > right;
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
  assert.equal(above(got.ema9, got.ema20), above(chart.ema9, chart.ema20), `${name} EMA9 vs EMA20`);
  assert.equal(got.hist > 0, chart.hist > 0, `${name} MACD histogram sign`);
  assert.equal(above(got.price, got.vwap), above(got.price, chart.vwap), `${name} price vs VWAP`);
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
