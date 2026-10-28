'use strict';

module.exports = function registerRoutes(app, deps) {
  const {
    SYMBOL_PATTERN,
    TICKER_SUGGESTIONS,
    TOKEN_FILE,
    QUOTE_POLL_MS,
    CANDLE_POLL_MS,
    config,
    ensureSchwabAuth,
    redirectToSchwabLogin,
    handleOAuthCallback,
    getMarketSession,
    isGatekeeperOpen,
    getSchwabCallsPerMinute,
    stateHandler
  } = deps;

  app.get('/login', redirectToSchwabLogin);
  app.get('/api/login', redirectToSchwabLogin);
  app.get('/callback', handleOAuthCallback);
  app.get('/api/state/:symbol', stateHandler);

  app.get('/api/health', async (req, res) => {
    if (!deps.getAuthenticated()) await ensureSchwabAuth();
    let stream = null;
    if (config.marketDataProvider === 'webull' && deps.getStreamStatus) {
      stream = await deps.getStreamStatus();
    }
    res.json({
      authenticated: deps.getAuthenticated(),
      provider: config.marketDataProvider,
      stream,
      token_store: TOKEN_FILE,
      last_successful_fetch: deps.getLastSuccessfulFetch(),
      rate_limit_status: deps.getRateLimitStatus(),
      schwab_calls_per_min: getSchwabCallsPerMinute(),
      poll_intervals_ms: {
        quote: QUOTE_POLL_MS,
        candles: CANDLE_POLL_MS,
        frontend_state: config.frontendStatePollMs
      }
    });
  });

  app.post('/api/stream/reclaim', async (req, res) => {
    if (config.marketDataProvider !== 'webull' || !deps.reclaimStream) {
      return res.status(400).json({ ok: false, error: 'not webull' });
    }
    try {
      await deps.reclaimStream();
      return res.json({ ok: true });
    } catch (err) {
      return res.status(503).json({ ok: false, error: 'redis down' });
    }
  });

  app.get('/api/status', (req, res) => {
    res.json({
      authenticated: deps.getAuthenticated(),
      session: getMarketSession(),
      open: isGatekeeperOpen(),
      hoursEt: '4:00 AM – 8:00 PM'
    });
  });
};
