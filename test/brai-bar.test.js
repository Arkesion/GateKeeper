'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function etParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(ms));
  const get = type => parts.find(part => part.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hm: `${get('hour')}:${get('minute')}`
  };
}

test('BRAI 9:15 ET bar matches the Webull chart', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'brai-2026-10-28.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const bar = fixture.bars.find(row => {
    const et = etParts(row.datetime);
    return et.date === '2026-10-28' && et.hm === '09:15';
  });
  assert.ok(bar, '9:15 ET bar missing from fixture');
  assert.equal(bar.open, 4.93);
  assert.equal(bar.high, 5.2);
  assert.equal(bar.low, 4.93);
  assert.equal(bar.close, 5.11);
  assert.equal(bar.volume, 242726);
});
