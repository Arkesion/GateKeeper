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
    /** MY OWN. Age is measured from the bar close. Fail through 5 minutes, caution through 15. */
    eventFailMs: 5 * 60 * 1000,
    eventCautionMs: 15 * 60 * 1000,
    /** MY OWN. Surge entry, retrace, and the swing low the leg started from. */
    surgeRequiresGreen: true,
    surgeVolumeBaseline: '20bar',
    retraceReference: 'highest_close',
    legLookbackBars: 5,
    /** Wick at least this share of the bar range, and the range at least tailRangeMultiple × the median of the prior bars. */
    toppingTailWickRatio: 0.5,
    bottomingTailWickRatio: 0.5,
    tailRangeMultiple: 1.5,
    tailRangeLookback: 10,
    tailExtremeLookback: 15,
    /** Tail extreme must sit within this fraction of the high or low of the last tailExtremeLookback bars. */
    toppingTailNearHighPct: 0.02,
    /** Relative volume color bands. Over 20× is purple; 20× itself is the green band. */
    rvolBands: [
      { above: 20, color: '#C4B5FD' },
      { min: 10, color: '#1FC08A' },
      { min: 5, color: '#FBBF24' },
      { min: 2, color: '#FB923C' },
      { min: 0, color: '#F2495C' }
    ],
    dojiBodyRatio: 0.1,
    dojiRunLookback: 5,
    dojiRunMinSameDir: 3,
    highVolRatio: 2.0,
    highVolPriorBars: 8,
    /** Red volume must exceed the largest green bar's volume by this multiple. */
    hvSellVolumeRatio: 1,
    /** Red body at least this multiple of the average body of the prior bars. */
    hvSellBodyMultiple: 2,
    hvSellBodyLookback: 10,
    tapeSlowRatio: 0.5,
    levelTestBandUsd: 0.03,
    levelNearBandUsd: 0.10,
    /** Gospel resistance: nearest prior daily high within this fraction above price fails. */
    dailyResistancePct: 0.10,
    levelBreakUsd: 0.02,
    levelBreakLookbackBars: 5,
    frontSideLookbackBars: 12,
    frontSideMinGreenBars: 2,
    frontSideSmallBodyRatio: 0.35,
    frontSideReversalBodyRatio: 0.5,
    frontSideMinHoldPct: 0.40,
    frontSideNearPeakPct: 0.25,
    /** Recent window range vs impulse run range — below = sideways chop */
    frontSideChopRangeRatio: 0.35,
    /** No new HH in this many bars + stale run → chop */
    frontSideChopNoHHBars: 4,
    /** Completed-bar window for mixed green/red chop detection */
    frontSideChopMinMixedBars: 5,
    givebackMinGreenBars: 2,
    givebackLookbackBars: 45,
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

    marketDataProvider: (process.env.MARKET_DATA_PROVIDER || 'schwab').toLowerCase(),
    redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

    symbolPattern: /^[A-Z][A-Z0-9.-]{0,7}$/,

    /** Ross Rule 2. Realized R at or past this locks the day. */
    dailyMaxLossR: Number(process.env.DAILY_MAX_LOSS_R) || 3,
    /** Optional dollar cap. When set, it races the R cap. */
    dailyMaxLossUsd: process.env.DAILY_MAX_LOSS_USD ? Number(process.env.DAILY_MAX_LOSS_USD) : null,
    tradeLog: process.env.TRADE_LOG || '/data/trades.log',
    sessionFile: process.env.SESSION_FILE || '/data/session.json'
  };
}

module.exports = { loadConfig };
