'use strict';

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const https = require('https');

function writeDiag(line) {
  const text = line.endsWith('\n') ? line : `${line}\n`;
  try {
    fs.writeSync(process.stderr.fd, text);
  } catch {
    /* stderr unavailable */
  }
}

const exitProcess = process.exit.bind(process);
process.exit = code => {
  const err = new Error(`process.exit ${code}`);
  writeDiag(err.stack);
  return exitProcess(code);
};

process.on('beforeExit', code => {
  let handles = '';
  try {
    handles = JSON.stringify(process.getActiveResourcesInfo());
  } catch (err) {
    handles = String(err);
  }
  writeDiag(`event loop drained code=${code} handles=${handles}`);
});

process.on('exit', code => {
  writeDiag(`exit code=${code}`);
});

function startLagMonitor() {
  const intervalMs = 100;
  let expected = Date.now() + intervalMs;
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + intervalMs;
    if (lag > 200) writeDiag(`event loop lag ${lag}ms`);
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}
startLagMonitor();

const store = require('./lib/store');
const { config } = store;
const auth = require('./lib/auth');
const schwab = require('./lib/schwab');
const state = require('./lib/state');
const { getProvider } = require('./lib/providers');
const halts = require('./lib/halts');
const registerRoutes = require('./routes/api');

const app = express();
const PORT = config.port;

auth.bootstrapTokenStore();
auth.setOnAuthSuccess(() => {
  if (store.activeSymbol) state.startSymbolRefresh(store.activeSymbol);
});

async function stateHandler(req, res) {
  const started = Date.now();
  const sym = req.params.symbol.toUpperCase();
  const SYMBOL_PATTERN = config.symbolPattern;
  const TICKER_SUGGESTIONS = config.tickerSuggestions;
  const finish = (body, code) => {
    const status = body && body.status ? body.status : 'unknown';
    writeDiag(`state handler ${sym} ${Date.now() - started}ms status=${status}`);
    if (code) return res.status(code).json(body);
    return res.json(body);
  };

  if (!SYMBOL_PATTERN.test(sym)) {
    return finish({
      status: 'invalid_symbol',
      suggestion: TICKER_SUGGESTIONS[sym] || null
    });
  }

  if (config.marketDataProvider !== 'webull') {
    if (!(await auth.ensureSchwabAuth())) {
      return finish({ status: 'auth_failed' });
    }
  }

  if (config.marketDataProvider === 'webull' && (await state.isStreamTaken())) {
    return finish({ status: 'stream_taken' });
  }

  if (config.marketDataProvider === 'webull' && state.isDataStale()) {
    return finish({ status: 'data_stale' });
  }

  try {
    await state.setActiveSymbol(sym);
  } catch (err) {
    console.error(`Market data (${sym}):`, err.message);
    return finish({ status: 'insufficient_data', missing: ['market_data'] });
  }

  if (config.marketDataProvider === 'webull' && (await state.isStreamTaken())) {
    return finish({ status: 'stream_taken' });
  }

  if (config.marketDataProvider === 'webull' && state.isDataStale()) {
    return finish({ status: 'data_stale' });
  }

  if (config.marketDataProvider !== 'webull') {
    state.triggerMinuteEdgeRefresh(sym);
  }

  const cached = store.responseCache[sym];
  if (cached) {
    if (cached.status === 'rate_limited') {
      return finish(cached, 429);
    }
    if (cached.status === 'auth_failed' && !store.authenticated) {
      return finish(cached);
    }
    if (cached.status === 'auth_failed') {
      delete store.responseCache[sym];
    }
    return finish(cached);
  }

  return finish({ status: 'insufficient_data', missing: ['initializing'] });
}

registerRoutes(app, {
  SYMBOL_PATTERN: config.symbolPattern,
  TICKER_SUGGESTIONS: config.tickerSuggestions,
  TOKEN_FILE: config.tokenFile,
  QUOTE_POLL_MS: config.quotePollMs,
  CANDLE_POLL_MS: config.candlePollMs,
  config,
  ensureSchwabAuth: async () => {
    if (config.marketDataProvider === 'webull') return true;
    return auth.ensureSchwabAuth();
  },
  redirectToSchwabLogin: auth.redirectToSchwabLogin,
  handleOAuthCallback: auth.handleOAuthCallback,
  getMarketSession: require('./lib/session').getMarketSession,
  isGatekeeperOpen: require('./lib/session').isGatekeeperOpen,
  getSchwabCallsPerMinute: schwab.getSchwabCallsPerMinute,
  getAuthenticated: () => (
    config.marketDataProvider === 'webull' ? true : store.authenticated
  ),
  getLastSuccessfulFetch: () => store.lastSuccessfulFetch,
  getRateLimitStatus: () => store.rateLimitStatus,
  getStreamStatus: async () => {
    if (config.marketDataProvider !== 'webull') return null;
    const provider = getProvider();
    if (typeof provider.getStreamStatus !== 'function') return null;
    return provider.getStreamStatus();
  },
  reclaimStream: async () => {
    const provider = getProvider();
    if (typeof provider.reclaim !== 'function') {
      throw new Error('reclaim is not available');
    }
    return provider.reclaim();
  },
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
  writeDiag(`${signal}: shutting down Gatekeeper`);
  state.stopSymbolRefresh();
  if (config.marketDataProvider === 'webull') {
    getProvider().stop().catch(() => {});
  }
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

function logFatal(kind, err) {
  const stack = err && err.stack ? err.stack : String(err);
  writeDiag(`${kind}: ${stack}`);
  process.exit(1);
}

process.on('uncaughtException', err => logFatal('uncaughtException', err));
process.on('unhandledRejection', reason => logFatal('unhandledRejection', reason));

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
  } else {
    httpServer = app.listen(PORT, onListen);
  }
  httpServer.on('close', () => writeDiag('http server close'));
  httpServer.on('error', err => writeDiag(`http server error: ${err && err.stack ? err.stack : err}`));
  if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    httpServer.listen(PORT, onListen);
  }
}

async function init() {
  if (config.marketDataProvider === 'webull') {
    const provider = getProvider();
    provider.onUpdate = (symbol, data) => state.applyMarketData(symbol, data);
    await provider.start();
    console.log('Webull provider reading Redis');
    return;
  }
  await initAuthOnStartup();
}

init()
  .catch(err => console.error('Startup init failed:', err.message))
  .finally(() => {
    halts.startNasdaqHaltPoll();
    listen();
  });
