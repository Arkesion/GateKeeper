'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { utcFromEtDateTime } = require('../lib/session');
const { noteAccount, getAccountSnapshot, fillWatchOf, fillsNotice } = require('../lib/providers/webull-provider');
const {
  applyFill,
  applyMarket,
  failingChecks,
  freezeStop,
  injectAllowed,
  isScratch,
  loadSession,
  nextSessionStart,
  priorSessionLine,
  rebuildFromFills,
  reconcilePositions,
  saveSession,
  viewOf
} = require('../lib/trades');

const NOW = Date.parse('2026-10-30T18:00:00.000Z');

function tempOpts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-trade-'));
  return {
    dir,
    sessionFile: path.join(dir, 'session.json'),
    tradeLog: path.join(dir, 'trades.log')
  };
}

function fresh(opts) {
  return loadSession(NOW, opts);
}

function buy(session, opts, id, price, extra = {}) {
  applyFill(session, {
    id, symbol: 'TNMG', side: 'BUY', shares: extra.shares || 1, price, ts: NOW
  }, {
    symbol: 'TNMG',
    now: NOW,
    setup: extra.setup || null,
    lastBarLow: extra.lastBarLow,
    failing: extra.failing || []
  }, opts);
}

function sell(session, opts, id, price) {
  applyFill(session, {
    id, symbol: 'TNMG', side: 'SELL', shares: 1, price, ts: NOW + 60000
  }, { symbol: 'TNMG', now: NOW + 60000 }, opts);
}

test('entry, stop, and R come from the fill and stay frozen after an add', () => {
  const opts = tempOpts();
  const session = fresh(opts);
  buy(session, opts, 'a', 4.00, { setup: { state: 'ARMED', pullback_low: 3.90 }, failing: ['Tail'] });
  assert.equal(session.open.entry, 4);
  assert.equal(session.open.stop, 3.89);
  assert.equal(session.open.r, 0.11);
  assert.equal(session.open.pullback_source, 'armed');
  buy(session, opts, 'b', 4.10, { shares: 1 });
  assert.equal(session.open.entry, 4.05);
  assert.equal(session.open.shares, 2);
  assert.equal(session.open.stop, 3.89);
  assert.equal(session.open.r, 0.11);
  assert.equal(session.open.frozen_entry, 4);
  assert.equal(viewOf(session, 4.10, NOW, opts).position.opened_at, NOW);
});

test('partial fills average and the stop stays on the first price', () => {
  const opts = tempOpts();
  const session = fresh(opts);
  const ctx = { symbol: 'TNMG', now: NOW, setup: { state: 'TRIGGERED', pullback_low: 3.90 }, failing: [] };
  applyFill(session, {
    id: 'ord:1', order_id: 'ord', symbol: 'TNMG', side: 'BUY', cumulative: 1, average: 4, ts: NOW
  }, ctx, opts);
  applyFill(session, {
    id: 'ord:2', order_id: 'ord', symbol: 'TNMG', side: 'BUY', cumulative: 2, average: 4.05, ts: NOW
  }, ctx, opts);
  assert.equal(session.open.entry, 4.05);
  assert.equal(session.open.shares, 2);
  assert.equal(session.open.stop, freezeStop(4, 3.90).stop);
});

test('pullback comes from ARMED, otherwise the last closed bar', () => {
  const armed = freezeStop(5.60, 5.37);
  assert.equal(armed.stop, 5.40);
  assert.equal(armed.r, 0.20);
  const nearer = freezeStop(5.60, 5.48);
  assert.equal(nearer.stop, 5.47);
  const opts = tempOpts();
  const fromBar = fresh(opts);
  buy(fromBar, opts, 'bar', 5.60, { setup: { state: 'IDLE' }, lastBarLow: 5.48 });
  assert.equal(fromBar.open.pullback_source, 'bar');
  assert.equal(fromBar.open.stop, 5.47);
});

test('a price under the frozen stop is STOP HIT', () => {
  const opts = tempOpts();
  const session = fresh(opts);
  buy(session, opts, 'open', 4.20, { setup: { state: 'ARMED', pullback_low: 4.17 } });
  assert.equal(session.open.stop, 4.16);
  assert.equal(viewOf(session, 4.10, NOW, opts).stop_hit, true);
  assert.equal(viewOf(session, 4.20, NOW, opts).stop_hit, false);
});

test('three losers lock the day, a scratch does neither, and a winner resets', () => {
  const opts = tempOpts();
  const session = fresh(opts);
  buy(session, opts, 'l1', 4, { lastBarLow: 3.9 });
  sell(session, opts, 'l1s', 3.80);
  assert.equal(session.streak, 1);
  buy(session, opts, 's', 4, { lastBarLow: 3.9 });
  sell(session, opts, 'ss', 4.005);
  assert.equal(isScratch(0.005, 1), true);
  assert.equal(session.streak, 1);
  buy(session, opts, 'w', 4, { lastBarLow: 3.9 });
  sell(session, opts, 'ws', 4.20);
  assert.equal(session.streak, 0);
  for (let i = 1; i <= 3; i++) {
    buy(session, opts, `b${i}`, 4, { lastBarLow: 3.9, failing: ['MACD'], setup: { state: 'ARMED', pullback_low: 3.9 } });
    sell(session, opts, `s${i}`, 3.70);
  }
  assert.equal(session.streak, 3);
  assert.equal(viewOf(session, null, NOW, opts).session.lockout, 'day');
  const lines = fs.readFileSync(opts.tradeLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const last = lines[lines.length - 1];
  assert.equal(last.symbol, 'TNMG');
  assert.equal(last.setup_state, 'ARMED');
  assert.deepEqual(last.failing, ['MACD']);
  assert.ok(last.realized_usd < 0);
  assert.ok(last.duration_ms > 0);
});

test('a 3R loss and a dollar loss each lock the day', () => {
  const opts = { ...tempOpts(), maxLossUsd: null };
  const byR = fresh(opts);
  buy(byR, opts, 'r', 5, { lastBarLow: null });
  assert.equal(byR.open.r, 0.20);
  sell(byR, opts, 'rs', 4.40);
  assert.equal(viewOf(byR, null, NOW, opts).session.lockout_reason, 'r');
  const byUsd = fresh(opts);
  buy(byUsd, opts, 'u', 5, { lastBarLow: 4.9, shares: 100 });
  applyFill(byUsd, {
    id: 'us', symbol: 'TNMG', side: 'SELL', shares: 100, price: 4.90, ts: NOW + 1000
  }, { symbol: 'TNMG', now: NOW + 1000 }, { ...opts, maxLossUsd: 10 });
  assert.equal(viewOf(byUsd, null, NOW + 1000, { ...opts, maxLossUsd: 10 }).session.lockout_reason, 'usd');
});

test('a lockout reloads from disk and clears at 4:00 AM ET', () => {
  const opts = tempOpts();
  const session = fresh(opts);
  for (let i = 1; i <= 3; i++) {
    buy(session, opts, `k${i}`, 4, { lastBarLow: 3.9 });
    sell(session, opts, `ks${i}`, 3.70);
  }
  saveSession(session, opts);
  const restored = loadSession(NOW, opts);
  assert.equal(viewOf(restored, null, NOW, opts).session.lockout, 'day');
  assert.equal(restored.streak, 3);
  const unlock = nextSessionStart(NOW);
  assert.equal(unlock, utcFromEtDateTime('2026-10-31', 4, 0));
  const still = loadSession(unlock - 1, opts);
  assert.equal(viewOf(still, null, unlock - 1, opts).session.lockout, 'day');
  const cleared = loadSession(unlock, opts);
  assert.equal(viewOf(cleared, null, unlock, opts).session.lockout, null);
  assert.equal(cleared.streak, 0);
  assert.equal(cleared.realized_usd, 0);
});

test('the fill injector requires the flag and NODE_ENV development', () => {
  const prevFlag = process.env.GK_INJECT_FILLS;
  const prevNode = process.env.NODE_ENV;
  try {
    delete process.env.GK_INJECT_FILLS;
    delete process.env.NODE_ENV;
    assert.equal(injectAllowed(), false);
    process.env.GK_INJECT_FILLS = '1';
    assert.equal(injectAllowed(), false);
    process.env.NODE_ENV = 'production';
    assert.equal(injectAllowed(), false);
    process.env.NODE_ENV = 'development';
    assert.equal(injectAllowed(), true);
  } finally {
    if (prevFlag == null) delete process.env.GK_INJECT_FILLS;
    else process.env.GK_INJECT_FILLS = prevFlag;
    if (prevNode == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
  }
});

test('a position with no open trade rebuilds the stop from the last closed bar', () => {
  const opts = tempOpts();
  const session = fresh(opts);
  const changed = reconcilePositions(session, [
    { symbol: 'TNMG', shares: 1, average: 4.20 }
  ], {
    symbol: 'TNMG',
    now: NOW,
    lastBarLow: 4.05,
    setup: { state: 'ARMED', pullback_low: 3.90 }
  }, opts);
  assert.equal(changed, true);
  assert.equal(session.open.entry, 4.20);
  assert.equal(session.open.pullback_source, 'rebuilt');
  assert.equal(session.open.pullback_low, 4.05);
  assert.equal(session.open.stop, freezeStop(4.20, 4.05).stop);
  assert.notEqual(session.open.stop, freezeStop(4.20, 3.90).stop);
  reconcilePositions(session, [
    { symbol: 'TNMG', shares: 1, average: 4.20 }
  ], { symbol: 'TNMG', now: NOW, lastBarLow: 3.50 }, opts);
  assert.equal(session.open.stop, freezeStop(4.20, 4.05).stop);
});

test('an account that is not ok does not open a trade', () => {
  const opts = tempOpts();
  const view = applyMarket({
    symbol: 'TNMG',
    now: NOW,
    accountStatus: 'unconfigured',
    account: {
      status: 'unconfigured',
      positions: [{ symbol: 'TNMG', shares: 1, average: 4.2 }],
      fills: []
    }
  }, opts);
  assert.equal(view.position, null);
  assert.equal(view.account.status, 'unconfigured');
});

const CLRO = [
  { symbol: 'CLRO', side: 'BUY', shares: 1, price: 4.74, ts: 1793021848382 },
  { symbol: 'CLRO', side: 'SELL', shares: 1, price: 4.49, ts: 1793022175611 },
  { symbol: 'CLRO', side: 'BUY', shares: 1, price: 4.89, ts: 1793022191713 },
  { symbol: 'CLRO', side: 'SELL', shares: 1, price: 4.88, ts: 1793022312799 },
  { symbol: 'CLRO', side: 'BUY', shares: 1, price: 5.07, ts: 1793022383365 },
  { symbol: 'CLRO', side: 'SELL', shares: 1, price: 4.90, ts: 1793022411499 }
];

const PURR = [
  { symbol: 'PURR', side: 'BUY', shares: 1, price: 12.22, ts: 1793290926884 },
  { symbol: 'PURR', side: 'SELL', shares: 1, price: 12.18, ts: 1793290965286 }
];

test('Oct 29 PURR is one loser and no lockout', () => {
  const opts = tempOpts();
  const now = utcFromEtDateTime('2026-10-29', 16, 0);
  const session = loadSession(now, opts);
  session.open = { symbol: 'TNMG', shares: 1, stop: 1 };
  session.realized_r = 1.5;
  const rebuilt = rebuildFromFills(session, PURR, now, opts);
  assert.equal(rebuilt.changed, true);
  assert.equal(session.realized_usd, -0.04);
  assert.equal(session.trades, 1);
  assert.equal(session.streak, 1);
  assert.equal(session.realized_r, -0.4);
  assert.equal(session.r_estimated, true);
  assert.equal(session.lockout_until, null);
  assert.equal(session.open.symbol, 'TNMG');
  assert.equal(fs.existsSync(opts.tradeLog), false);
  assert.equal(rebuildFromFills(session, PURR, now, opts).changed, false);
  assert.match(rebuilt.line, /session rebuild 2026-10-29 realized 0\.00 -> -0\.04 trades 0 -> 1 streak 0 -> 1/);
});

test('Oct 26 CLRO locks after three losers and the lock is gone on Oct 30', () => {
  const opts = tempOpts();
  const during = utcFromEtDateTime('2026-10-26', 16, 0);
  const session = loadSession(during, opts);
  const rebuilt = rebuildFromFills(session, CLRO, during, opts);
  assert.equal(rebuilt.changed, true);
  assert.equal(session.realized_usd, -0.43);
  assert.equal(session.trades, 3);
  assert.equal(session.streak, 3);
  assert.equal(session.realized_r, -4.3);
  assert.equal(session.r_estimated, true);
  assert.equal(session.lockout_reason, 'r');
  assert.equal(session.lockout_until, utcFromEtDateTime('2026-10-27', 4, 0));
  const later = loadSession(utcFromEtDateTime('2026-10-30', 16, 0), opts);
  const quiet = rebuildFromFills(later, CLRO, utcFromEtDateTime('2026-10-30', 16, 0), opts);
  assert.equal(quiet.changed, false);
  assert.equal(later.realized_usd, 0);
  assert.equal(later.streak, 0);
  assert.equal(later.lockout_until, null);
  const line = priorSessionLine(PURR, utcFromEtDateTime('2026-10-30', 16, 0), opts);
  assert.equal(line, 'session 2026-10-29 realized=-0.04 trades=1 streak=1 lockout=none');
});

test('a restart keeps logged R and estimates the trade that has no log', () => {
  const opts = tempOpts();
  const t1 = utcFromEtDateTime('2026-10-30', 10, 0);
  const t2 = utcFromEtDateTime('2026-10-30', 11, 0);
  const t3 = utcFromEtDateTime('2026-10-30', 12, 0);
  const now = utcFromEtDateTime('2026-10-30', 13, 0);
  const lots = [
    { symbol: 'AAA', side: 'BUY', shares: 1, price: 5, ts: t1, order_id: 'b1' },
    { symbol: 'AAA', side: 'SELL', shares: 1, price: 4.9, ts: t1 + 1000, order_id: 's1' },
    { symbol: 'BBB', side: 'BUY', shares: 1, price: 5, ts: t2, order_id: 'b2' },
    { symbol: 'BBB', side: 'SELL', shares: 1, price: 4.9, ts: t2 + 1000, order_id: 's2' },
    { symbol: 'CCC', side: 'BUY', shares: 1, price: 5, ts: t3, order_id: 'b3' },
    { symbol: 'CCC', side: 'SELL', shares: 1, price: 4.8, ts: t3 + 1000, order_id: 's3' }
  ];
  fs.writeFileSync(opts.tradeLog, [
    JSON.stringify({ order_ids: ['b1', 's1'], r: 0.20, stop: 4.80 }),
    JSON.stringify({ order_ids: ['s2', 'b2'], r: 0.20, stop: 4.80 })
  ].join('\n') + '\n');
  const session = loadSession(now, opts);
  const rebuilt = rebuildFromFills(session, lots, now, opts);
  assert.equal(rebuilt.changed, true);
  assert.equal(session.realized_usd, -0.40);
  assert.equal(session.realized_r, -3);
  assert.equal(session.r_estimated, true);
  assert.equal(session.lockout_reason, 'r');
  assert.equal(viewOf(session, null, now, opts).session.lockout, 'day');
});

test('schwab market data still books a webull fill and a lockout', () => {
  const opts = tempOpts();
  const snap = {
    status: 'ok',
    ordersStream: 'connected',
    positionsPollAt: NOW,
    openPositions: 1,
    positions: [{ symbol: 'TNMG', shares: 1, average: 4.2 }],
    fills: [{ id: 'tnmg-buy', symbol: 'TNMG', side: 'BUY', shares: 1, price: 4.2, ts: NOW }],
    dayFills: null
  };
  noteAccount(snap);
  const watch = fillWatchOf(getAccountSnapshot());
  assert.equal(watch.orders_stream, 'connected');
  assert.equal(watch.open_positions, 1);
  const open = applyMarket({
    symbol: 'TNMG',
    price: 4.5,
    now: NOW,
    lastBarLow: 4.05,
    account: getAccountSnapshot()
  }, opts);
  assert.equal(open.position.symbol, 'TNMG');
  assert.equal(open.account.status, 'ok');

  const during = utcFromEtDateTime('2026-10-26', 16, 0);
  const lockedOpts = tempOpts();
  noteAccount({
    status: 'ok',
    ordersStream: 'connected',
    positionsPollAt: during,
    openPositions: 0,
    positions: [],
    fills: [],
    dayFills: CLRO
  });
  const locked = applyMarket({
    symbol: 'TNMG',
    price: 4.5,
    now: during,
    account: getAccountSnapshot()
  }, lockedOpts);
  assert.equal(locked.position, null);
  assert.equal(locked.session.lockout, 'day');
  noteAccount(null);
});

test('the Nov 2 CLRO fill stays open until the 6.42 sell', () => {
  const opts = tempOpts();
  const buyTs = Date.parse('2026-11-02T14:12:47.860Z');
  const sellTs = Date.parse('2026-11-02T14:14:59.521Z');
  const lots = [
    {
      symbol: 'CLRO', side: 'BUY', shares: 1, price: 6.39, ts: buyTs,
      order_id: 'S9H49IJFIT584LMEJHP0O6R4C9'
    },
    {
      symbol: 'CLRO', side: 'SELL', shares: 1, price: 6.42, ts: sellTs,
      order_id: '37IIT78KPAKD610HQ67VOF4IE8'
    }
  ];
  const open = applyMarket({
    symbol: 'CLRO',
    price: 6.39,
    now: buyTs + 7000,
    lastBarLow: 6.16,
    account: {
      status: 'ok',
      positions: [{ symbol: 'CLRO', shares: 1, average: 6.39 }],
      fills: [],
      dayFills: null
    }
  }, opts);
  assert.equal(open.position.symbol, 'CLRO');
  assert.equal(open.position.entry, 6.39);

  const held = applyMarket({
    symbol: 'CLRO',
    price: 6.38,
    now: sellTs,
    account: { status: 'ok', positions: [], fills: [], dayFills: null }
  }, opts);
  assert.equal(held.position.symbol, 'CLRO');
  assert.equal(fs.existsSync(opts.tradeLog), false);

  const closed = applyMarket({
    symbol: 'CLRO',
    price: 6.38,
    now: sellTs + 1000,
    account: { status: 'ok', positions: [], fills: [], dayFills: lots }
  }, opts);
  assert.equal(closed.position, null);
  assert.equal(closed.session.realized_usd, 0.03);
  const row = JSON.parse(fs.readFileSync(opts.tradeLog, 'utf8').trim());
  assert.equal(row.exit, 6.42);
  assert.equal(row.realized_usd, 0.03);
  assert.ok(row.order_ids.includes('S9H49IJFIT584LMEJHP0O6R4C9'));
  assert.ok(row.order_ids.includes('37IIT78KPAKD610HQ67VOF4IE8'));
});

test('a position appearing on a poll flips the rail to IN TRADE on that poll', () => {
  const opts = tempOpts();
  const flat = applyMarket({
    symbol: 'CLRO',
    price: 6.4,
    now: NOW,
    lastBarLow: 6.16,
    account: { status: 'ok', positions: [], fills: [], dayFills: null }
  }, opts);
  assert.equal(flat.position, null);

  const live = applyMarket({
    symbol: 'CLRO',
    price: 6.4,
    now: NOW + 2000,
    lastBarLow: 6.16,
    account: {
      status: 'ok',
      positions: [{ symbol: 'CLRO', shares: 1, average: 6.39 }],
      fills: [],
      dayFills: null
    }
  }, opts);
  assert.equal(live.position.symbol, 'CLRO');
  assert.equal(live.position.entry, 6.39);
  assert.ok(live.position.stop > 0);
  assert.ok(live.position.r > 0);
});

test('a 429 backoff shows FILLS DELAYED until the poll is 10 seconds late', () => {
  const at = utcFromEtDateTime('2026-11-02', 10, 21);
  const delayed = fillsNotice({ pollAt: at, backingOff: true, now: at + 3000 });
  assert.equal(delayed.text, 'FILLS DELAYED · rate limited');
  assert.equal(delayed.tone, 'warn');
  const still = fillsNotice({ pollAt: at, backingOff: true, now: at + 10000 });
  assert.equal(still.text, 'FILLS DELAYED · rate limited');
  const offline = fillsNotice({ pollAt: at, backingOff: true, now: at + 11000 });
  assert.equal(offline.text, 'FILLS OFFLINE');
  assert.equal(offline.tone, 'bad');
  const fresh = fillsNotice({ pollAt: at, backingOff: false, now: at + 3000 });
  assert.equal(fresh, null);
  const never = fillsNotice({ pollAt: null, backingOff: true, now: at + 3000 });
  assert.equal(never.text, 'FILLS OFFLINE');
});

test('a flat poll leaves the rail confirming before the 09:15:48 sell', () => {
  const opts = tempOpts();
  const openAt = Date.parse('2026-11-04T14:07:20.000Z');
  const sellAt = Date.parse('2026-11-04T14:15:48.086Z');
  const flatAt = sellAt + 1000;
  const early = [
    { symbol: 'CHSN', side: 'BUY', shares: 1, price: 4.06, ts: Date.parse('2026-11-04T14:06:11.000Z'), order_id: 'b1' },
    { symbol: 'CHSN', side: 'SELL', shares: 1, price: 3.93, ts: Date.parse('2026-11-04T14:06:14.000Z'), order_id: 's1' }
  ];
  const held = applyMarket({
    symbol: 'CHSN',
    now: openAt,
    lastBarLow: 3.90,
    account: {
      status: 'ok',
      positions: [{ symbol: 'CHSN', shares: 1, average: 4.09 }],
      fills: [{ id: 'b2', symbol: 'CHSN', side: 'BUY', shares: 1, price: 4.09, ts: openAt }],
      dayFills: early
    }
  }, opts);
  assert.equal(held.position.symbol, 'CHSN');
  assert.equal(held.exit, null);
  const mid = applyMarket({
    symbol: 'CHSN',
    now: flatAt,
    price: 3.91,
    lastBarLow: 3.90,
    account: { status: 'ok', positions: [], dayFills: early }
  }, opts);
  assert.ok(flatAt - sellAt < 3000);
  assert.equal(mid.exit.status, 'confirming');
  assert.equal(mid.position.symbol, 'CHSN');
  const waiting = applyMarket({
    symbol: 'CHSN',
    now: flatAt + 500,
    price: 3.91,
    account: {
      status: 'ok',
      positions: [],
      dayFills: early,
      exit: { symbol: 'CHSN', status: 'unconfirmed' }
    }
  }, opts);
  assert.equal(waiting.exit.status, 'unconfirmed');
  assert.equal(waiting.position.symbol, 'CHSN');
  const done = applyMarket({
    symbol: 'CHSN',
    now: flatAt + 800,
    price: 3.91,
    account: {
      status: 'ok',
      positions: [],
      dayFills: early.concat([
        { symbol: 'CHSN', side: 'BUY', shares: 1, price: 4.09, ts: openAt, order_id: 'b2' },
        { symbol: 'CHSN', side: 'SELL', shares: 1, price: 3.91, ts: sellAt, order_id: 's2' }
      ])
    }
  }, opts);
  assert.equal(done.position, null);
  assert.equal(done.exit, null);
  const lines = fs.readFileSync(opts.tradeLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[lines.length - 1].exit, 3.91);
  assert.equal(done.session.symbol_losers.CHSN, 2);
});

test('CHSN today is two losers, a third locks the symbol, and a scratch does not', () => {
  const opts = tempOpts();
  const lots = [
    { symbol: 'CHSN', side: 'BUY', shares: 1, price: 4.06, ts: Date.parse('2026-11-04T14:06:11.000Z'), order_id: 'b1' },
    { symbol: 'CHSN', side: 'SELL', shares: 1, price: 3.93, ts: Date.parse('2026-11-04T14:06:14.000Z'), order_id: 's1' },
    { symbol: 'CHSN', side: 'BUY', shares: 1, price: 4.09, ts: Date.parse('2026-11-04T14:07:20.000Z'), order_id: 'b2' },
    { symbol: 'CHSN', side: 'SELL', shares: 1, price: 3.91, ts: Date.parse('2026-11-04T14:15:48.086Z'), order_id: 's2' }
  ];
  const now = lots[3].ts + 1000;
  const session = loadSession(now, opts);
  const rebuilt = rebuildFromFills(session, lots, now, opts);
  assert.equal(rebuilt.changed, true);
  assert.equal(session.symbol_losers.CHSN, 2);
  assert.deepEqual(viewOf(session, null, now, opts).session.locked_symbols, []);
  saveSession(session, opts);
  const restored = loadSession(now, opts);
  assert.equal(restored.symbol_losers.CHSN, 2);
  const again = rebuildFromFills(restored, lots, now, opts);
  assert.equal(again.changed, false);
  assert.equal(restored.symbol_losers.CHSN, 2);
  const scratch = lots.concat([
    { symbol: 'CHSN', side: 'BUY', shares: 1, price: 4.00, ts: now + 1000, order_id: 'b3' },
    { symbol: 'CHSN', side: 'SELL', shares: 1, price: 4.005, ts: now + 2000, order_id: 's3' }
  ]);
  rebuildFromFills(restored, scratch, now + 2000, opts);
  assert.equal(restored.symbol_losers.CHSN, 2);
  const third = scratch.concat([
    { symbol: 'CHSN', side: 'BUY', shares: 1, price: 4.10, ts: now + 3000, order_id: 'b4' },
    { symbol: 'CHSN', side: 'SELL', shares: 1, price: 3.90, ts: now + 4000, order_id: 's4' }
  ]);
  rebuildFromFills(restored, third, now + 4000, opts);
  assert.equal(restored.symbol_losers.CHSN, 3);
  assert.deepEqual(viewOf(restored, null, now + 4000, opts).session.locked_symbols, ['CHSN']);
});

test('failing checks are the red chips only', () => {
  assert.deepEqual(failingChecks(
    { macd: false, no_hv_sell: true, no_big_red: true, no_topping_tail: false, spread_ok: true },
    { front_side: { state: 'red' } },
    { state: 'green' }
  ), ['MACD', 'Choppy', 'Tail']);
});
