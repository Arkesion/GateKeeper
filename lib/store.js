'use strict';

const { loadConfig } = require('./config');

const config = loadConfig();

module.exports = {
  config,

  accessToken: null,
  refreshToken: null,
  tokenExpiry: null,
  authenticated: false,
  refreshTokenSuspendedUntil: 0,
  proactiveRefreshTimer: null,
  tokenRefreshInFlight: null,
  lastSuccessfulFetch: null,
  rateLimitStatus: 'ok',
  rateLimitBackoffStep: 0,
  rateLimitBackoffUntil: 0,
  rateLimitBackoffPromise: null,

  stateCache: {},
  activeSymbol: null,
  refreshTimers: { quote: null, candles: null },
  refreshInFlight: { quote: false, candles: false },
  marketDataCache: {},
  responseCache: {},
  haltTrackers: {},

  nasdaqHaltsCache: { fetchedAt: 0, rows: [] },
  nasdaqHaltsRefreshPromise: null,
  schwabCallTimestamps: []
};
