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

Four **GO checks** (NO GO if any fail). ALL must be true for "IN PLAY". Higher-highs momentum is separate (see below).

#### Front-side condition 1: 9 EMA > 20 EMA (1-min)

Source: Ross video transcript — front-side framing. The 9/20 EMA cross is the foundational structural indicator of momentum direction.

Logic: Compute 9-period EMA and 20-period EMA on 1-minute candles (completed bars). Compare current values.

```
front_side_emas = ema9_1m > ema20_1m
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

#### GO check 4: No high-volume sell (1-min proxy, 8-bar lookback)

Source: Ross tape — large seller hitting the bid. Gatekeeper uses bearish 1m bar with volume ≥ 2× prior 8-bar average (see Warning 2b). **NO GO** if any such bar exists in the last 8 completed 1m bars.

```
no_hv_sell = NOT high_volume_sell in lookback
```

#### Front-side momentum (separate dot — NOT a GO veto)

Source: Ross — higher highs on the **front side of the move** (preferably parabolic). Consolidation wicks / slight sells do not veto the traffic light.

Logic: Last **5** completed 1m bars (+ forming bar). Count steps where `high > prior high`. Green if **≥ 3** steps (parabolic HH ladder in ~5 minutes).

```
momentum.parabolic_hh = (hh_steps in last ~5m) >= 3
```

This is informational: confirms you are on the front side of a run; absence is not alone a NO GO.

### Two-row traffic light (main banner)

**Row 1** — five binary GO checks (red/green dots): 9/20 EMA, MACD+, above VWAP, no HV sell, spread ≤ $0.10.

```
spread_ok = (askPrice - bidPrice) <= 0.10 on Schwab quote
```

If bid/ask are missing on the quote, `spread_ok` is false (NO ENTRY).

**Row 2** — three setup lights (green/yellow/red): Resistance, Support, Front-side HH (~5m).

```
if any row1 red:     banner = "NO ENTRY" (red)
if row1 all green AND row2 all green: banner = "LOOK FOR SETUP" (green)
if row1 all green AND row2 not all green: banner = "CAUTION" (yellow)
```

Row 2 red (e.g. support broken, resistance reject) does **not** upgrade to NO ENTRY — only row 1 failures do.

Row 2 all green requires: resistance green (`clear`, `broke_through`, or no level above), support green (`near` within $0.10), parabolic HH true.

### Row 2 — Resistance (`key_level_up`, $0.10 bands)

Evaluate in order:

| Light | Phase | Rule |
|-------|-------|------|
| green | `broke_through` | Crossed above in last 5 completed bars and price > level + $0.02 |
| green | `clear` | More than $0.10 below resistance |
| red | `reject` | Testing level and last completed close < level |
| yellow | `testing` | Within $0.10 below and bar high at level |
| yellow | `approach` | $0 < distance ≤ $0.10 below |
| green | `no_resistance_above` | No mapped resistance above price |

### Row 2 — Support (`key_level_down`)

| Light | Phase | Rule |
|-------|-------|------|
| red | `broken` | Price < level − $0.02 or recent cross below |
| yellow | `testing` | Within $0.10 above and bar low at level |
| green | `near` | $0–$0.10 above support |
| yellow | `far` | More than $0.10 above support |
| yellow | `no_support_below` | No mapped support below |

Subtext must name **failures** on row 1 (e.g. "MACD negative") or row 2 reasons on CAUTION (e.g. "Testing · $2.00").

### ACTIVE WARNINGS (binary, only shown when firing)

These appear ONLY when triggered. Silent otherwise. This is the training surface — when something fires, the trader's eye should track to the chart and learn to recognize it.

#### Warning 1: Topping tail on 1-min (bearish column)

Source: Ross video — primary reversal signal (long upper wick).

```
lookback = last 10 completed bars
upper_wick / range > 0.6
topping_tail = all qualifying bars in lookback (ET times comma-separated)
```

Display: "⚠ Topping Tail — 1m bar 10:26, 10:28" (orange, left column)

#### Warning 1b: Bottoming tail on 1-min (bullish column)

Mirror rule — long lower wick, buyers rejecting lows.

```
lower_wick / range > 0.6
bottoming_tail = all qualifying bars in lookback
```

Display: "⚠ Bottoming Tail — 1m bar 10:31, 10:35" (green, right column)

#### Warning 2a: Doji on bullish run (bearish column)

Doji (body/range < 10%) after ≥3 of prior 5 bars were bullish — indecision after an up run.

Display: "⚠ Doji on Bullish Run — 1m bar [times]" (red, left)

#### Warning 2b: Doji on bearish run (bullish column)

Same doji rule after ≥3 of prior 5 bars were bearish — indecision after a down run.

Display: "⚠ Doji on Bearish Run — 1m bar [times]" (green, right)

#### Warning 2b: High volume sell order (1-min proxy)

Source: Ross tape / exit discipline — large seller hitting the bid (no L2 in Gatekeeper; 1m volume proxy).

```
completed_1m = all closed 1m bars
lookback = last 8 completed bars
prior_8_avg(bar) = mean(volume of 8 bars immediately before bar)
bearish = close < open
high_volume_sell_bar = bearish AND volume > 0 AND volume >= prior_8_avg * 2.0
high_volume_sell = any bar in lookback satisfies high_volume_sell_bar
label_bar = most recent qualifying bar in lookback
```

Same 8-bar persistence window (~8 minutes after the bar forms). Not a single T&S print — a full 1m bar with heavy sell volume vs recent 1m pace.

Display: "⚠ High Value Seller at [HH:MM]"

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

#### Warning 5a: Lost 9 EMA on 1-min

Source: Front-side structure — last completed 1m **close** below the 9 EMA (not the 9/20 EMA crossover GO dot).

```
last_completed_1m_close = candles_1m[-2].close
ema9_1m                 = ExpAverage(9) of completed 1m closes
lost_9_ema              = last_completed_1m_close < ema9_1m
```

Display: "⚠ Price below 9 EMA — weak structure"

#### Warning 5b: Lost 20 EMA on 1-min

Same rule on the 20 EMA — price lost the slower support line (back-side onset).

```
lost_20_ema = last_completed_1m_close < ema20_1m
```

Display: "⚠ Price below 20 EMA — weak structure"

Both can fire together if close is below both EMAs.

#### Warning 6: Each candle smaller than prior (alternate momentum exhaustion)

Same as Warning 3 but checking heights rather than bodies — covers the case where wicks are growing but bodies are not.

```
last_3_completed = candles_1m[-4:-1]
height_n         = high - low for bar n
shrinking_height = height_1 > height_2 > height_3 AND all bars bullish
```

Combine with Warning 3 into a single "Momentum exhaustion" warning if either condition fires. Don't fire both separately.

### CONTEXT DATA (passive display, no judgment)

Numbers the trader glances at. Display-only (does not affect traffic light). Values use pass/fail colors for quick scan:

- **Price** — current last price; green $2–$20, yellow $1–$1.99, red otherwise
- **Day change** — `((price - prev_close) / prev_close) * 100`; green if > 10%, else red
- **VWAP delta** — `price - vwap` and `((price - vwap) / vwap) * 100`, formatted as `+$0.XX (+X.X%)` or `-$0.XX (-X.X%)`; green if price above VWAP, red if below
- **VWAP anchor** — text label "PM" if anchored 4:00 AM, "RTH" if 9:30 AM
- **9 EMA value (1m)** — formatted as `$X.XX`; green/red with 20 EMA when 9 > 20 / 9 < 20
- **20 EMA value (1m)** — formatted as `$X.XX`; same pairing as 9 EMA
- **MACD histogram value** — full precision, no rounding; green if > 0, red if ≤ 0
- **Daily RVOL (14d)** — `sum(today's 1m volumes) / mean(prior 14 session daily volumes from Schwab daily bars)`, formatted as `X.Xx`; green if ≥ 5x, else red
- **Time** — current ET time, formatted `HH:MM:SS`
- **Market session** — "PRE" yellow, "RTH" green, "AH" blue, "CLOSED" red

---

## Data layer specification

### Schwab API endpoints used

1. `GET /marketdata/v1/quotes?symbols=X` — current quote
2. `GET /marketdata/v1/pricehistory` with `frequencyType=minute, frequency=1, needExtendedHoursData=true` — 1-min candles (MACD, EMA, VWAP, higher highs, warnings)
3. `GET /marketdata/v1/pricehistory` with `frequencyType=daily` — prior 14 session volumes for daily RVOL (cached ~60s per symbol)

One 1-min history fetch per candle poll covers all signal math.

### Polling cadence

**5-second interval.** No faster.

Math per symbol: quote 12/min + 1m history 4/min ≈ 16 calls/min. Schwab limit: 120 calls/min. Safe margin.

Poll quote every 5s; poll 1m candles every 15s (MACD/EMA/HH update on 1m bar close; forming bar high updates each candle poll).

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
- 1-min candles: at least 35 bars (MACD/EMA); at least 4 completed 1m bars for higher highs
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
- Dot 1: 9 EMA > 20 EMA (1m)
- Dot 2: MACD histogram > 0 (1m)
- Dot 3: Price > VWAP
- Dot 4: Higher highs forming (1m)

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

Small data grid, 2 rows × 4 columns. Pass/fail colors on listed fields (see CONTEXT DATA).

```
PRICE          DAY CHG        VWAP Δ         RVOL
$5.07          +36.66%        +$0.12 (+2.4%) 1.8x

9 EMA (1m)     20 EMA (1m)    MACD HIST      SESSION
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
