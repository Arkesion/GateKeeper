'use strict';

class MarketDataProvider {
  async start() {}

  async stop() {}

  isDataStale() {
    return false;
  }

  async backfill(_symbol, _sessions) {
    throw new Error('backfill is not implemented');
  }

  async stream(_symbol) {
    throw new Error('stream is not implemented');
  }

  async unstream(_symbol) {}

  getState(_symbol) {
    return null;
  }
}

module.exports = { MarketDataProvider };
