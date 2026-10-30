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
      },
      account: typeof deps.getAccountStatus === 'function' ? deps.getAccountStatus() : null,
      ...(typeof deps.getFillWatch === 'function'
        ? deps.getFillWatch()
        : { orders_stream: null, positions_poll_age_s: null, open_positions: null })
    });
  });

  app.post('/api/symbols/:symbol/unwatch', async (req, res) => {
    if (typeof deps.releaseSymbol !== 'function') {
      return res.status(400).json({ ok: false });
    }
    const result = await deps.releaseSymbol(req.params.symbol);
    const status = result.status || (result.ok ? 200 : 400);
    return res.status(status).json(result);
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

  app.post('/api/dev/fill', (req, res) => {
    const { injectAllowed, applyFill, loadSession, saveSession, viewOf } = require('../lib/trades');
    if (!injectAllowed()) return res.status(404).json({ ok: false });
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      } catch {
        return res.status(400).json({ ok: false });
      }
      const now = Date.now();
      const session = loadSession(now);
      applyFill(session, {
        id: body.id || `dev-${now}`,
        symbol: String(body.symbol || '').toUpperCase(),
        side: String(body.side || 'BUY').toUpperCase(),
        shares: Number(body.shares),
        price: Number(body.price),
        ts: now
      }, {
        symbol: String(body.symbol || '').toUpperCase(),
        now,
        setup: { state: body.setup_state || null, pullback_low: body.pullback_low },
        lastBarLow: body.last_bar_low,
        failing: Array.isArray(body.failing) ? body.failing : []
      });
      saveSession(session);
      return res.json(viewOf(session, Number(body.price), now));
    });
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
