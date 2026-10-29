'use strict';

const test = require('node:test');
const fs = require('fs');
const path = require('path');

/**
 * Closed-bar chart readings. Fill these in from Webull hovers on finished minutes.
 * time is America/New_York, "YYYY-MM-DD HH:mm", and must match a bar already in
 * test/fixtures. Exact-value checks stay a known gap until these are calibrated.
 *
 * { symbol, time, vwap, ema9, ema20, macd, signal, histogram }
 */
const CLOSED_BAR_READINGS = [];

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

function hmMin(hm) {
  const [hour, minute] = hm.split(':').map(Number);
  return hour * 60 + minute;
}

function loadFixtures() {
  const dir = path.join(__dirname, 'fixtures');
  const bySymbol = new Map();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const fixture = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const symbol = String(fixture.symbol || '').toUpperCase();
    if (!symbol || !Array.isArray(fixture.bars)) continue;
    const bars = bySymbol.get(symbol) || [];
    bars.push(...fixture.bars);
    bySymbol.set(symbol, bars);
  }
  for (const [symbol, bars] of bySymbol) {
    const unique = new Map(bars.map(bar => [bar.datetime, bar]));
    bySymbol.set(symbol, [...unique.values()].sort((a, b) => a.datetime - b.datetime));
  }
  return bySymbol;
}

function barsThrough(all, time) {
  const [date, hm] = time.trim().split(/[ T]/);
  const match = all.find(bar => {
    const et = etParts(bar.datetime);
    return et.date === date && et.hm === hm;
  });
  if (!match) return null;
  return all.filter(bar => bar.datetime <= match.datetime);
}

function typical(bar, mode) {
  if (mode === 'close') return bar.close;
  if (mode === 'ohlc4') return (bar.open + bar.high + bar.low + bar.close) / 4;
  return (bar.high + bar.low + bar.close) / 3;
}

function vwapOf(bars, day, anchorMin, mode) {
  let tpv = 0;
  let vol = 0;
  for (const bar of bars) {
    const et = etParts(bar.datetime);
    if (et.date !== day || hmMin(et.hm) < anchorMin) continue;
    const price = typical(bar, mode);
    const volume = Number(bar.volume) || 0;
    if (!Number.isFinite(price) || volume <= 0) continue;
    tpv += price * volume;
    vol += volume;
  }
  return vol > 0 ? tpv / vol : null;
}

function closesFor(bars, day, scope) {
  const min = scope === 'continuous' ? null : hmMin('04:00');
  const chosen = bars.filter(bar => {
    const et = etParts(bar.datetime);
    if (min == null) return true;
    return et.date === day && hmMin(et.hm) >= min;
  });
  return chosen.slice(-800).map(bar => bar.close).filter(Number.isFinite);
}

function emaSeries(values, period, seed) {
  const out = Array(values.length).fill(null);
  const k = 2 / (period + 1);
  if (!values.length) return out;
  if (seed === 'sma') {
    if (values.length < period) return out;
    let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    out[period - 1] = ema;
    for (let i = period; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
      out[i] = ema;
    }
    return out;
  }
  let ema = values[0];
  out[0] = ema;
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function macdAtEnd(closes, seed, signalMode) {
  const ema12 = emaSeries(closes, 12, seed);
  const ema26 = emaSeries(closes, 26, seed);
  const line = closes.map((_, i) => (
    Number.isFinite(ema12[i]) && Number.isFinite(ema26[i]) ? ema12[i] - ema26[i] : null
  ));
  const idxs = [];
  for (let i = 0; i < line.length; i++) {
    if (Number.isFinite(line[i])) idxs.push(i);
  }
  if (!idxs.length) return null;
  const k = 2 / 10;
  let start = 0;
  let signal = line[idxs[0]];
  if (signalMode === 'after9') {
    if (idxs.length < 9) return null;
    start = 8;
    signal = line[idxs[8]];
  } else if (signalMode === 'sma9') {
    if (idxs.length < 9) return null;
    start = 8;
    signal = idxs.slice(0, 9).reduce((sum, i) => sum + line[i], 0) / 9;
  }
  for (let j = start + 1; j < idxs.length; j++) {
    const value = line[idxs[j]];
    signal = value * k + signal * (1 - k);
  }
  const macd = line[idxs[idxs.length - 1]];
  const last = closes.length - 1;
  return {
    ema9: emaSeries(closes, 9, seed)[last],
    ema20: emaSeries(closes, 20, seed)[last],
    macd,
    signal,
    hist: macd - signal
  };
}

function scoreReading(bars, reading) {
  const day = reading.time.trim().split(/[ T]/)[0];
  const ranked = [];
  for (const anchor of ['04:00', '09:30']) {
    for (const priceMode of ['close', 'hlc3', 'ohlc4']) {
      for (const scope of ['session', 'continuous']) {
        for (const seed of ['first', 'sma']) {
          for (const signalMode of ['immediate', 'after9', 'sma9']) {
            const closes = closesFor(bars, day, scope);
            const pack = macdAtEnd(closes, seed, signalMode);
            if (!pack) continue;
            const vwap = vwapOf(bars, day, hmMin(anchor), priceMode);
            const got = { vwap, ...pack };
            const fields = [
              ['vwap', 0.002],
              ['ema9', 0.002],
              ['ema20', 0.002],
              ['macd', 0.0005],
              ['signal', 0.0005],
              ['hist', 0.0005]
            ];
            let worst = 0;
            const deltas = {};
            for (const [key, tol] of fields) {
              const err = Math.abs((got[key] ?? NaN) - reading[key === 'hist' ? 'histogram' : key]);
              deltas[key] = Number.isFinite(got[key]) ? got[key] - reading[key === 'hist' ? 'histogram' : key] : null;
              worst = Math.max(worst, Number.isFinite(err) ? err / tol : 1e9);
            }
            ranked.push({
              worst,
              label: `vwap=${anchor} ${priceMode} scope=${scope} seed=${seed} signal=${signalMode}`,
              deltas
            });
          }
        }
      }
    }
  }
  ranked.sort((a, b) => a.worst - b.worst);
  return ranked;
}

test('closed-bar calibration scaffold', () => {
  if (!CLOSED_BAR_READINGS.length) {
    console.log('calibration: no closed-bar readings yet');
    return;
  }
  const fixtures = loadFixtures();
  for (const reading of CLOSED_BAR_READINGS) {
    const symbol = String(reading.symbol || '').toUpperCase();
    const bars = barsThrough(fixtures.get(symbol) || [], reading.time || '');
    if (!bars) {
      console.log(`calibration skip ${symbol} ${reading.time}: no matching bar`);
      continue;
    }
    const ranked = scoreReading(bars, reading);
    const best = ranked[0];
    console.log(`calibration ${symbol} ${reading.time} best ${best.label} worst=${best.worst.toFixed(2)}`);
    const d = best.deltas;
    console.log(
      `  delta vwap=${fmt(d.vwap)} ema9=${fmt(d.ema9)} ema20=${fmt(d.ema20)} macd=${fmt(d.macd)} signal=${fmt(d.signal)} hist=${fmt(d.hist)}`
    );
  }
});

function fmt(value) {
  return Number.isFinite(value) ? value.toFixed(5) : 'null';
}
