'use strict';

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const https = require('https');

const store = require('./lib/store');
const { config } = store;
const auth = require('./lib/auth');
const schwab = require('./lib/schwab');
const state = require('./lib/state');
const halts = require('./lib/halts');
const registerRoutes = require('./routes/api');

const app = express();
const PORT = config.port;

auth.bootstrapTokenStore();
auth.setOnAuthSuccess(() => {
  if (store.activeSymbol) state.startSymbolRefresh(store.activeSymbol);
});

async function stateHandler(req, res) {
  const sym = req.params.symbol.toUpperCase();
  const SYMBOL_PATTERN = config.symbolPattern;
  const TICKER_SUGGESTIONS = config.tickerSuggestions;

  if (!SYMBOL_PATTERN.test(sym)) {
    return res.json({
      status: 'invalid_symbol',
      suggestion: TICKER_SUGGESTIONS[sym] || null
    });
  }

  if (!(await auth.ensureSchwabAuth())) {
    return res.json({ status: 'auth_failed' });
  }

  state.setActiveSymbol(sym);
  state.triggerMinuteEdgeRefresh(sym);

  const cached = store.responseCache[sym];
  if (cached) {
    if (cached.status === 'rate_limited') {
      return res.status(429).json(cached);
    }
    if (cached.status === 'auth_failed' && !store.authenticated) {
      return res.json(cached);
    }
    if (cached.status === 'auth_failed') {
      delete store.responseCache[sym];
    }
    return res.json(cached);
  }

  return res.json({ status: 'insufficient_data', missing: ['initializing'] });
}

registerRoutes(app, {
  SYMBOL_PATTERN: config.symbolPattern,
  TICKER_SUGGESTIONS: config.tickerSuggestions,
  TOKEN_FILE: config.tokenFile,
  QUOTE_POLL_MS: config.quotePollMs,
  CANDLE_POLL_MS: config.candlePollMs,
  config,
  ensureSchwabAuth: auth.ensureSchwabAuth,
  redirectToSchwabLogin: auth.redirectToSchwabLogin,
  handleOAuthCallback: auth.handleOAuthCallback,
  getMarketSession: require('./lib/session').getMarketSession,
  isGatekeeperOpen: require('./lib/session').isGatekeeperOpen,
  getSchwabCallsPerMinute: schwab.getSchwabCallsPerMinute,
  getAuthenticated: () => store.authenticated,
  getLastSuccessfulFetch: () => store.lastSuccessfulFetch,
  getRateLimitStatus: () => store.rateLimitStatus,
  stateHandler
});

app.use(express.static('public'));

async function initAuthOnStartup() {
  if (auth.accessTokenStillValid()) {
    auth.markAuthenticated();
    console.log('✅ Startup: using stored access token (no refresh)');
  } else if (store.refreshToken && Date.now() >= store.refreshTokenSuspendedUntil) {
    await auth.refreshAccessToken({ force: true });
  }
  auth.startProactiveRefreshTimer();
  if (store.authenticated) await auth.probeSchwabAuth().catch(() => {});
}

let httpServer = null;

function shutdown(signal) {
  console.log(`${signal}: shutting down Gatekeeper`);
  state.stopSymbolRefresh();
  if (store.proactiveRefreshTimer) {
    clearInterval(store.proactiveRefreshTimer);
    store.proactiveRefreshTimer = null;
  }
  if (httpServer) {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

function listen() {
  const onListen = () => {
    console.log(`\n🚀 KQ-GateKeeper running at ${config.publicUrl}`);
    console.log(`🔐 Login at ${config.publicUrl}/login`);
    console.log(`💾 Token store: ${config.tokenFile}\n`);
  };
  const { certPath, keyPath } = config;
  if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    httpServer = https.createServer({
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath)
    }, app);
    httpServer.listen(PORT, onListen);
  } else {
    httpServer = app.listen(PORT, onListen);
  }
}

initAuthOnStartup()
  .catch(err => console.error('Startup auth init failed:', err.message))
  .finally(() => {
    halts.startNasdaqHaltPoll();
    listen();
  });
