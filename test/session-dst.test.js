'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const { computeStateFromCache } = require('../lib/state');
const {
  utcFromEtDateTime,
  boundsForDate,
  stampBarEt,
  getEtDateString,
  getEtMinutes,
  getVwapConfig
} = require('../lib/session');

const SESSIONS = {
  '2026-10-30': {
    label: 'EDT',
    bounds: {
      '4:00': 1793347200000,
      '9:30': 1793367000000,
      '16:00': 1793390400000,
      '20:00': 1793404800000
    }
  },
  '2026-11-02': {
    label: 'EST',
    bounds: {
      '4:00': 1793610000000,
      '9:30': 1793629800000,
      '16:00': 1793653200000,
      '20:00': 1793667600000
    }
  }
};

for (const [date, session] of Object.entries(SESSIONS)) {
  test(`${date} ${session.label} session boundaries, minute-of-day, and VWAP anchor`, () => {
    const open = utcFromEtDateTime(date, 4, 0);
    const rth = utcFromEtDateTime(date, 9, 30);
    const close = utcFromEtDateTime(date, 16, 0);
    const end = utcFromEtDateTime(date, 20, 0);
    assert.equal(open, session.bounds['4:00']);
    assert.equal(rth, session.bounds['9:30']);
    assert.equal(close, session.bounds['16:00']);
    assert.equal(end, session.bounds['20:00']);
    assert.equal(boundsForDate(date).ethStartMs, open);
    assert.equal(boundsForDate(date), boundsForDate(date));

    const atOpen = stampBarEt({ datetime: open });
    const beforeOpen = stampBarEt({ datetime: open - 60 * 1000 });
    assert.equal(atOpen.etDate, date);
    assert.equal(atOpen.etMinute, 4 * 60);
    assert.equal(beforeOpen.etDate, date);
    assert.equal(beforeOpen.etMinute, 4 * 60 - 1);
    assert.equal(getEtDateString(end), date);
    assert.equal(getEtMinutes(end), 20 * 60);

    const now = utcFromEtDateTime(date, 10, 15);
    const cfg = getVwapConfig(now);
    assert.equal(cfg.vwapStartMs, rth);
    const atRth = stampBarEt({ datetime: rth });
    const kept = [beforeOpen, atOpen, atRth].filter(cfg.filterCandle);
    assert.deepEqual(kept.map(bar => bar.datetime), [rth]);

    const preCfg = getVwapConfig(utcFromEtDateTime(date, 8, 0));
    assert.equal(preCfg.vwapStartMs, open);
  });
}

test('session-bound cache does not leak the EDT offset into EST', () => {
  const friday = boundsForDate('2026-10-30');
  const monday = boundsForDate('2026-11-02');
  assert.equal(friday.ethStartMs, SESSIONS['2026-10-30'].bounds['4:00']);
  assert.equal(monday.ethStartMs, SESSIONS['2026-11-02'].bounds['4:00']);
  assert.equal(boundsForDate('2026-10-30'), friday);
  assert.notEqual(friday.ethStartMs - Date.parse('2026-10-30T00:00:00Z'),
    monday.ethStartMs - Date.parse('2026-11-02T00:00:00Z'));
});

test('BRAI recompute values stay the same after the formatter change', () => {
  const bars = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures/brai-2026-10-28.json'),
    'utf8'
  )).bars;
  const now = bars[bars.length - 1].datetime + 15000;
  store.activeSymbol = 'BRAI';
  store.marketDataCache.BRAI = {
    quote: {
      lastPrice: bars[bars.length - 1].close,
      closePrice: 3.31,
      bidPrice: bars[bars.length - 1].close,
      askPrice: bars[bars.length - 1].close + 0.01,
      lastPrintAt: now,
      quoteTime: now
    },
    candles1m: bars,
    candles1mMacd: bars,
    dailyCandles: [],
    quoteFetched: true
  };
  const state = computeStateFromCache('BRAI');
  assert.equal(state.traffic_light_raw, 'NOT_ALIGNED');
  assert.equal(state.context.vwap_value, 4.92);
  assert.equal(state.context.ema9_1m_value, 4.59);
  assert.equal(state.context.ema20_1m_value, 4.64);
  assert.equal(state.context.macd_histogram_value, -0.010065651945648006);
  assert.equal(state.context.price, 4.47);
});
