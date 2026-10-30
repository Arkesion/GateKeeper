'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tapeSlowdown, tapeLog } = require('../lib/tape');

function burst(start, count, side, size) {
  const ticks = [];
  for (let i = 0; i < count; i++) ticks.push({ t: start + i * 100, size, side });
  return ticks;
}

test('a quiet stretch after a buy burst warns', () => {
  const ticks = burst(0, 10, 'BUY', 10).concat([
    { t: 30000, size: 10, side: 'SELL' },
    { t: 30100, size: 10, side: 'S' }
  ]);
  const reading = tapeSlowdown(ticks, 40000, 0, 0.4);
  assert.equal(reading.text, '! Tape at 20% of peak');
  assert.equal(reading.hover, 'Prints/s and buy volume over the last 15 s vs the surge peak. Measured on Nasdaq prints only.');
  const line = tapeLog(reading);
  assert.equal(line.prints_per_s, reading.prints_per_s);
  assert.equal(line.buy_ratio, 0);
  assert.ok(line.peak > 0);
  assert.equal(JSON.stringify(line).includes('order'), false);
});

test('buy size still at the peak does not warn', () => {
  const ticks = burst(0, 10, 'BUY', 10).concat(burst(30000, 2, 'B', 50));
  assert.equal(tapeSlowdown(ticks, 40000, 0, 0.4), null);
});

test('print rate still at the peak does not warn', () => {
  const ticks = burst(0, 10, 'BUY', 10).concat(burst(30000, 10, 'SELL', 1));
  assert.equal(tapeSlowdown(ticks, 40000, 0, 0.4), null);
});

test('no surge does not warn', () => {
  assert.equal(tapeSlowdown(burst(0, 10, 'BUY', 10), 40000, null, 0.4), null);
});

test('a leg shorter than 15 seconds does not warn', () => {
  assert.equal(tapeSlowdown(burst(0, 10, 'BUY', 10), 10000, 0, 0.4), null);
});

test('a new surge leg clears the warning', () => {
  const old = burst(0, 10, 'BUY', 10).concat([
    { t: 30000, size: 10, side: 'SELL' },
    { t: 30100, size: 10, side: 'SELL' }
  ]);
  assert.ok(tapeSlowdown(old, 40000, 0, 0.4));
  const renewed = old.concat(burst(26000, 10, 'BUY', 20));
  assert.equal(tapeSlowdown(renewed, 40000, 25000, 0.4), null);
});
