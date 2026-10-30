'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { utcFromEtDateTime } = require('../lib/session');
const {
  applyFill,
  applyMarket,
  failingChecks,
  freezeStop,
  injectAllowed,
  isScratch,
  loadSession,
  nextSessionStart,
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
  const opts = tempOpts();
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

test('failing checks are the red chips only', () => {
  assert.deepEqual(failingChecks(
    { macd: false, no_hv_sell: true, no_big_red: true, no_topping_tail: false, spread_ok: true },
    { front_side: { state: 'red' } },
    { state: 'green' }
  ), ['MACD', 'Choppy', 'Tail']);
});
