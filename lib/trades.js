'use strict';

const fs = require('fs');
const { getEtDateString, utcFromEtDateTime, openingBlackout } = require('./session');

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

function signalLogPath(opts = {}) {
  return opts.signalLog || process.env.SIGNAL_LOG || '/data/signal.log';
}

function writeFillSignal(row, opts) {
  try {
    fs.appendFileSync(signalLogPath(opts), JSON.stringify(row) + '\n');
  } catch {
    /* a missing log path must not stop the fill */
  }
}

function limits(opts = {}) {
  const fromEnv = Number(process.env.DAILY_MAX_LOSS_R);
  const maxLossR = opts.maxLossR ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 3);
  let maxLossUsd = 0.5;
  if (opts.maxLossUsd !== undefined) maxLossUsd = opts.maxLossUsd;
  else if (process.env.DAILY_MAX_LOSS_USD != null && process.env.DAILY_MAX_LOSS_USD !== '') {
    const usd = Number(process.env.DAILY_MAX_LOSS_USD);
    maxLossUsd = Number.isFinite(usd) && usd > 0 ? usd : null;
  }
  if (maxLossUsd != null && !(maxLossUsd > 0)) maxLossUsd = null;
  const rEnv = Number(process.env.DEFAULT_R_PER_SHARE);
  const defaultR = opts.defaultR ?? (Number.isFinite(rEnv) && rEnv > 0 ? rEnv : 0.10);
  return { maxLossR, maxLossUsd, defaultR };
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
    trades: 0,
    blackout_trades: 0,
    symbol_losers: {},
    estimates: [],
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
  session.trades = 0;
  session.blackout_trades = 0;
  session.symbol_losers = {};
  session.estimates = [];
  session.exit = null;
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
  if (momentum?.front_side?.state && momentum.front_side.state !== 'green') {
    out.push(momentum.front_side.phase === 'back' ? 'Back side' : 'Choppy');
  }
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
    exit_cost: 0,
    order_ids: []
  };
  return true;
}

function noteOrder(open, id) {
  if (!open || !id) return;
  if (!Array.isArray(open.order_ids)) open.order_ids = [];
  if (!open.order_ids.includes(id)) open.order_ids.push(id);
}

function addShares(open, shares, price) {
  open.cost += price * shares;
  open.shares = round4(open.shares + shares);
  open.entry = round4(open.cost / open.shares);
}

function noteBlackoutBuy(session, fill, opts) {
  if (fill.side !== 'BUY' || !openingBlackout(fill.ts || Date.now())) return;
  session.blackout_trades = (session.blackout_trades || 0) + 1;
  if (session.open) session.open.blackout = true;
  writeFillSignal({
    kind: 'fill',
    t: new Date(fill.ts || Date.now()).toISOString(),
    symbol: fill.symbol,
    side: 'BUY',
    price: fill.price,
    blackout: true
  }, opts);
}

function shownPnl(entry, shares, r, mark, exitPrice) {
  const exited = arguments.length >= 5;
  const price = exited ? exitPrice : mark;
  if (!Number.isFinite(entry) || !(shares > 0) || !Number.isFinite(price) || !(r > 0)) return null;
  return {
    pnl: (price - entry) * shares,
    r: (price - entry) / r
  };
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
    failing: open.failing,
    order_ids: [...(open.order_ids || [])],
    stop: open.stop,
    r: open.r,
    blackout: open.blackout === true,
    estimated: open.estimated === true
  };
  if (open.estimated === true) {
    if (!session.estimates) session.estimates = [];
    session.estimates.push({
      symbol: open.symbol,
      opened_at: open.opened_at,
      shares,
      entry: round4(open.entry),
      exit: round4(exit),
      r: open.r,
      order_ids: row.order_ids
    });
  }
  try {
    fs.appendFileSync(tradeLogPath(opts), JSON.stringify(row) + '\n');
  } catch {
    /* the log is on the volume in production */
  }
  const beforeR = session.realized_r;
  const beforeUsd = session.realized_usd;
  session.realized_usd = round2(session.realized_usd + realized);
  session.realized_r = Math.round((session.realized_r + rMultiple) * 100) / 100;
  if (!isScratch(realized, shares)) {
    if (realized < 0) {
      session.streak += 1;
      session.losers += 1;
      if (!session.symbol_losers) session.symbol_losers = {};
      const name = open.symbol;
      session.symbol_losers[name] = (session.symbol_losers[name] || 0) + 1;
    } else if (realized > 0) {
      session.streak = 0;
    }
  }
  session.exit = null;
  assignLock(session, now, opts, beforeR, beforeUsd);
  session.open = null;
}

function assignLock(session, now, opts, beforeR, beforeUsd) {
  if (session.lockout_reason) return;
  const { maxLossR, maxLossUsd } = limits(opts);
  const rHit = session.realized_r <= -maxLossR;
  const usdHit = maxLossUsd != null && session.realized_usd <= -maxLossUsd;
  let reason = null;
  if (rHit || usdHit) {
    reason = 'r';
    if (rHit && usdHit) {
      const rDrop = session.realized_r - beforeR;
      const usdDrop = session.realized_usd - beforeUsd;
      const rFrac = rDrop < 0 ? (-maxLossR - beforeR) / rDrop : 1;
      const usdFrac = usdDrop < 0 ? (-maxLossUsd - beforeUsd) / usdDrop : 1;
      if (usdFrac < rFrac) reason = 'usd';
    } else if (usdHit) {
      reason = 'usd';
    }
  } else if (session.streak >= 3) {
    reason = 'losers';
  }
  if (!reason) return;
  session.lockout_until = nextSessionStart(now);
  session.lockout_reason = reason;
}

function applyLot(session, lot, ctx, now, opts) {
  if (!(lot.shares > 0) || !Number.isFinite(lot.price)) return false;
  const fill = {
    symbol: lot.symbol,
    side: lot.side,
    shares: lot.shares,
    price: lot.price,
    ts: lot.ts || now,
    order_id: lot.order_id || lot.id
  };
  if (fill.side === 'BUY') {
    if (!session.open) {
      const opened = openTrade(session, fill, ctx);
      if (opened) {
        noteOrder(session.open, fill.order_id);
        noteBlackoutBuy(session, fill, opts);
      }
      return opened;
    }
    if (session.open.symbol !== fill.symbol) return false;
    addShares(session.open, fill.shares, fill.price);
    noteOrder(session.open, fill.order_id);
    noteBlackoutBuy(session, fill, opts);
    return true;
  }
  if (!session.open || session.open.symbol !== fill.symbol) return false;
  noteOrder(session.open, fill.order_id);
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
      ts: fill.ts || now,
      order_id: fill.order_id || fill.id
    }, ctx, now, opts);
  }
  return applyLot(session, fill, ctx, now, opts);
}

function lotId(lot) {
  return lot.order_id || lot.id || `${lot.symbol}:${lot.side}:${lot.ts}`;
}

function stampBuyOrder(session, lots) {
  const open = session.open;
  if (!open) return;
  const buys = (lots || []).filter(lot =>
    lot && lot.symbol === open.symbol && lot.side === 'BUY' && (lot.order_id || lot.id)
  );
  const before = buys.filter(lot => !Number.isFinite(lot.ts) || lot.ts <= (open.opened_at || Infinity));
  const buy = (before.length ? before : buys).at(-1);
  if (buy) noteOrder(open, buy.order_id || buy.id);
}

function closeOpenFromHistory(session, lots, input, opts) {
  if (!session.open || !Array.isArray(lots)) return false;
  stampBuyOrder(session, lots);
  const open = session.open;
  const sells = lots
    .filter(lot => lot && lot.symbol === open.symbol && lot.side === 'SELL' && lot.shares > 0 && Number.isFinite(lot.price))
    .filter(lot => !Number.isFinite(lot.ts) || lot.ts + 5000 >= (open.opened_at || 0))
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  let changed = false;
  for (const lot of sells) {
    if (!session.open) break;
    if (applyFill(session, {
      id: lotId(lot),
      order_id: lot.order_id || lot.id,
      symbol: lot.symbol,
      side: 'SELL',
      shares: lot.shares,
      price: lot.price,
      ts: lot.ts
    }, { ...input, symbol: open.symbol }, opts)) changed = true;
  }
  return changed;
}

function reconcilePositions(session, positions, input, opts = {}) {
  const now = input?.now || Date.now();
  const live = (positions || []).find(row => row.shares > 0);
  if (!live) return false;
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

function sellMatchesOpen(open, lots) {
  if (!open) return false;
  return (lots || []).some(lot =>
    lot &&
    lot.symbol === open.symbol &&
    lot.side === 'SELL' &&
    lot.shares > 0 &&
    Number.isFinite(lot.price) &&
    (!Number.isFinite(lot.ts) || lot.ts + 5000 >= (open.opened_at || 0))
  );
}

function noteFlat(session, positions, dayFills, exitNote) {
  const open = session.open;
  if (!open) {
    if (!session.exit) return false;
    session.exit = null;
    return true;
  }
  if (!Array.isArray(positions)) return false;
  const live = positions.some(row => row && row.symbol === open.symbol && row.shares > 0);
  if (live || sellMatchesOpen(open, dayFills)) {
    if (!session.exit) return false;
    session.exit = null;
    return true;
  }
  const unconfirmed = exitNote
    && exitNote.status === 'unconfirmed'
    && exitNote.symbol === open.symbol;
  const estimated = exitNote
    && exitNote.status === 'estimated'
    && exitNote.symbol === open.symbol;
  const status = estimated ? 'estimated' : (unconfirmed ? 'unconfirmed' : 'confirming');
  const price = Number.isFinite(exitNote?.price) ? exitNote.price : null;
  if (session.exit
    && session.exit.status === status
    && session.exit.symbol === open.symbol
    && session.exit.price === price) return false;
  session.exit = { symbol: open.symbol, status, price };
  return true;
}

function fillsCoverEstimate(lots, estimate) {
  const name = estimate && estimate.symbol;
  const opened = estimate && estimate.opened_at;
  if (!name) return false;
  const buys = (lots || []).some(lot =>
    lot && lot.symbol === name && lot.side === 'BUY' && lot.shares > 0
    && (!Number.isFinite(lot.ts) || !Number.isFinite(opened) || lot.ts <= opened + 5000)
  );
  const sells = (lots || []).some(lot =>
    lot && lot.symbol === name && lot.side === 'SELL' && lot.shares > 0 && Number.isFinite(lot.price)
    && (!Number.isFinite(lot.ts) || !Number.isFinite(opened) || lot.ts + 5000 >= opened)
  );
  return buys && sells;
}

function lotsWithEstimates(lots, estimates) {
  const extra = [];
  for (const estimate of estimates || []) {
    const opened = estimate.opened_at || 0;
    const ids = estimate.order_ids || [];
    const buyId = ids.find(id => id && !String(id).startsWith('estimate:'))
      || `estimate-buy:${estimate.symbol}:${opened}`;
    extra.push({
      symbol: estimate.symbol,
      side: 'BUY',
      shares: estimate.shares,
      price: estimate.entry,
      ts: opened,
      order_id: buyId
    });
    extra.push({
      symbol: estimate.symbol,
      side: 'SELL',
      shares: estimate.shares,
      price: estimate.exit,
      ts: opened + 1,
      order_id: `estimate:${estimate.symbol}:${opened}`
    });
  }
  return [...(lots || []), ...extra];
}

function bookEstimate(session, exitNote, input, opts) {
  const open = session.open;
  if (!open || !exitNote || exitNote.status !== 'estimated') return false;
  if (String(exitNote.symbol || '').toUpperCase() !== open.symbol) return false;
  const price = Number.isFinite(exitNote.price) ? exitNote.price : input?.price;
  if (!Number.isFinite(price)) return false;
  const now = input?.now || Date.now();
  open.estimated = true;
  return applyLot(session, {
    symbol: open.symbol,
    side: 'SELL',
    shares: open.shares,
    price,
    ts: now,
    order_id: `estimate:${open.symbol}:${open.opened_at || now}`
  }, {}, now, opts);
}

function sessionWindow(id) {
  return {
    start: utcFromEtDateTime(id, 4, 0),
    end: utcFromEtDateTime(nextDate(id), 4, 0)
  };
}

function pairFills(lots) {
  const books = new Map();
  const closed = [];
  const ordered = [...(lots || [])].filter(lot => lot && lot.symbol && lot.ts).sort((a, b) => a.ts - b.ts);
  for (const lot of ordered) {
    const queue = books.get(lot.symbol) || [];
    books.set(lot.symbol, queue);
    if (lot.side === 'BUY') {
      queue.push({ shares: lot.shares, price: lot.price, ts: lot.ts, order_id: lot.order_id });
      continue;
    }
    let left = lot.shares;
    const orderIds = [];
    const parts = [];
    while (left > 0.0001 && queue.length) {
      const open = queue[0];
      const take = Math.min(left, open.shares);
      if (open.order_id && !orderIds.includes(open.order_id)) orderIds.push(open.order_id);
      parts.push({ realized: (lot.price - open.price) * take, shares: take });
      open.shares -= take;
      left -= take;
      if (open.shares <= 0.0001) queue.shift();
    }
    if (lot.order_id && !orderIds.includes(lot.order_id)) orderIds.push(lot.order_id);
    if (parts.length) {
      const realized = parts.reduce((sum, part) => sum + part.realized, 0);
      const shares = parts.reduce((sum, part) => sum + part.shares, 0);
      closed.push({ symbol: lot.symbol, realized, shares, ts: lot.ts, order_ids: orderIds });
    }
  }
  closed.sort((a, b) => a.ts - b.ts);
  return closed;
}

function readTradeLog(opts) {
  try {
    return fs.readFileSync(tradeLogPath(opts), 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function orderKey(ids) {
  return [...(ids || [])].filter(Boolean).sort().join('|');
}

function rForTrade(trade, logged, opts) {
  const row = logged.get(orderKey(trade.order_ids));
  if (row && Number(row.r) > 0) return { r: Number(row.r), estimated: false };
  return { r: limits(opts).defaultR, estimated: true };
}

function summarizeFills(lots, sessionDate, now, opts) {
  const window = sessionWindow(sessionDate);
  const closed = pairFills((lots || []).filter(lot => lot.ts >= window.start && lot.ts < window.end));
  const logged = new Map();
  for (const row of readTradeLog(opts)) {
    const key = orderKey(row.order_ids);
    if (key) logged.set(key, row);
  }
  const book = {
    realized_usd: 0,
    realized_r: 0,
    trades: 0,
    streak: 0,
    losers: 0,
    symbol_losers: {},
    blackout_trades: 0,
    r_estimated: false,
    lockout_until: null,
    lockout_reason: null
  };
  book.blackout_trades = (lots || []).filter(lot =>
    lot && lot.side === 'BUY' && lot.ts >= window.start && lot.ts < window.end && openingBlackout(lot.ts)
  ).length;
  for (const trade of closed) {
    const pnl = round2(trade.realized);
    const beforeR = book.realized_r;
    const beforeUsd = book.realized_usd;
    const picked = rForTrade(trade, logged, opts);
    const rMultiple = picked.r > 0 ? pnl / (picked.r * trade.shares) : 0;
    book.trades += 1;
    book.realized_usd = round2(book.realized_usd + pnl);
    book.realized_r = Math.round((book.realized_r + rMultiple) * 100) / 100;
    if (picked.estimated) book.r_estimated = true;
    if (!isScratch(pnl, trade.shares)) {
      if (pnl < 0) {
        book.streak += 1;
        book.losers += 1;
        if (trade.symbol) {
          book.symbol_losers[trade.symbol] = (book.symbol_losers[trade.symbol] || 0) + 1;
        }
      } else if (pnl > 0) {
        book.streak = 0;
      }
    }
    assignLock(book, now, opts, beforeR, beforeUsd);
  }
  return book;
}

function rebuildFromFills(session, lots, now, opts = {}) {
  const id = sessionId(now);
  const kept = (session.estimates || []).filter(estimate => !fillsCoverEstimate(lots, estimate));
  const summary = summarizeFills(lotsWithEstimates(lots, kept), id, now, opts);
  const beforeUsd = round2(session.realized_usd || 0);
  const beforeTrades = session.trades || 0;
  const beforeStreak = session.streak || 0;
  const beforeR = Math.round((session.realized_r || 0) * 100) / 100;
  const beforeSymbols = JSON.stringify(session.symbol_losers || {});
  const nextSymbols = JSON.stringify(summary.symbol_losers || {});
  const nextBlackout = Math.max(session.blackout_trades || 0, summary.blackout_trades || 0);
  const beforeEstimates = JSON.stringify(session.estimates || []);
  const nextEstimates = JSON.stringify(kept);
  const same = beforeUsd === summary.realized_usd
    && beforeTrades === summary.trades
    && beforeStreak === summary.streak
    && beforeR === summary.realized_r
    && beforeSymbols === nextSymbols
    && (session.blackout_trades || 0) === nextBlackout
    && beforeEstimates === nextEstimates
    && (session.r_estimated === true) === summary.r_estimated;
  if (same) return { changed: false, line: null };
  session.realized_usd = summary.realized_usd;
  session.trades = summary.trades;
  session.streak = summary.streak;
  session.losers = summary.losers;
  session.symbol_losers = summary.symbol_losers || {};
  session.blackout_trades = Math.max(session.blackout_trades || 0, summary.blackout_trades || 0);
  session.estimates = kept;
  session.realized_r = summary.realized_r;
  session.r_estimated = summary.r_estimated;
  session.lockout_until = summary.lockout_until;
  session.lockout_reason = summary.lockout_reason;
  const line = `session rebuild ${id} realized ${beforeUsd.toFixed(2)} -> ${summary.realized_usd.toFixed(2)} trades ${beforeTrades} -> ${summary.trades} streak ${beforeStreak} -> ${summary.streak}`;
  return { changed: true, line };
}

let priorSessionLogged = false;

function logPriorSessionOnce(lots, now, opts = {}) {
  if (priorSessionLogged || !Array.isArray(lots)) return;
  priorSessionLogged = true;
  console.log(priorSessionLine(lots, now, opts));
}

function priorSessionLine(lots, now, opts = {}) {
  const prior = prevDate(sessionId(now));
  const at = utcFromEtDateTime(nextDate(prior), 3, 59);
  const summary = summarizeFills(lots, prior, at, opts);
  const lock = summary.lockout_reason || 'none';
  return `session ${prior} realized=${summary.realized_usd.toFixed(2)} trades=${summary.trades} streak=${summary.streak} lockout=${lock}`;
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
      opened_at: open.opened_at,
      setup_state: open.setup_state,
      failing: open.failing
    } : null,
    exit: open && session.exit && session.exit.symbol === open.symbol ? session.exit : null,
    session: {
      realized_usd: round2(session.realized_usd),
      realized_r: session.realized_r,
      losers: session.losers,
      streak: session.streak,
      symbol_losers: session.symbol_losers || {},
      locked_symbols: Object.entries(session.symbol_losers || {})
        .filter(([, count]) => count >= 3)
        .map(([name]) => name),
      max_loss_left: left.value,
      max_loss_unit: left.unit,
      lockout: locked ? 'day' : null,
      lockout_reason: locked ? session.lockout_reason : null,
      lockout_until: session.lockout_until || null,
      r_estimated: session.r_estimated === true,
      blackout_trades: session.blackout_trades || 0
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
  if (account && Array.isArray(account.dayFills)) stampBuyOrder(session, account.dayFills);
  if (account && Array.isArray(account.fills)) {
    for (const fill of account.fills) {
      if (applyFill(session, fill, { ...input, now }, opts)) changed = true;
    }
  }
  if (account && Array.isArray(account.positions)) {
    if (reconcilePositions(session, account.positions, { ...input, now }, opts)) changed = true;
  }
  if (account && Array.isArray(account.dayFills)) {
    if (closeOpenFromHistory(session, account.dayFills, { ...input, now }, opts)) changed = true;
  }
  if (account && bookEstimate(session, account.exit, { ...input, now }, opts)) changed = true;
  if (account && Array.isArray(account.dayFills)) {
    const rebuilt = rebuildFromFills(session, account.dayFills, now, opts);
    if (rebuilt.changed) {
      changed = true;
      console.log(rebuilt.line);
    }
    logPriorSessionOnce(account.dayFills, now, opts);
  }
  if (account && noteFlat(session, account.positions, account.dayFills, account.exit)) changed = true;
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
  shownPnl,
  loadSession,
  nextSessionStart,
  logPriorSessionOnce,
  priorSessionLine,
  rebuildFromFills,
  reconcilePositions,
  saveSession,
  sessionId,
  viewOf
};
