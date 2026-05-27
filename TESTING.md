# Gatekeeper Manual Verification Plan

This file documents the manual test sequence used to verify a Gatekeeper rebuild against TOS as the source of truth. Run through this checklist after any changes to signal computation, frontend, or polling cadence.

## Prerequisites

- Gatekeeper running locally (`docker compose up` or `node server.js`)
- Schwab token valid and refreshed
- TOS open with 1-min and 5-min charts of the test symbol
- 9 EMA cyan, 20 EMA magenta, VWAP orange dashed thick, MACD (12, 26, 9, EXPONENTIAL) on TOS

## Test 1: MACD histogram match

**Goal:** Confirm MACD histogram matches TOS.

1. Pick a liquid symbol with at least 35 1-min bars (e.g. AAPL during RTH).
2. Note the MACD histogram value on TOS for the most recently closed 1-min bar.
3. Note the `macd_histogram_value` field in Gatekeeper's context grid for the same bar.
4. **Pass criterion:** Values match to within $0.0001.

## Test 2: Front-side conditions correctness

**Goal:** Verify the five row-1 GO dots reflect the correct chart state.

For each of the five conditions, find a moment where the condition's truth value can be unambiguously read from the chart:

- **9/20 EMA cross (1m):** When the 9 EMA crosses above the 20 EMA on the 1-min chart, the dot flips green. When it crosses below, flips red.
- **MACD (1m):** When the MACD histogram bar on the 1-min chart is above zero, the dot is green; below zero, red.
- **VWAP:** When price is above the orange VWAP line, the dot is green; below, red.
- **No HV sell:** Green when no bearish 2×-volume sell bar in the last 8 completed 1m bars. Red when a high-volume sell warning would fire.
- **Spread ≤10¢:** Green when Schwab quote ask − bid ≤ $0.10; red when wider or bid/ask missing.
- **Front side (row 2):** Green when buy-side run intact (above 9 EMA, small white candles OK). Red on reversal / backside lower lows, not on a single small white candle after a green run.
- **Giveback (row 2):** After a green chain, compare pullback from chain high to chain range; yellow ~30-50%, red &gt;50%.

**Pass criterion:** All five row-1 dots correctly reflect chart state at any chosen moment.

## Test 2b: Two-row banner and S/R lights

**Goal:** Verify banner rollup and tri-state setup row.

1. **NO ENTRY:** Any row 1 red → red banner, subtext names failing GO check (e.g. `MACD negative`, `Spread > $0.10`).
2. **CAUTION:** Row 1 all green, resistance within 8¢ below KEY LVL ↑ → resistance yellow, banner yellow.
3. **CAUTION (not NO ENTRY):** Wick to resistance, close below → resistance red `Rejected`, banner stays yellow.
4. **Support near:** Price 3-10¢ above KEY LVL ↓ without wick at level → support **green** `Near`. Within 3¢ with low at level → yellow `Testing` only.
5. **Support near (no test):** Support at $4.00, price $4.08 → support green (not testing).
6. **LOOK FOR SETUP:** Row 1 all green + resistance clear/broke + support near + front side green + giveback green → green banner.

## Test 3: Warning detection

**Goal:** Verify each warning fires exactly when its source condition is present on the chart.

Identify or wait for each of the following on the 1-min chart, and confirm the corresponding warning appears in Gatekeeper:

- **Topping tail:** A 1-min bar with the upper wick longer than 60% of the bar's total range. Gatekeeper should display "⚠ Topping tail - 1m bar [HH:MM]" within one poll cycle (5s) of bar close.
- **Doji:** A 1-min bar where the body is less than 10% of the bar's range. Gatekeeper shows "⚠ Doji - 1m bar [HH:MM]".
- **Momentum exhaustion:** Three consecutive bullish 1-min bars where bodies (or heights) are shrinking. Gatekeeper shows "⚠ Shrinking candles - momentum exhausting".
- **Tape slowdown:** A 1-min bar with volume less than 50% of the prior 10-bar average. Gatekeeper shows "⚠ Tape slowdown - volume contracting".
- **Lost 20 EMA on 1-min:** A 1-min bar closing below the 20 EMA on the 1-min chart. Gatekeeper shows "⚠ Lost 20 EMA on 1-min - back side forming".

**Pass criterion:** Each warning fires within one poll cycle of the source condition appearing on the chart.

## Test 4: Traffic light state machine (two-poll confirmation)

**Goal:** Verify two-poll anti-flicker on the main banner.

1. Identify a symbol where conditions are oscillating near a transition boundary (e.g. price hovering at VWAP).
2. Watch the four dots flip between two states for single polls.
3. **Pass criterion:** The main traffic light does NOT flip on single-poll deviations. It only flips after two consecutive polls of the new state. There should be visible single-dot oscillation without the main light changing.

## Test 5: Continuous 8-hour run

**Goal:** Verify the dealbreaker criterion: no silent freeze.

1. Start Gatekeeper at 4:00 AM ET or earliest convenient pre-market time.
2. Leave it running for at least 8 hours.
3. Periodically check that the time field in the context grid is current (within 10 seconds of system clock).
4. Periodically check that price updates are flowing.
5. **Pass criterion:** No silent freeze, no stale data without overlay, no manual restart required across the 8-hour window. Token refresh occurred at least once without trader intervention.

## Test 6: Network failure recovery

**Goal:** Verify graceful degradation and recovery.

1. With Gatekeeper running normally, disable network on the host machine.
2. Within 60 seconds, the "DISCONNECTED" overlay appears.
3. Re-enable network.
4. **Pass criterion:** Overlay clears smoothly within one poll cycle of recovery, no manual refresh needed.

## Test 7: Token expiry recovery

**Goal:** Verify auth refresh works mid-session.

1. Manually edit the token file on disk to set expiry to past time.
2. Wait for the next API call.
3. **Pass criterion:** Token refreshes automatically. No frontend interruption. `/api/health` continues returning `authenticated: true`.

## Test 8: Methodology constraints

**Goal:** Verify locked methodology decisions are respected.

1. Run Gatekeeper during pre-market (4:00 AM to 9:30 AM ET).
   - **Pass criterion:** No warning fires for "pre-market entry" or similar. Pre-market data displays normally. Session indicator shows "PRE".
2. Trade with price 2%+ above VWAP.
   - **Pass criterion:** VWAP delta displays as context only. No warning about distance from VWAP.
3. Verify no green checkmarks, no buy signals, no setup classifications, no scores, no probabilities, and no sound alerts are present anywhere in the UI.

## Production smoke (post-deploy)

Run on the host after `docker compose up --build -d` (rebuild required; `restart` alone does not refresh baked-in source). Adjust port and `-k` if you terminate TLS elsewhere.

```bash
cd /path/to/Gatekeeper
docker compose up --build -d
sleep 8
curl -sS -k https://localhost:443/api/health
curl -sS -k https://localhost:443/api/state/AAPL | head -c 2000
docker compose logs gatekeeper --tail 40
```

From another machine, hit your public URL instead of `localhost` (same paths).

**Pass criteria**

- `/api/health`: `authenticated: true`, `rate_limit_status: ok`
- `/api/state/AAPL`: `status: ok`, `traffic_light_confirmed` present, `front_side` object present
- Response must **not** include: `rvol_daily`, `traffic_light_raw`, `vwap_anchor`, `spread_max_usd`, `time_et`, `last_completed_1m_key`
- Logs: Schwab quote/pricehistory lines, no stack traces
- UI at your deployed URL: banner, row-1 dots, row-2 setup row, context grid, warnings columns load for a liquid symbol

## When all tests pass

Record the verification date and avoid feature churn until you have enough live-session data to judge stability.
