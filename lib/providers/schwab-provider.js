'use strict';

const { MarketDataProvider } = require('./market-data-provider');

const PRE_START = 4 * 60;
const RTH_START = 9 * 60 + 30;
const RTH_END = 16 * 60;

function inSessions(ms, sessions, getEtHourMinute) {
  const { h, m } = getEtHourMinute(ms);
  const mins = h * 60 + m;
  const wanted = new Set(sessions || ['PRE', 'RTH']);
  if (wanted.has('PRE') && mins >= PRE_START && mins < RTH_START) return true;
  if (wanted.has('RTH') && mins >= RTH_START && mins < RTH_END) return true;
  return false;
}

class SchwabProvider extends MarketDataProvider {
  async backfill(symbol, sessions = ['PRE', 'RTH']) {
    const { getSession1mCandles, getEtHourMinute } = require('../session');
    const candles = await getSession1mCandles(symbol);
    return (candles || []).filter(bar => inSessions(bar.datetime, sessions, getEtHourMinute));
  }

  async stream(symbol) {
    // Schwab has no push stream. Keep the existing single-symbol poll.
    const { startSymbolRefresh } = require('../state');
    startSymbolRefresh(symbol);
  }

  async unstream() {
    const { stopSymbolRefresh } = require('../state');
    stopSymbolRefresh();
  }
}

module.exports = { SchwabProvider };
