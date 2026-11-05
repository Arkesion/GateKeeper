'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const { computeStateFromCache, readWatchlist, writeWatchlist } = require('../lib/state');
const {
  utcFromEtDateTime,
  boundsForDate,
  stampBarEt,
  getEtDateString,
  getEtMinutes,
  getVwapConfig,
  openingBlackout,
  blackoutMode,
  applyClock
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

test('the opening blackout runs 09:25 through 09:35 on a trading day only', () => {
  for (const date of ['2026-11-04', '2026-10-30']) {
    const start = utcFromEtDateTime(date, 9, 25);
    const end = utcFromEtDateTime(date, 9, 35);
    const on = openingBlackout(start);
    assert.ok(on);
    assert.equal(on.end, '09:35');
    assert.equal(on.until, end);
    assert.equal(openingBlackout(start - 1000), null);
    assert.equal(openingBlackout(end), null);
    assert.equal(blackoutMode(on, {}), 'overlay');
    assert.equal(blackoutMode(on, { position: true }), 'banner');
    assert.equal(blackoutMode(on, { position: true, stopHit: true }), null);
    assert.equal(blackoutMode(on, { dayLock: true }), null);
  }
  assert.equal(openingBlackout(utcFromEtDateTime('2026-11-07', 9, 30)), null);
  assert.equal(openingBlackout(utcFromEtDateTime('2026-11-26', 9, 30)), null);
});

test('an open page picks up the blackout on the next poll and clears at 09:35', () => {
  const cfg = { start: '09:25', end: '09:35' };
  for (const date of ['2026-11-05', '2026-10-30']) {
    const loadedAt = utcFromEtDateTime(date, 9, 24) + 50000;
    const loaded = applyClock({ status: 'data_stale' }, loadedAt, cfg);
    assert.equal(loaded.blackout, null);
    assert.equal(loaded.market_session, 'PRE');
    assert.equal(blackoutMode(loaded.blackout, {}, loadedAt), null);
    const seenAt = utcFromEtDateTime(date, 9, 25) + 1000;
    const seen = applyClock({ status: 'data_stale' }, seenAt, cfg);
    assert.equal(seen.blackout.active, true);
    assert.equal(seen.blackout.ends_at, utcFromEtDateTime(date, 9, 35));
    assert.equal(blackoutMode(seen.blackout, {}, seenAt), 'overlay');
    assert.equal(blackoutMode(seen.blackout, { position: true }, seenAt), 'banner');
    const end = utcFromEtDateTime(date, 9, 35);
    assert.equal(blackoutMode(seen.blackout, {}, end), null);
    const cleared = applyClock(seen, end, cfg);
    assert.equal(cleared.blackout, null);
    const later = utcFromEtDateTime(date, 9, 42);
    const after = applyClock({ status: 'ok' }, later, cfg);
    assert.equal(after.blackout, null);
    assert.equal(blackoutMode(after.blackout, { position: true }, later), null);
    assert.equal(blackoutMode({ active: false }, { position: true }, later), null);
    assert.equal(applyClock({ status: 'ok' }, utcFromEtDateTime(date, 9, 30), cfg).market_session, 'RTH');
  }
  const until = utcFromEtDateTime('2026-11-06', 4, 0);
  const locked = applyClock({
    status: 'ok',
    session: { lockout: 'day', lockout_reason: 'r', lockout_until: until }
  }, utcFromEtDateTime('2026-11-05', 15, 0), cfg);
  assert.equal(locked.session.lockout, 'day');
  const reset = applyClock({
    status: 'ok',
    session: { lockout: 'day', lockout_reason: 'r', lockout_until: until }
  }, until, cfg);
  assert.equal(reset.session.lockout, null);
  assert.equal(reset.session.lockout_reason, null);
});

test('the watch list lives in redis and starts empty', async () => {
  const saved = new Map();
  const redis = {
    async get(key) { return saved.has(key) ? saved.get(key) : null; },
    async set(key, value) { saved.set(key, value); }
  };
  assert.deepEqual(await readWatchlist(redis), []);
  assert.deepEqual(await writeWatchlist(redis, ['vcig', 'CHSN', 'bad symbol', 'VCIG']), ['VCIG', 'CHSN']);
  assert.deepEqual(await readWatchlist(redis), ['VCIG', 'CHSN']);
  assert.deepEqual(await writeWatchlist(redis, ['CHSN']), ['CHSN']);
  assert.deepEqual(await readWatchlist(redis), ['CHSN']);
  assert.deepEqual(await writeWatchlist(redis, [], ['CHSN']), ['CHSN']);
  assert.deepEqual(await writeWatchlist(redis, []), []);
  const page = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.equal(page.includes('VCIG'), false);
  assert.equal(page.includes('localStorage.getItem'), false);
  assert.equal(page.includes('localStorage.setItem'), false);
  assert.equal(page.includes('+ ADD TICKER'), true);
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
  const clock = Date.now;
  Date.now = () => now;
  let state;
  try {
    state = computeStateFromCache('BRAI');
  } finally {
    Date.now = clock;
  }
  assert.equal(state.traffic_light_raw, 'NOT_ALIGNED');
  // 63474da: 4.92 is VWAP from 9:30. The same bars on the 4:00 series are 4.88.
  assert.equal(state.context.vwap_value, 4.92);
  assert.equal(state.context.ema9_1m_value, 4.59);
  assert.equal(state.context.ema20_1m_value, 4.64);
  assert.equal(state.context.macd_histogram_value, -0.010065651945648006);
  assert.equal(state.context.price, 4.47);
});
