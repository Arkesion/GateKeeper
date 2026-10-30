'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FORBIDDEN = [
  'place_order',
  'replace_order',
  'cancel_order',
  'place_order_v2',
  'replace_order_v2',
  'place_option',
  'replace_option',
  'cancel_option',
  'PlaceOrderRequest',
  'CancelOrderRequest',
  'ReplaceOrderRequest'
];

function filesUnder(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.venv' || name === '.git') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      filesUnder(full, out);
      continue;
    }
    if (path.resolve(full) === path.resolve(__filename)) continue;
    if (/\.(js|py|html|md|yml)$/.test(name)) out.push(full);
  }
  return out;
}

test('the repo does not reference an order place, modify, or cancel endpoint', () => {
  const root = path.join(__dirname, '..');
  const hits = [];
  for (const file of filesUnder(root, [])) {
    const text = fs.readFileSync(file, 'utf8');
    for (const name of FORBIDDEN) {
      if (text.includes(name)) hits.push(`${path.relative(root, file)}: ${name}`);
    }
  }
  assert.deepEqual(hits, []);
});
