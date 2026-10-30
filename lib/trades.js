'use strict';

const fs = require('fs');
const { getEtDateString, utcFromEtDateTime } = require('./session');

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function sessionPath(opts = {}) {
  return opts.sessionFile || process.env.SESSION_FILE || '/data/session.json';
}

function tradeLogPath(opts = {}) {
  return opts.tradeLog || process.env.TRADE_LOG || '/data/trades.log';
}

function limits(opts = {}) {
  const fromEnv = Number(process.env.DAILY_MAX_LOSS_R);
  const maxLossR = opts.maxLossR ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 3);
  let maxLossUsd = null;
  if (opts.maxLossUsd !== undefined) maxLossUsd = opts.maxLossUsd;
  else if (process.env.DAILY_MAX_LOSS_USD) {
    const usd = Number(process.env.DAILY_MAX_LOSS_USD);
    maxLossUsd = Number.isFinite(usd) && usd > 0 ? usd : null;
  }
  return { maxLossR, maxLossUsd };
}

function injectAllowed() {
  return process.env.GK_INJECT_FILLS === '1' && process.env.NODE_ENV === 'development';
}

function nextDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function prevDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function sessionId(now) {
  const today = getEtDateString(now);
  return now >= utcFromEtDateTime(today, 4, 0) ? today : prevDate(today);
}

function nextSessionStart(now) {
  const today = getEtDateString(now);
  const open = utcFromEtDateTime(today, 4, 0);
  if (now < open) return open;
  return utcFromEtDateTime(nextDate(today), 4, 0);
}

function blank(now) {
  return {
    session_id: sessionId(now),
    realized_usd: 0,
    realized_r: 0,
    losers: 0,
    streak: 0,
    lockout_until: null,
    lockout_reason: null,
    seen: [],
    orders: {},
    open: null
  };
}

function rollSession(session, now) {
  const id = sessionId(now);
  if (session.session_id === id) {
    if (session.lockout_until && now >= session.lockout_until) {
      session.lockout_until = null;
      session.lockout_reason = null;
      return true;
    }
    return false;
  }
  session.session_id = id;
  session.realized_usd = 0;
  session.realized_r = 0;
  session.losers = 0;
  session.streak = 0;
  session.lockout_until = null;
  session.lockout_reason = null;
  return true;
}

function loadSession(now, opts = {}) {
  const file = sessionPath(opts);
  let session = blank(now);
  try {
    session = { ...blank(now), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    session = blank(now);
  }
  session._dirty = rollSession(session, now);
  return session;
}

function saveSession(session, opts = {}) {
  const file = sessionPath(opts);
  try {
    fs.mkdirSync(require('path').dirname(file), { recursive: true });
    const copy = { ...session };
    delete copy._dirty;
    fs.writeFileSync(file, JSON.stringify(copy));
  } catch {
    /* a missing volume must not stop the rail */
  }
}

function freezeStop(entry, pullbackLow) {
  const cap = entry - 0.20;
  const fromLow = Number.isFinite(pullbackLow) ? pullbackLow - 0.01 : -Infinity;
  let stop = Math.max(fromLow, cap);
  if (!(stop < entry)) stop = cap;
  return { stop: round2(stop), r: round2(entry - stop) };
}

function pullbackFor(setup, lastBarLow) {
  const armed = setup && (setup.state === 'ARMED' || setup.state === 'TRIGGERED');
  if (armed && Number.isFinite(setup.pullback_low)) {
    return { low: setup.pullback_low, source: 'armed' };
  }
  if (Number.isFinite(lastBarLow)) return { low: lastBarLow, source: 'bar' };
  return { low: null, source: 'cap' };
}

function failingChecks(front, momentum, giveback) {
  const out = [];
  if (front?.macd === false) out.push('MACD');
  if (momentum?.front_side?.state && momentum.front_side.state !== 'green') out.push('Choppy');
  if (front?.no_hv_sell === false) out.push('HV sell');
  if (front?.no_big_red === false) out.push('Big red');
  if (front?.no_topping_tail === false) out.push('Tail');
  if (front?.spread_ok === false) out.push('Spread');
  if (giveback?.state === 'red') out.push('Giveback');
  return out;
}

function contextFor(symbol, input) {
  if (!input || symbol !== input.symbol) {
    return { setup: null, lastBarLow: null, failing: [] };
  }
  return {
    setup: input.setup || null,
    lastBarLow: input.lastBarLow,
    failing: input.failing || failingChecks(input.front_side, input.momentum, input.giveback)
  };
}

function remember(session, id) {
  if (!id || session.seen.includes(id)) return false;
  session.seen.push(id);
  if (session.seen.length > 500) session.seen.splice(0, session.seen.length - 500);
  return true;
}

function openTrade(session, fill, ctx) {
  const rebuilt = ctx.rebuilt === true;
  const pullback = rebuilt
    ? { low: ctx.lastBarLow, source: 'rebuilt' }
    : pullbackFor(ctx.setup, ctx.lastBarLow);
  if (rebuilt && !Number.isFinite(pullback.low)) return false;
  const frozen = freezeStop(fill.price, pullback.low);
  session.open = {
    symbol: fill.symbol,
    shares: fill.shares,
    entry: round4(fill.price),
    frozen_entry: round4(fill.price),
    cost: fill.price * fill.shares,
    stop: frozen.stop,
    r: frozen.r,
    pullback_low: Number.isFinite(pullback.low) ? round2(pullback.low) : null,
    pullback_source: pullback.source,
    setup_state: ctx.setup?.state || null,
    failing: ctx.failing || [],
    opened_at: fill.ts || Date.now(),
    exit_shares: 0,
    exit_cost: 0
  };
  return true;
}

function addShares(open, shares, price) {
  open.cost += price * shares;
  open.shares = round4(open.shares + shares);
  open.entry = round4(open.cost / open.shares);
}

function isScratch(realized, shares) {
  if (!(shares > 0)) return false;
  return Math.abs(realized / shares) < 0.01;
}

function noteClose(session, now, opts) {
  const open = session.open;
  const shares = open.exit_shares;
  const exit = shares > 0 ? open.exit_cost / shares : open.entry;
  const realized = (exit - open.entry) * shares;
  const rMultiple = open.r > 0 ? realized / (open.r * shares) : 0;
  const row = {
    t: new Date(now).toISOString(),
    symbol: open.symbol,
    entry: round4(open.entry),
    exit: round4(exit),
    shares,
    realized_usd: round2(realized),
    r_multiple: Math.round(rMultiple * 100) / 100,
    duration_ms: Math.max(0, now - (open.opened_at || now)),
    setup_state: open.setup_state,
    failing: open.failing
  };
  try {
    fs.appendFileSync(tradeLogPath(opts), JSON.stringify(row) + '\n');
  } catch {
    /* the log is on the volume in production */
  }
  session.realized_usd = round2(session.realized_usd + realized);
  session.realized_r = Math.round((session.realized_r + rMultiple) * 100) / 100;
  if (!isScratch(realized, shares)) {
    if (realized < 0) {
      session.streak += 1;
      session.losers += 1;
    } else if (realized > 0) {
      session.streak = 0;
    }
  }
  const { maxLossR, maxLossUsd } = limits(opts);
  if (session.streak >= 3) {
    session.lockout_until = nextSessionStart(now);
    session.lockout_reason = 'losers';
  }
  if (session.realized_r <= -maxLossR) {
    session.lockout_until = nextSessionStart(now);
    session.lockout_reason = 'r';
  }
  if (maxLossUsd != null && session.realized_usd <= -maxLossUsd) {
    session.lockout_until = nextSessionStart(now);
    session.lockout_reason = 'usd';
  }
  session.open = null;
}

function applyLot(session, lot, ctx, now, opts) {
  if (!(lot.shares > 0) || !Number.isFinite(lot.price)) return false;
  const fill = {
    symbol: lot.symbol,
    side: lot.side,
    shares: lot.shares,
    price: lot.price,
    ts: lot.ts || now
  };
  if (fill.side === 'BUY') {
    if (!session.open) {
      return openTrade(session, fill, ctx);
    }
    if (session.open.symbol !== fill.symbol) return false;
    addShares(session.open, fill.shares, fill.price);
    return true;
  }
  if (!session.open || session.open.symbol !== fill.symbol) return false;
  const sold = Math.min(fill.shares, session.open.shares);
  session.open.exit_shares = round4(session.open.exit_shares + sold);
  session.open.exit_cost += fill.price * sold;
  session.open.shares = round4(session.open.shares - sold);
  session.open.cost = session.open.entry * session.open.shares;
  if (session.open.shares <= 0.0001) noteClose(session, fill.ts || now, opts);
  return true;
}

function applyFill(session, fill, input, opts = {}) {
  const now = input?.now || fill.ts || Date.now();
  rollSession(session, now);
  if (fill.id && !remember(session, fill.id)) return false;
  const ctx = contextFor(fill.symbol, input);
  if (Number.isFinite(fill.cumulative) && fill.order_id) {
    const prev = session.orders[fill.order_id] || { cumulative: 0, average: 0 };
    const delta = fill.cumulative - prev.cumulative;
    if (!(delta > 0)) return false;
    const price = prev.cumulative === 0
      ? fill.average
      : (fill.cumulative * fill.average - prev.cumulative * prev.average) / delta;
    session.orders[fill.order_id] = { cumulative: fill.cumulative, average: fill.average };
    return applyLot(session, {
      symbol: fill.symbol,
      side: fill.side,
      shares: delta,
      price,
      ts: fill.ts || now
    }, ctx, now, opts);
  }
  return applyLot(session, fill, ctx, now, opts);
}

function reconcilePositions(session, positions, input, opts = {}) {
  const now = input?.now || Date.now();
  const live = (positions || []).find(row => row.shares > 0);
  if (!live) {
    if (!session.open) return false;
    const price = Number.isFinite(input?.price) ? input.price : session.open.entry;
    return applyLot(session, {
      symbol: session.open.symbol,
      side: 'SELL',
      shares: session.open.shares,
      price,
      ts: now
    }, contextFor(session.open.symbol, input), now, opts);
  }
  if (!session.open) {
    if (!Number.isFinite(live.average)) return false;
    const ctx = contextFor(live.symbol, input);
    if (!Number.isFinite(ctx.lastBarLow)) return false;
    return applyLot(session, {
      symbol: live.symbol,
      side: 'BUY',
      shares: live.shares,
      price: live.average,
      ts: now
    }, { ...ctx, rebuilt: true, setup: null }, now, opts);
  }
  if (session.open.symbol !== live.symbol) return false;
  if (Math.abs(live.shares - session.open.shares) < 0.0001) return false;
  if (live.shares > session.open.shares && Number.isFinite(live.average)) {
    const added = live.shares - session.open.shares;
    const price = (live.average * live.shares - session.open.entry * session.open.shares) / added;
    return applyLot(session, {
      symbol: live.symbol,
      side: 'BUY',
      shares: added,
      price,
      ts: now
    }, contextFor(live.symbol, input), now, opts);
  }
  return false;
}

function maxLossLeft(session, opts) {
  const { maxLossR, maxLossUsd } = limits(opts);
  const rLeft = Math.max(0, round2(maxLossR + session.realized_r));
  if (maxLossUsd == null) return { value: rLeft, unit: 'R' };
  const usdLeft = Math.max(0, round2(maxLossUsd + session.realized_usd));
  const rUsed = maxLossR > 0 ? Math.max(0, -session.realized_r) / maxLossR : 0;
  const usdUsed = maxLossUsd > 0 ? Math.max(0, -session.realized_usd) / maxLossUsd : 0;
  if (usdUsed >= rUsed) return { value: usdLeft, unit: 'USD' };
  return { value: rLeft, unit: 'R' };
}

function viewOf(session, price, now, opts = {}) {
  const open = session.open;
  const stopHit = Boolean(open && Number.isFinite(price) && price < open.stop);
  const locked = Boolean(session.lockout_until && now < session.lockout_until);
  const left = maxLossLeft(session, opts);
  return {
    position: open ? {
      symbol: open.symbol,
      shares: open.shares,
      entry: round2(open.entry),
      frozen_entry: round2(open.frozen_entry),
      stop: open.stop,
      r: open.r,
      pullback_low: open.pullback_low,
      pullback_source: open.pullback_source,
      setup_state: open.setup_state,
      failing: open.failing
    } : null,
    session: {
      realized_usd: round2(session.realized_usd),
      realized_r: session.realized_r,
      losers: session.losers,
      streak: session.streak,
      max_loss_left: left.value,
      max_loss_unit: left.unit,
      lockout: locked ? 'day' : null,
      lockout_reason: locked ? session.lockout_reason : null
    },
    stop_hit: stopHit
  };
}

function applyMarket(input, opts = {}) {
  const now = input.now || Date.now();
  const session = loadSession(now, opts);
  const status = input.accountStatus || input.account?.status || null;
  if (status && status !== 'ok') {
    const blocked = viewOf(session, null, now, opts);
    blocked.position = null;
    blocked.stop_hit = false;
    blocked.account = { status };
    return blocked;
  }
  let changed = session._dirty === true;
  const account = input.account;
  if (account && Array.isArray(account.fills)) {
    for (const fill of account.fills) {
      if (applyFill(session, fill, { ...input, now }, opts)) changed = true;
    }
  }
  if (account && Array.isArray(account.positions)) {
    if (reconcilePositions(session, account.positions, { ...input, now }, opts)) changed = true;
  }
  if (changed) saveSession(session, opts);
  const price = session.open && session.open.symbol === input.symbol ? input.price : null;
  const shown = viewOf(session, price, now, opts);
  shown.account = status ? { status } : null;
  return shown;
}

module.exports = {
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
  sessionId,
  viewOf
};
