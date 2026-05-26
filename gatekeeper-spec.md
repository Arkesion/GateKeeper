# Gatekeeper Architecture Specification

**Purpose:** Real-time front-side health monitor for a single ticker that the trader has already qualified via scanner.

**Single question Gatekeeper answers continuously:** *"Is this stock in play right now, or should I wait?"*

**Hand-off intent:** This document is the authoritative spec for rebuilding Gatekeeper. A separate chat will translate this into Cursor prompts. Cursor will write the actual code.

---

## What Gatekeeper Is NOT

These constraints prevent scope drift. Do not implement any of these:

- Not a scanner (Chartswatcher does this)
- Not a setup classifier (no "this is a Bull Flag" detection)
- Not a buy signal generator (no green checkmarks suggesting entry)
- Not a stop/target calculator
- Not a trade execution interface
- Not a watch-list (single ticker only)
- Not a fill-out-form veto tool (no friction inputs during trading)
- Not a score / rating / probability

---

## What Gatekeeper IS

A continuously updating traffic-light panel that surfaces:

1. **Front-side health:** is this stock currently in a tradeable state?
2. **Active warnings:** has a Ross exit signal just fired?
3. **Context data:** raw numbers the trader can glance at without computation

The trader keeps Gatekeeper open on a second screen or window during the session. They look at it for confirmation that conditions remain favorable. When a warning fires, they notice and act per the cheatsheet rules. Over time, the trader's eye learns to spot what Gatekeeper spotted, reducing reliance on the tool — that's the training goal.

---

## Critical methodology context

Gatekeeper enforces rules from the trader's source-grounded cheatsheet. Key locked decisions:

- **Trader is at 1-share rep-accumulation stage.** Do not encode "experienced trader" assumptions.
- **Trades pre-market intentionally** (4:00 AM onward). Pre-market entries are NOT a mistake or warning. Display pre-market data normally.
- **Trades above VWAP intentionally.** "Above 2% VWAP" is NOT a warning or veto. Display VWAP delta as context only, never as veto reason.
- **Candle color scheme:** green-filled (bullish) / white-filled (bearish) / yellow doji. Where Ross's material says "red candle," Gatekeeper logic should reference "bearish candle" or "down candle" generically. Frontend visuals should match the green/white/yellow scheme.
- **Walk-away triggers from cheatsheet (rep-accumulation stage):**
  - 3 consecutive losses
  - "Cannot name the setup" gate (manual self-check, not Gatekeeper's job)
  - $5 daily max loss
  - 11 AM ET soft cutoff (low liquidity warning, not a hard veto)
  - Numeric trade cap returns at 10-share scale-up (not relevant yet)

Gatekeeper does NOT track consecutive losses or daily P&L — those are TradeZella's domain. Gatekeeper only monitors the *current ticker's market state*.

---

## Source-grounded signal definitions

Every signal must trace to Ross Cameron source material. Inline citations included.

### FRONT-SIDE HEALTH (traffic light section)

Four binary conditions. ALL must be true for "front side" state.

#### Front-side condition 1: 9 EMA > 20 EMA (5-min)

Source: Ross video transcript — front-side framing. The 9/20 EMA cross is the foundational structural indicator of momentum direction.

Logic: Compute 9-period EMA and 20-period EMA on 5-minute candles. Compare current values.

```
front_side_emas = ema9_5m > ema20_5m
```

#### Front-side condition 2: MACD histogram positive (1-min)

Source: Ross uses MACD (12, 26, 9) on TOS, references "MACD open" / "MACD positive" in video as front-side confirmation.

Logic: Compute MACD (12, 26, 9, EXPONENTIAL) on 1-minute candles. Check histogram sign.

**Critical: MACD math must match TOS exactly.** The current implementation does not. Correct math below.

```
TOS MACD (12, 26, 9, EXPONENTIAL) algorithm:

1. Sort candles ascending by datetime
2. Extract closes
3. Compute EMA12 of closes (standard EMA, smoothing k = 2/(12+1) = 2/13)
   - Seed: SMA of first 12 closes
   - Then: ema_t = close_t * k + ema_{t-1} * (1-k)
4. Compute EMA26 of closes (standard EMA, k = 2/27)
   - Seed: SMA of first 26 closes
   - Then: as above
5. MACD line at each bar where both EMAs exist: macd_t = ema12_t - ema26_t
6. Signal line = 9-period EMA of MACD line values
   - Seed: SMA of first 9 MACD values (NOT macd[0] — this is the current bug)
   - Then: signal_t = macd_t * (2/10) + signal_{t-1} * (8/10)
7. Histogram = MACD line - Signal line at the current bar

Minimum candles needed: 26 + 9 = 35 1-min bars before MACD is valid.
```

The current bug is at step 6 — code uses `values[0]` as seed instead of SMA of first 9. Fix this and Gatekeeper's MACD will match TOS.

```
front_side_macd = macd_histogram_1m > 0
```

#### Front-side condition 3: Price above VWAP

Source: Ross video and PDFs — VWAP is the line algos defend; above VWAP = bulls in control.

Logic: Compute session VWAP from 4:00 AM ET onward (anchored to extended session start). Compare current price.

```
front_side_vwap = current_price > vwap
```

VWAP anchoring: 4:00 AM ET if pre-market data available, else 9:30 AM ET. Display which anchor was used in context section.

#### Front-side condition 4: Higher highs forming (5-min)

Source: Ross video — "are we making higher highs" as front-side confirmation.

Logic: Look at the last 5 completed 5-min bars. The high of the most recent bar must exceed the highest high of the prior 4 bars OR the current high (from forming bar + last 4 completed bars) exceeds the highest of the 4 before that.

```
recent_4_highs = max(high of last 4 completed 5m bars)
current_high   = high of current forming 5m bar
front_side_hh  = current_high > recent_4_highs
```

Use the forming bar's high too, so the signal updates intra-bar.

### FRONT-SIDE TRAFFIC LIGHT (combined state)

```
all_four_green  = front_side_emas AND front_side_macd AND front_side_vwap AND front_side_hh
two_three_green = (count of true among the four) in [2, 3]
zero_one_green  = (count of true among the four) in [0, 1]

if all_four_green:    state = "IN PLAY"        (green)
if two_three_green:   state = "CAUTION"        (yellow)
if zero_one_green:    state = "BACK SIDE"      (red — walk away)
```

Display the four conditions as small status dots beneath the main traffic light so the trader can see *which* condition is failing.

### ACTIVE WARNINGS (binary, only shown when firing)

These appear ONLY when triggered. Silent otherwise. This is the training surface — when something fires, the trader's eye should track to the chart and learn to recognize it.

#### Warning 1: Topping tail on 1-min

Source: Ross video — primary reversal signal.

```
last_completed_1m_bar = candles_1m[-2]  # not the forming bar; the most recent closed bar
range = high - low
upper_wick = high - max(open, close)
topping_tail = (range > 0) AND (upper_wick / range > 0.6)
```

Display: "⚠ Topping tail — 1-min bar [HH:MM]"

#### Warning 2: Doji on 1-min

Source: Ross video — indecision / reversal signal.

```
last_completed_1m_bar = candles_1m[-2]
range = high - low
body  = abs(close - open)
doji  = (range > 0) AND (body / range < 0.1)
```

Display: "⚠ Doji — 1-min bar [HH:MM]"

#### Warning 3: Shrinking candles (1-min)

Source: Ross video — "candles shrinking" momentum exhaustion signal.

```
last_3_completed = candles_1m[-4:-1]  # three most recent closed bars
body_n     = abs(close - open) for bar n
shrinking  = body_1 > body_2 > body_3 AND all bars are bullish (close > open)
```

Display: "⚠ Shrinking candles — momentum exhausting"

#### Warning 4: Tape slowdown (1-min volume)

Source: Ross PDF — "slowdown in buying on the level 2 and time and sales."

Without L2 access, proxy via volume contraction:

```
last_completed_1m_bar  = candles_1m[-2]
prior_10_avg_volume    = mean(volume of candles_1m[-12:-2])
tape_slowdown          = last_completed_volume < prior_10_avg_volume * 0.5
```

Display: "⚠ Tape slowdown — vol [N] vs avg [M]"

#### Warning 5: Lost 20 EMA on 1-min

Source: Cheatsheet front-side rule — "price holding above 20 EMA on 1-min." Loss of this is back-side onset.

```
last_completed_1m_close = candles_1m[-2].close
ema20_1m                = EMA(20) of 1-min closes
lost_20_ema             = last_completed_1m_close < ema20_1m
```

Display: "⚠ Lost 20 EMA on 1-min — back side forming"

#### Warning 6: Each candle smaller than prior (alternate momentum exhaustion)

Same as Warning 3 but checking heights rather than bodies — covers the case where wicks are growing but bodies are not.

```
last_3_completed = candles_1m[-4:-1]
height_n         = high - low for bar n
shrinking_height = height_1 > height_2 > height_3 AND all bars bullish
```

Combine with Warning 3 into a single "Momentum exhaustion" warning if either condition fires. Don't fire both separately.

### CONTEXT DATA (passive display, no judgment)

Numbers the trader glances at. No green/red coloring on these — just data.

- **Price** — current last price
- **Day change** — `((price - prev_close) / prev_close) * 100`, formatted as `+X.X%`
- **VWAP delta** — `price - vwap` and `((price - vwap) / vwap) * 100`, formatted as `+$0.XX (+X.X%)` or `-$0.XX (-X.X%)`
- **VWAP anchor** — text label "PM" if anchored 4:00 AM, "RTH" if 9:30 AM
- **9 EMA value (5m)** — formatted as `$X.XX`
- **20 EMA value (5m)** — formatted as `$X.XX`
- **MACD histogram value** — formatted as `+0.0XXX` or `-0.0XXX`, used for sanity-check against TOS
- **1-min RVOL** — `current_1m_volume / mean(prior_10_1m_volumes)`, formatted as `X.Xx`
- **Time** — current ET time, formatted `HH:MM:SS`
- **Market session** — text label: "PRE" (4:00–9:30), "RTH" (9:30–16:00), "AH" (16:00–20:00), "CLOSED" otherwise

---

## Data layer specification

### Schwab API endpoints used

1. `GET /marketdata/v1/quotes?symbols=X` — current quote
2. `GET /marketdata/v1/pricehistory` with `frequencyType=minute, frequency=5` — 5-min candles
3. `GET /marketdata/v1/pricehistory` with `frequencyType=minute, frequency=1` — 1-min candles
4. `GET /marketdata/v1/pricehistory` with `frequencyType=minute, frequency=1, needExtendedHoursData=true` — for VWAP (anchored to ETH start)

Note: the 1-min candles for MACD and the 1-min candles for VWAP can share a single fetch if the same time range covers both. Verify with implementer.

### Polling cadence

**5-second interval.** No faster.

Math: 4 endpoints × 12 polls/min = 48 calls/min. Schwab limit: 120 calls/min. Safe margin.

If the implementer wants to be more conservative: poll quote every 5s, but poll candles every 15s (candle data doesn't change between bar closes anyway except for the forming bar). This drops total to 4 + 12 = 16 calls/min.

### Token handling — reliability is the priority

Current code's token flow:
1. Loaded from disk on startup
2. Refreshed when expiry is within 60s of current time
3. Saved to disk after refresh
4. Refresh failures throw → silent UI freeze (THE BUG)

Required improvements:

1. **Wrap every API call in retry-with-refresh logic.** If a call returns 401, force a token refresh and retry once before failing.
2. **If refresh fails, surface state to frontend.** Frontend shows "AUTH FAILED — re-login" banner, not silent freeze.
3. **Handle 429 rate limits gracefully.** On 429, exponential backoff (5s, 10s, 20s, then re-auth check). Surface "RATE LIMITED — backing off" to frontend.
4. **Health endpoint:** `GET /api/health` returns `{ authenticated, last_successful_fetch, rate_limit_status }`. Frontend polls this every 30s as background check.

### Data validation

Before computing signals, validate:
- Quote returned successfully and has `lastPrice`, `closePrice`
- 5-min candles: at least 25 bars (need 20 for EMA20 plus margin)
- 1-min candles: at least 35 bars (need 26 for EMA26 plus 9 for signal)
- VWAP candles: at least 1 bar with positive volume

If any check fails, return `{ status: "insufficient_data", missing: [list] }` to frontend. Frontend displays "WAITING FOR DATA" instead of stale signals.

### Frontend update behavior

The frontend should NEVER show stale data without indicating staleness.

- If most recent successful fetch is > 10s old → show "DATA STALE" overlay
- If most recent successful fetch is > 60s old → show "DISCONNECTED" overlay and red status
- On reconnect, smoothly remove overlay; don't flash refresh

---

## State machine for traffic light

This prevents flicker. Real-time data is noisy; the traffic light shouldn't flip every 5s.

```
state transitions require 2 consecutive polls of the new state

Example:
  Currently "IN PLAY" (all 4 green)
  Next poll: 3 green (CAUTION threshold)
  Action: Do NOT switch yet. Stay "IN PLAY" but show the failing condition as warning dot.
  Next poll: still 3 green
  Action: NOW switch to "CAUTION"

This applies to all three states: IN PLAY ↔ CAUTION ↔ BACK SIDE.
```

Single-poll changes are common during forming bar volatility. Two-poll confirmation eliminates 90% of false flips while remaining responsive (10-second confirmation lag is acceptable for human decision-making).

---

## Frontend visual specification

The trader will keep this open on a secondary screen. Design for **glanceability at distance** — they should be able to read the state from across the room.

### Top: Ticker bar

Large ticker input. Current value: `CODX` style. Click to edit. Auto-uppercase. On change → reset signal state, refetch immediately.

### Middle-top: Traffic light

Single large traffic-light indicator (60-80% of screen width). One of three states:

**IN PLAY** — solid green background, large text "IN PLAY", small "All 4 conditions met"

**CAUTION** — solid yellow/amber background, large text "CAUTION", small "[X/4] conditions met — [failing condition list]"

**BACK SIDE** — solid red background, large text "BACK SIDE", small "Walk away — [failing condition list]"

### Below traffic light: Four condition dots

Horizontal row of 4 status dots (each ~30px circle):
- Dot 1: 9 EMA > 20 EMA (5m)
- Dot 2: MACD histogram > 0 (1m)
- Dot 3: Price > VWAP
- Dot 4: Higher highs forming

Green = passing, red = failing. Hover/tap each dot for the exact value beneath.

### Middle: Active warnings stack

Stack of warning rows that appear when triggered, fade in. Each warning:

```
┌─────────────────────────────────────────────────┐
│ ⚠  Topping tail — 1m bar 10:43                  │
└─────────────────────────────────────────────────┘
```

Warnings persist for the bar they were detected on plus 1 additional bar (so the trader can see them for ~60-90 seconds), then auto-dismiss. Up to 3 warnings stacked at once. If more fire, oldest drops.

### Bottom: Context data grid

Small data grid, 2 rows × 4 columns. No coloring (data only, no judgment):

```
PRICE          DAY CHG        VWAP Δ         RVOL
$5.07          +36.66%        +$0.12 (+2.4%) 1.8x

9 EMA (5m)     20 EMA (5m)    MACD HIST      SESSION
$4.99          $4.82          +0.033         PRE
```

### Frontend tech notes

- The existing implementation uses plain HTML/CSS/JS in `public/index.html` with monospace styling. Keep that aesthetic — it works.
- Color palette: black background, neon green/yellow/red for traffic states, white for ticker, gray for context.
- Font: Courier New or JetBrains Mono if available.
- No frameworks needed (no React, no Vue) — single HTML file is fine and matches current implementation.

---

## What's being removed from current implementation

For the implementer's reference — these are explicit deletions vs the current code:

1. **The Buy column** — delete entirely. Replaced by single traffic light.
2. **The Sell column** — delete entirely. Sell signals are now active warnings (only show when firing, not always).
3. **The Buy/Sell two-column layout** — replaced by traffic light + warning stack + context grid.
4. **"Up 10%+ on day" check** — Gatekeeper doesn't gatekeep on day change anymore. Trader's scanner already qualified this. Display day change as context only.
5. **"Volume dried up" as buy signal** — volume drying is ambiguous (flag consolidation = good, exhaustion = bad). Remove from Gatekeeper. The trader's eye reads this on the chart.
6. **"Pullback ≤ 50%" check** — pattern recognition belongs to the trader, not Gatekeeper.
7. **`shouldPatchQuote` / `applyLiveQuoteToCandles` logic** — only keep this for the VWAP calculation (where the forming bar matters for VWAP accuracy). For EMAs and MACD, use only completed bars to avoid intra-bar oscillation.
8. **500ms polling** — replaced by 5-second polling.

---

## File structure proposal

Same files, refactored:

```
Gatekeeper/
├── server.js          # API endpoints, signal computation, token handling
├── public/
│   └── index.html     # Single-file frontend
├── .env               # Schwab API credentials
├── package.json
├── docker-compose.yml # Existing deployment setup, keep as-is
├── Dockerfile         # Existing, keep as-is
├── deploy.sh          # Existing, keep as-is
└── CLAUDE.md          # Update with new architecture description
```

Server-side modules to consider (within server.js, organized by section):

1. **Auth** — token load/save/refresh/retry (lines 1-90 of current code, but harden the retry logic)
2. **Schwab fetchers** — quote, candles, with retry-on-401 wrapper
3. **Math helpers** — `calcEMA`, `calcEMASMASeed`, `calcMACDExactTOS`, `calcVWAP`
4. **Signal checkers** — `checkFrontSideHealth`, `checkToppingTail`, `checkDoji`, `checkShrinkingCandles`, `checkTapeSlowdown`, `checkLost20EMA`
5. **API endpoints** — `/api/state/:symbol`, `/api/health`, `/api/login`, `/api/callback`
6. **State machine** — server-side cache of last-known traffic-light state per symbol, two-poll confirmation logic

---

## Acceptance criteria

The rebuild is done when:

1. Trader types a ticker, panel updates within 5 seconds with valid signal state OR shows "WAITING FOR DATA"
2. Traffic light correctly reflects 4-condition logic with two-poll confirmation (no flicker)
3. Warnings fire exactly when their source conditions are met (verifiable by hand-checking 1-min bars against TOS)
4. MACD histogram value matches TOS to within $0.0001 (the trader's sanity-check requirement)
5. App runs for 8 hours of pre-market + RTH continuously without "breaking" — i.e., without silent freeze, stale data, or auth failure
6. On token expiry, app auto-refreshes without trader intervention
7. On Schwab rate limit (429), app surfaces backoff state to frontend, retries cleanly
8. On Schwab outage / network failure, app surfaces "DISCONNECTED" state, retries with exponential backoff
9. Trader closes laptop / sleeps PC / reopens — app recovers cleanly, no manual restart needed

Criterion #5 is the dealbreaker. If the rebuild still "breaks after 2 hours," it failed.

---

## Anti-scope notes (do not add)

The implementer will be tempted to add these. Refuse.

- ❌ Multi-symbol watch grid ("I could add 5 columns for 5 tickers")
- ❌ Setup detection ("I could detect when a Bull Flag is forming")
- ❌ Stop / target calculation ("I could draw R levels")
- ❌ Trade entry buttons ("I could let them paper-trade from here")
- ❌ News integration ("I could pull catalyst news")
- ❌ Chart rendering ("I could show candles in the panel")
- ❌ Score / probability ("I could rate the setup 1-100")
- ❌ Trade journaling ("I could log to TradeZella")
- ❌ Sound alerts ("I could beep on warnings")
- ❌ Mobile app version

Each of these has a separate tool that owns it. Gatekeeper does ONE thing.

---

## Hand-off to Cursor

The chat receiving this spec should produce Cursor prompts in this sequence:

1. **Prompt 1: MACD fix** — replace `calcMACD()` with TOS-exact math (SMA seed for both EMA12/EMA26 and signal line). Verify by comparing histogram against TOS on a known symbol.

2. **Prompt 2: Token reliability** — wrap all Schwab API calls in retry-with-refresh logic, add `/api/health` endpoint, handle 429s with backoff.

3. **Prompt 3: New signal layer** — replace Buy/Sell column logic with front-side health (4 conditions) and warnings (6 conditions, only fire when triggered). Use only completed bars except for VWAP.

4. **Prompt 4: State machine** — implement two-poll confirmation for traffic light state transitions.

5. **Prompt 5: Frontend rebuild** — replace `public/index.html` with traffic-light + warnings stack + context grid layout. Preserve aesthetic (monospace, black background, neon accents).

6. **Prompt 6: Polling cadence** — change from 500ms to 5s for quote, 15s for candles.

7. **Prompt 7: Verification** — manual test plan: open Gatekeeper alongside TOS chart for 30 min, verify MACD match, verify warnings fire when chart shows topping tail / doji / shrinking, verify traffic light flips at front-side / back-side transitions.

The other chat should resist combining prompts (each one is a discrete, testable chunk) and should resist any feature additions during this rebuild. After all 7 prompts succeed, Gatekeeper is shipped. Future iterations (additional warnings, refinement) come later.
