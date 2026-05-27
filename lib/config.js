'use strict';

/**
 * Centralized environment and tuning constants for Gatekeeper.
 * Single source of truth before lib/ modular split is fully wired.
 */
function loadConfig() {
  const publicUrl = (process.env.PUBLIC_URL || 'https://gatekeeper.veilforge.org').replace(/\/$/, '');
  const redirectUri = process.env.REDIRECT_URI || `${publicUrl}/callback`;

  return {
    port: Number(process.env.PORT) || 3000,
    tokenFile: process.env.TOKEN_PATH || '/data/tokens.json',
    tokenRefreshBufferMs: 5 * 60 * 1000,
    refreshSuspendMs: 15 * 60 * 1000,
    proactiveRefreshCheckMs: 60 * 1000,

    schwabClientId: process.env.SCHWAB_CLIENT_ID,
    schwabClientSecret: process.env.SCHWAB_CLIENT_SECRET,
    publicUrl,
    redirectUri,

    certPath: process.env.CERT_PATH,
    keyPath: process.env.KEY_PATH,

    quotePollMs: Number(process.env.QUOTE_POLL_MS) || 1000,
    candlePollMs: Number(process.env.CANDLE_POLL_MS) || 2000,
    dailyCacheMs: Number(process.env.DAILY_CACHE_MS) || 60000,
    indicator1mCacheMs: Number(process.env.INDICATOR_1M_CACHE_MS) || 60000,
    indicator1mPeriod: 10,
    frontendStatePollMs: Number(process.env.STATE_POLL_MS) || 1000,
    nasdaqHaltPollMs: Number(process.env.NASDAQ_HALT_POLL_MS) || 60000,

    macdMinBars: 26,
    macdMinBarsSparse: 20,
    sessionMinBars: 4,
    warningWindowMs: 8 * 60 * 1000,
    toppingTailWickRatio: 0.6,
    bottomingTailWickRatio: 0.6,
    dojiBodyRatio: 0.1,
    dojiRunLookback: 5,
    dojiRunMinSameDir: 3,
    highVolRatio: 2.0,
    highVolPriorBars: 8,
    tapeSlowRatio: 0.5,
    levelTestBandUsd: 0.03,
    levelNearBandUsd: 0.10,
    levelBreakUsd: 0.02,
    levelBreakLookbackBars: 5,
    frontSideLookbackBars: 12,
    frontSideMinGreenBars: 2,
    frontSideSmallBodyRatio: 0.35,
    frontSideReversalBodyRatio: 0.5,
    frontSideMinHoldPct: 0.40,
    frontSideNearPeakPct: 0.25,
    givebackMinGreenBars: 2,
    givebackMoveMinUsd: 0.05,
    givebackWarnRatio: 0.30,
    givebackFailRatio: 0.50,
    maxBidAskSpreadUsd: 0.10,

    ludpPauseMs: 5 * 60 * 1000,
    nasdaqHaltRpcUrl: 'https://www.nasdaqtrader.com/RPCHandler.axd',
    backoffMs: [5000, 10000, 20000],

    tickerSuggestions: {
      APPL: 'AAPL',
      GOOG: 'GOOGL',
      BRK: 'BRK.B'
    },

    symbolPattern: /^[A-Z][A-Z0-9.-]{0,7}$/
  };
}

module.exports = { loadConfig };
