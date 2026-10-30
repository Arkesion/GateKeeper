'use strict';

const WINDOW_MS = 15000;

function isBuy(side) {
  const text = String(side || '').toUpperCase();
  return text === 'B' || text === 'BUY';
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function tapeSlowdown(ticks, now, surgeAt, ratio = 0.4) {
  if (!Number.isFinite(now) || !Number.isFinite(surgeAt)) return null;
  if (now - surgeAt < WINDOW_MS) return null;
  const ordered = (ticks || [])
    .filter(tick => tick && Number.isFinite(tick.t) && tick.t >= surgeAt && tick.t <= now)
    .sort((a, b) => a.t - b.t);
  if (!ordered.length) return null;

  let left = 0;
  let buy = 0;
  let peakPrints = 0;
  let peakBuy = 0;
  for (let right = 0; right < ordered.length; right++) {
    if (isBuy(ordered[right].side)) buy += Number(ordered[right].size) || 0;
    const start = Math.max(surgeAt, ordered[right].t - WINDOW_MS);
    while (left <= right && ordered[left].t < start) {
      if (isBuy(ordered[left].side)) buy -= Number(ordered[left].size) || 0;
      left += 1;
    }
    const prints = right - left + 1;
    if (prints > peakPrints) peakPrints = prints;
    if (buy > peakBuy) peakBuy = buy;
  }

  const currentStart = now - WINDOW_MS;
  let currentPrints = 0;
  let currentBuy = 0;
  for (const tick of ordered) {
    if (tick.t < currentStart) continue;
    currentPrints += 1;
    if (isBuy(tick.side)) currentBuy += Number(tick.size) || 0;
  }
  if (!(peakPrints > 0) || !(peakBuy > 0)) return null;
  const printRatio = currentPrints / peakPrints;
  const buyRatio = currentBuy / peakBuy;
  if (!(printRatio < ratio) || !(buyRatio < ratio)) return null;
  const pct = Math.round(printRatio * 100);
  return {
    text: `! Tape at ${pct}% of peak`,
    hover: 'Prints/s and buy volume over the last 15 s vs the surge peak. Measured on Nasdaq prints only.',
    prints_per_s: round3(currentPrints / 15),
    buy_ratio: round3(buyRatio),
    peak_prints_per_s: round3(peakPrints / 15),
    peak_buy_volume: peakBuy,
    pct
  };
}

function tapeLog(reading) {
  return {
    kind: 'tape_slowdown',
    prints_per_s: reading.prints_per_s,
    buy_ratio: reading.buy_ratio,
    peak: reading.peak_prints_per_s
  };
}

module.exports = { tapeSlowdown, tapeLog, isBuy };
