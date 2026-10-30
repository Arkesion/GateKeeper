'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { config } = store;

const SCHWAB_AUTH_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const MARKET_DATA_URL = 'https://api.schwabapi.com/marketdata/v1';
const clientId = config.schwabClientId;
const clientSecret = config.schwabClientSecret;
const publicUrl = config.publicUrl;
const redirectUri = config.redirectUri;
const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

let onAuthSuccess = null;

function setOnAuthSuccess(fn) {
  onAuthSuccess = fn;
}

if (!redirectUri.includes('/callback')) {
  console.warn('⚠️ REDIRECT_URI should end with /callback — Schwab OAuth will fail');
}
if (redirectUri.includes('127.0.0.1') && publicUrl.includes('veilforge')) {
  console.error('⚠️ REDIRECT_URI points at 127.0.0.1 but PUBLIC_URL is production — fix .env');
}

const TOKEN_FILE = config.tokenFile;
const TOKEN_REFRESH_BUFFER_MS = config.tokenRefreshBufferMs;
const REFRESH_SUSPEND_MS = config.refreshSuspendMs;
const PROACTIVE_REFRESH_CHECK_MS = config.proactiveRefreshCheckMs;

class SchwabError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}


function ensureTokenDir() {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function migrateTokenFile() {
  if (fs.existsSync(TOKEN_FILE)) return;
  const legacyPaths = [
    path.join(process.cwd(), 'tokens.json'),
    '/app/tokens.json'
  ];
  for (const legacy of legacyPaths) {
    if (legacy === TOKEN_FILE || !fs.existsSync(legacy)) continue;
    try {
      ensureTokenDir();
      fs.copyFileSync(legacy, TOKEN_FILE);
      console.log(`✅ Migrated tokens → ${TOKEN_FILE}`);
      return;
    } catch (e) {
      console.warn(`Token migration from ${legacy} failed:`, e.message);
    }
  }
}

function saveTokens() {
  try {
    ensureTokenDir();
    const payload = JSON.stringify({
      accessToken: store.accessToken,
      refreshToken: store.refreshToken,
      tokenExpiry: store.tokenExpiry
    });
    const tmp = `${TOKEN_FILE}.tmp`;
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, TOKEN_FILE);
    console.log(`💾 Tokens saved (${TOKEN_FILE})`);
  } catch (e) {
    console.error('Token save failed:', e.message);
  }
}

function accessTokenStillValid() {
  return Boolean(store.accessToken && store.tokenExpiry && Date.now() < store.tokenExpiry - TOKEN_REFRESH_BUFFER_MS);
}

function accessTokenNeedsRefresh() {
  if (!store.accessToken || !store.tokenExpiry) return true;
  return Date.now() >= store.tokenExpiry - TOKEN_REFRESH_BUFFER_MS;
}

function isInvalidGrantError(err) {
  const data = err.response?.data;
  const desc = typeof data?.error_description === 'string' ? data.error_description : '';
  return err.response?.status === 400 && (
    data?.error === 'unsupported_token_type' ||
    desc.includes('invalid_grant') ||
    desc.includes('Refresh token is invalid')
  );
}

function suspendRefreshAttempts() {
  store.refreshTokenSuspendedUntil = Date.now() + REFRESH_SUSPEND_MS;
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const d = JSON.parse(fs.readFileSync(TOKEN_FILE));
      store.accessToken  = d.accessToken;
      store.refreshToken = d.refreshToken;
      store.tokenExpiry  = d.tokenExpiry;
      store.authenticated = accessTokenStillValid();
      console.log(`✅ Tokens loaded (${TOKEN_FILE})`);
    }
  } catch (e) {
    console.error('Token load failed:', e.message);
  }
}

function bootstrapTokenStore() {
  ensureTokenDir();
  migrateTokenFile();
  loadTokens();
}

function clearAuthFailedCache() {
  for (const sym of Object.keys(store.responseCache)) {
    if (store.responseCache[sym]?.status === 'auth_failed') delete store.responseCache[sym];
  }
}

function markAuthenticated() {
  store.authenticated = true;
  clearAuthFailedCache();
}


function redirectToSchwabLogin(req, res) {
  const authUrl = `${SCHWAB_AUTH_URL}?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(authUrl);
}

async function handleOAuthCallback(req, res) {
  const code = req.query.code;
  if (!code) return res.send('No auth code received.');
  try {
    const response = await axios.post(SCHWAB_TOKEN_URL,
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
      { headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    store.accessToken  = response.data.access_token;
    store.refreshToken = response.data.refresh_token;
    store.tokenExpiry  = Date.now() + (response.data.expires_in * 1000);
    store.refreshTokenSuspendedUntil = 0;
    saveTokens();
    markAuthenticated();
    startProactiveRefreshTimer();
    console.log('✅ Authenticated with Schwab');
    if (onAuthSuccess) onAuthSuccess();
    res.send('<script>window.close();</script>Authenticated! You can close this window.');
  } catch (err) {
    console.error('Auth error:', err.response?.data || err.message);
    res.send('Authentication failed. Check console.');
  }
}

async function refreshAccessToken({ force = false } = {}) {
  if (!store.refreshToken && !accessTokenStillValid()) {
    store.authenticated = false;
    return false;
  }
  if (!force && accessTokenStillValid()) {
    markAuthenticated();
    return true;
  }
  if (!store.refreshToken) {
    if (accessTokenStillValid()) {
      markAuthenticated();
      return true;
    }
    store.authenticated = false;
    return false;
  }
  if (Date.now() < store.refreshTokenSuspendedUntil) {
    if (accessTokenStillValid()) {
      markAuthenticated();
      return true;
    }
    store.authenticated = false;
    return false;
  }

  if (store.tokenRefreshInFlight) return store.tokenRefreshInFlight;

  store.tokenRefreshInFlight = (async () => {
    try {
      const response = await axios.post(SCHWAB_TOKEN_URL,
        new URLSearchParams({ grant_type: 'refresh_token', refresh_token: store.refreshToken }),
        { headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      store.accessToken = response.data.access_token;
      if (response.data.refresh_token) store.refreshToken = response.data.refresh_token;
      store.tokenExpiry = Date.now() + (response.data.expires_in * 1000);
      store.refreshTokenSuspendedUntil = 0;
      saveTokens();
      markAuthenticated();
      console.log('🔄 Token refreshed');
      return true;
    } catch (err) {
      if (isInvalidGrantError(err)) {
        console.error('Refresh token rejected — suspend refresh retries; re-login if access expires');
        store.refreshToken = null;
        suspendRefreshAttempts();
        saveTokens();
      } else {
        console.error('Token refresh failed:', err.response?.status, err.response?.data || err.message);
      }
      if (accessTokenStillValid()) {
        markAuthenticated();
        return true;
      }
      store.authenticated = false;
      return false;
    } finally {
      store.tokenRefreshInFlight = null;
    }
  })();

  return store.tokenRefreshInFlight;
}

/** Single entry: use valid access token; refresh only when near expiry or forced. */
async function ensureSchwabAuth({ forceRefresh = false } = {}) {
  if (!forceRefresh && accessTokenStillValid()) {
    markAuthenticated();
    return true;
  }
  if (!forceRefresh && !accessTokenNeedsRefresh()) {
    markAuthenticated();
    return true;
  }
  return refreshAccessToken({ force: true });
}

function startProactiveRefreshTimer() {
  if (store.proactiveRefreshTimer) return;
  store.proactiveRefreshTimer = setInterval(() => {
    if (!store.refreshToken || Date.now() < store.refreshTokenSuspendedUntil) return;
    if (!accessTokenNeedsRefresh()) return;
    refreshAccessToken({ force: true }).catch(() => {});
  }, PROACTIVE_REFRESH_CHECK_MS);
}

async function probeSchwabAuth() {
  if (!(await ensureSchwabAuth())) return false;
  try {
    const res = await axios.get(`${MARKET_DATA_URL}/quotes`, {
      headers: { 'Authorization': `Bearer ${store.accessToken}` },
      params: { symbols: 'SPY', fields: 'quote' },
      validateStatus: () => true
    });
    if (res.status === 200) {
      const { markFetchSuccess } = require('./schwab');
      markFetchSuccess();
      return true;
    }
    console.warn('Auth probe failed:', res.status);
    return false;
  } catch (err) {
    console.warn('Auth probe error:', err.message);
    return false;
  }
}
module.exports = {
  SchwabError,
  TOKEN_FILE,
  MARKET_DATA_URL,
  clientId,
  redirectUri,
  basicAuth,
  SCHWAB_AUTH_URL,
  SCHWAB_TOKEN_URL,
  setOnAuthSuccess,
  ensureTokenDir,
  migrateTokenFile,
  loadTokens,
  bootstrapTokenStore,
  saveTokens,
  accessTokenStillValid,
  accessTokenNeedsRefresh,
  clearAuthFailedCache,
  markAuthenticated,
  redirectToSchwabLogin,
  handleOAuthCallback,
  refreshAccessToken,
  ensureSchwabAuth,
  startProactiveRefreshTimer,
  probeSchwabAuth
};
