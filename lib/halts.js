'use strict';
const axios = require('axios');
const { getMarketSession, utcFromEtDateTime, NY_TZ } = require('./session');

const store = require('./store');
const { config } = store;

const NASDAQ_HALT_POLL_MS = config.nasdaqHaltPollMs;
const LUDP_PAUSE_MS = config.ludpPauseMs;
const NASDAQ_HALT_RPC_URL = config.nasdaqHaltRpcUrl;

function formatTimeEtHms(ms) {
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  }).formatToParts(new Date(ms));
  const get = t => parts.find(p => p.type === t)?.value;
  return `${get('hour')}:${get('minute')}:${get('second')}`;
}

function parseNasdaqEtDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const dm = dateStr.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!dm) return null;
  const [, mo, day, yr] = dm;
  const dateIso = `${yr}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const tm = timeStr.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!tm) return null;
  const hour = parseInt(tm[1], 10);
  const minute = parseInt(tm[2], 10);
  const second = parseInt(tm[3], 10);
  const frac = tm[4] ? parseInt(tm[4].padEnd(3, '0').slice(0, 3), 10) : 0;
  const base = utcFromEtDateTime(dateIso, hour, minute);
  if (!Number.isFinite(base)) return null;
  return base + second * 1000 + frac;
}

function displayNasdaqEtTime(timeStr) {
  if (!timeStr) return null;
  const t = timeStr.trim();
  const m = t.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!m) return t;
  const frac = m[4] ? `.${m[4].replace(/0+$/, '') || m[4]}` : '';
  return `${String(parseInt(m[1], 10)).padStart(2, '0')}:${m[2]}:${m[3]}${frac}`;
}

function parseNasdaqHaltsHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let isHeader = true;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    if (isHeader) {
      isHeader = false;
      continue;
    }
    const tds = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let td;
    while ((td = tdRe.exec(m[1])) !== null) {
      tds.push(td[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    }
    if (tds.length < 6) continue;
    rows.push({
      haltDate: tds[0],
      haltTime: tds[1],
      symbol: (tds[2] || '').toUpperCase(),
      issueName: tds[3],
      market: tds[4],
      reasonCode: tds[5],
      pauseThresholdPrice: tds[6] || '',
      resumptionDate: tds[7] || '',
      resumptionQuoteTime: tds[8] || '',
      resumptionTradeTime: tds[9] || ''
    });
  }
  return rows;
}

async function refreshNasdaqHalts() {
  if (store.nasdaqHaltsRefreshPromise) return store.nasdaqHaltsRefreshPromise;
  store.nasdaqHaltsRefreshPromise = (async () => {
    try {
      const res = await axios.post(
        NASDAQ_HALT_RPC_URL,
        { id: 2, method: 'BL_TradeHalt.GetTradeHalts', params: '[]', version: '1.1' },
        {
          headers: { Referer: 'https://www.nasdaqtrader.com/trader.aspx?id=TradeHalts' },
          timeout: 15000
        }
      );
      const html = res.data?.result;
      if (typeof html === 'string') {
        store.nasdaqHaltsCache.rows = parseNasdaqHaltsHtml(html);
        store.nasdaqHaltsCache.fetchedAt = Date.now();
      }
    } catch (err) {
      console.warn('Nasdaq trade halts fetch failed:', err.message);
    } finally {
      store.nasdaqHaltsRefreshPromise = null;
    }
  })();
  return store.nasdaqHaltsRefreshPromise;
}

function startNasdaqHaltPoll() {
  refreshNasdaqHalts();
  setInterval(refreshNasdaqHalts, NASDAQ_HALT_POLL_MS);
}

function findNasdaqHaltRow(symbol) {
  const sym = (symbol || '').toUpperCase();
  if (!sym) return null;
  return store.nasdaqHaltsCache.rows.find(r => r.symbol === sym) || null;
}

function isNasdaqHaltActive(row, now = Date.now()) {
  if (!row) return false;
  const trade = (row.resumptionTradeTime || '').trim();
  if (!trade) return true;
  const resumeMs = parseNasdaqEtDateTime(row.resumptionDate, trade);
  if (!Number.isFinite(resumeMs)) return true;
  return now < resumeMs;
}

function isLudpStyleReason(code) {
  return /^(LUDP|LULD)$/i.test((code || '').trim());
}

function tradingStatusFromNasdaqHalt(row, now = Date.now()) {
  const reason = (row.reasonCode || 'Halt').trim();
  const haltMs = parseNasdaqEtDateTime(row.haltDate, row.haltTime);
  const halt_time_et = displayNasdaqEtTime(row.haltTime);
  const ludp = isLudpStyleReason(reason);

  let resumption_time_et = null;
  let resumption_estimated = false;
  const trade = (row.resumptionTradeTime || '').trim();
  if (trade) {
    resumption_time_et = displayNasdaqEtTime(trade);
  } else if (ludp && Number.isFinite(haltMs)) {
    resumption_time_et = formatTimeEtHms(haltMs + LUDP_PAUSE_MS);
    resumption_estimated = true;
  }

  return {
    status: 'halted',
    status_line: `Status: Halt (${reason})`,
    halt_time_et,
    resumption_time_et,
    resumption_pending: !trade,
    resumption_estimated,
    halt_reason: reason,
    halt_source: 'nasdaq'
  };
}

function normalizeSecurityStatus(quote) {
  const raw = quote?.securityStatus;
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') return raw.trim();
  const codes = {
    0: 'Unknown',
    1: 'Normal',
    2: 'Halted',
    3: 'Paused',
    4: 'Offline',
    5: 'Closed'
  };
  return codes[raw] || String(raw);
}

function haltReasonLabel(quote, statusStr) {
  const s = (statusStr || '').toLowerCase();
  if (/ludp|luld|limit up|limit down/.test(s)) return 'LUDP';
  if (/pause/.test(s)) return 'Paused';
  if (/^halted?$/i.test((statusStr || '').trim())) return 'LUDP';
  if (/halt/.test(s)) return 'Halt';
  if (statusStr) return statusStr;
  return 'LUDP';
}

function detectQuoteHalt(quote, now = Date.now()) {
  const statusStr = normalizeSecurityStatus(quote);
  if (statusStr && /halt|pause|luld|limit state|non.?firm/i.test(statusStr)) {
    return { halted: true, reason: haltReasonLabel(quote, statusStr) };
  }
  const session = getMarketSession(now);
  if (session !== 'RTH' || !quote) return { halted: false };

  const tradeMs = quote.tradeTime || quote.quoteTime;
  if (!Number.isFinite(tradeMs) || !Number.isFinite(quote.lastPrice)) return { halted: false };
  const staleMs = Date.now() - tradeMs;
  const vol = quote.totalVolume;
  if (Number.isFinite(vol) && vol > 0 && staleMs > 180000) {
    return { halted: true, reason: 'LUDP', inferred: true };
  }
  return { halted: false };
}

function computeTradingStatus(symbol, quote, now = Date.now()) {
  if (Date.now() - store.nasdaqHaltsCache.fetchedAt > NASDAQ_HALT_POLL_MS + 5000) {
    refreshNasdaqHalts().catch(() => {});
  }
  const nasdaqRow = findNasdaqHaltRow(symbol);
  if (nasdaqRow && isNasdaqHaltActive(nasdaqRow, now)) {
    return tradingStatusFromNasdaqHalt(nasdaqRow, now);
  }

  const halt = detectQuoteHalt(quote, now);
  let tr = store.haltTrackers[symbol];

  if (halt.halted) {
    if (!tr?.halted) {
      const eventMs = quote?.tradeTime || quote?.quoteTime || now;
      tr = { halted: true, haltSinceMs: eventMs, reason: halt.reason };
      store.haltTrackers[symbol] = tr;
    } else {
      tr.reason = halt.reason || tr.reason;
    }
    const reason = tr.reason || 'LUDP';
    const ludp = isLudpStyleReason(reason) || reason === 'LUDP';
    let resumption_time_et = null;
    let resumption_estimated = false;
    if (ludp && Number.isFinite(tr.haltSinceMs)) {
      resumption_time_et = formatTimeEtHms(tr.haltSinceMs + LUDP_PAUSE_MS);
      resumption_estimated = true;
    }
    return {
      status: 'halted',
      status_line: `Status: Halt (${reason})`,
      halt_time_et: formatTimeEtHms(tr.haltSinceMs),
      resumption_time_et,
      resumption_pending: true,
      resumption_estimated,
      halt_reason: reason,
      halt_source: 'schwab'
    };
  }

  if (tr?.halted) {
    store.haltTrackers[symbol] = {
      halted: false,
      lastResumeMs: now,
      lastHaltReason: tr.reason
    };
  } else if (!tr) {
    store.haltTrackers[symbol] = { halted: false };
  }

  const session = getMarketSession(now);
  if (session === 'CLOSED') {
    return { status: 'closed', status_line: 'Status: Closed', halt_time_et: null, resumption_time_et: null };
  }
  if (session === 'PRE') {
    return { status: 'pre', status_line: 'Status: Pre-Market', halt_time_et: null, resumption_time_et: null };
  }
  if (session === 'POST') {
    return { status: 'ah', status_line: 'Status: After Hours', halt_time_et: null, resumption_time_et: null };
  }
  return { status: 'open', status_line: 'Status: Open', halt_time_et: null, resumption_time_et: null };
}
module.exports = {
  formatTimeEtHms,
  parseNasdaqEtDateTime,
  displayNasdaqEtTime,
  parseNasdaqHaltsHtml,
  refreshNasdaqHalts,
  startNasdaqHaltPoll,
  findNasdaqHaltRow,
  isNasdaqHaltActive,
  isLudpStyleReason,
  tradingStatusFromNasdaqHalt,
  normalizeSecurityStatus,
  haltReasonLabel,
  detectQuoteHalt,
  computeTradingStatus
};
