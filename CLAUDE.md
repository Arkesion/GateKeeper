
# KQ-GateKeeper

Trading signal panel pulling live data from Schwab API.
Deployed on Corpus (Ubuntu server) via Docker.
Deploy command: ssh into corpus and run ~/Gatekeeper/deploy.sh

## Current Bug
calcMACD() in server.js is returning incorrect histogram values.
The MACD histogram should match TOS (ThinkOrSwim) MACD (12, 26, 9, EXPONENTIAL).
TOS shows: MACD line, signal line, histogram (green number = histogram).
Our histogram is showing NaN or wrong values.

## What We Know
- We fetch 1-min candles for MACD (candles1m)
- MACD = EMA12 - EMA26 of closes
- Signal = 9-period EMA of MACD line values
- Histogram = MACD line - Signal line
- calcEMAFromValues() exists for running EMA on plain number arrays
- The bug is likely in how macdValues array is built or how signal EMA is seeded

## Deploy Workflow
1. Edit on Cetus in Cursor
2. git push
3. On Corpus: ~/Gatekeeper/deploy.sh