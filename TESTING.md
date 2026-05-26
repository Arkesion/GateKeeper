# Gatekeeper Manual Verification Plan

This file documents the manual test sequence used to verify a Gatekeeper rebuild against TOS as the source of truth. Run through this checklist after any changes to signal computation, frontend, or polling cadence.

## Prerequisites

- Gatekeeper running locally (`docker compose up` or `node server.js`)
- Schwab token valid and refreshed
- TOS open with 1-min and 5-min charts of the test symbol
- 9 EMA cyan, 20 EMA magenta, VWAP orange dashed thick, MACD (12, 26, 9, EXPONENTIAL) on TOS

## Test 1 — MACD histogram match

**Goal:** Verify Prompt 1 fix.

1. Pick a liquid symbol with at least 35 1-min bars (e.g. AAPL during RTH).
2. Note the MACD histogram value on TOS for the most recently closed 1-min bar.
3. Note the `macd_histogram_value` field in Gatekeeper's context grid for the same bar.
4. **Pass criterion:** Values match to within $0.0001.

## Test 2 — Front-side conditions correctness

**Goal:** Verify the four front-side dots reflect the correct chart state.

For each of the four conditions, find a moment where the condition's truth value can be unambiguously read from the chart:

- **9/20 EMA cross (5m):** When the 9 EMA crosses above the 20 EMA on the 5-min chart, the dot flips green. When it crosses below, flips red.
- **MACD (1m):** When the MACD histogram bar on the 1-min chart is above zero, the dot is green; below zero, red.
- **VWAP:** When price is above the orange VWAP line, the dot is green; below, red.
- **Higher highs:** When the current 5-min bar's high exceeds the highest of the prior 4 bars, the dot is green.

**Pass criterion:** All four dots correctly reflect chart state at any chosen moment.

## Test 3 — Warning detection

**Goal:** Verify each warning fires exactly when its source condition is present on the chart.

Identify or wait for each of the following on the 1-min chart, and confirm the corresponding warning appears in Gatekeeper:

- **Topping tail:** A 1-min bar with the upper wick longer than 60% of the bar's total range. Gatekeeper should display "⚠ Topping tail — 1m bar [HH:MM]" within one poll cycle (5s) of bar close.
- **Doji:** A 1-min bar where the body is less than 10% of the bar's range. Gatekeeper shows "⚠ Doji — 1m bar [HH:MM]".
- **Momentum exhaustion:** Three consecutive bullish 1-min bars where bodies (or heights) are shrinking. Gatekeeper shows "⚠ Shrinking candles — momentum exhausting".
- **Tape slowdown:** A 1-min bar with volume less than 50% of the prior 10-bar average. Gatekeeper shows "⚠ Tape slowdown — volume contracting".
- **Lost 20 EMA on 1-min:** A 1-min bar closing below the 20 EMA on the 1-min chart. Gatekeeper shows "⚠ Lost 20 EMA on 1-min — back side forming".

**Pass criterion:** Each warning fires within one poll cycle of the source condition appearing on the chart.

## Test 4 — Traffic light state machine (two-poll confirmation)

**Goal:** Verify Prompt 4 anti-flicker logic.

1. Identify a symbol where conditions are oscillating near a transition boundary (e.g. price hovering at VWAP).
2. Watch the four dots flip between two states for single polls.
3. **Pass criterion:** The main traffic light does NOT flip on single-poll deviations. It only flips after two consecutive polls of the new state. There should be visible single-dot oscillation without the main light changing.

## Test 5 — Continuous 8-hour run

**Goal:** Verify the dealbreaker criterion — no silent freeze.

1. Start Gatekeeper at 4:00 AM ET or earliest convenient pre-market time.
2. Leave it running for at least 8 hours.
3. Periodically check that the time field in the context grid is current (within 10 seconds of system clock).
4. Periodically check that price updates are flowing.
5. **Pass criterion:** No silent freeze, no stale data without overlay, no manual restart required across the 8-hour window. Token refresh occurred at least once without trader intervention.

## Test 6 — Network failure recovery

**Goal:** Verify graceful degradation and recovery.

1. With Gatekeeper running normally, disable network on the host machine.
2. Within 60 seconds, the "DISCONNECTED" overlay appears.
3. Re-enable network.
4. **Pass criterion:** Overlay clears smoothly within one poll cycle of recovery, no manual refresh needed.

## Test 7 — Token expiry recovery

**Goal:** Verify auth refresh works mid-session.

1. Manually edit the token file on disk to set expiry to past time.
2. Wait for the next API call.
3. **Pass criterion:** Token refreshes automatically. No frontend interruption. `/api/health` continues returning `authenticated: true`.

## Test 8 — Methodology constraints

**Goal:** Verify locked methodology decisions are respected.

1. Run Gatekeeper during pre-market (4:00 AM – 9:30 AM ET).
   - **Pass criterion:** No warning fires for "pre-market entry" or similar. Pre-market data displays normally. Session indicator shows "PRE".
2. Trade with price 2%+ above VWAP.
   - **Pass criterion:** VWAP delta displays as context only. No warning about distance from VWAP.
3. Verify no green checkmarks, no buy signals, no setup classifications, no scores, no probabilities, and no sound alerts are present anywhere in the UI.

## When all tests pass

Gatekeeper is shipped. Log the verification date in `CLAUDE.md` and resist any feature additions for at least two weeks of live trading data accumulation.
