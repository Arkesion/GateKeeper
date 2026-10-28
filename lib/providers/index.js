'use strict';

const store = require('../store');

let provider = null;

function createProvider() {
  if (store.config.marketDataProvider === 'webull') {
    const { WebullProvider } = require('./webull-provider');
    return new WebullProvider();
  }
  const { SchwabProvider } = require('./schwab-provider');
  return new SchwabProvider();
}

function getProvider() {
  if (!provider) provider = createProvider();
  return provider;
}

module.exports = { getProvider };
