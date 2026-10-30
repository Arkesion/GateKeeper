# Gatekeeper v2 Spec

Oct 28, 2026 · @Kevin

## Purpose and principles

Gatekeeper v2 turns Ross Cameron's 5 Pillars and micro-pullback rules into a live checklist, fed by Webull data, so what the app shows matches what Webull charts show.

- **Alignment, not signals.** Green dots mean the rules line up. The chart and tape still decide the entry.
- **Never places, modifies or cancels orders.** Execution stays manual in Webull. Gatekeeper only reads the account.
- **Discipline first.** Risk lockouts (stop breach, daily max loss, three losers) outrank every other feature.
- **One source of truth.** All price, volume and indicator data comes from Webull, so values converge with the charts, pre-market included.
- **Every rule is sourced.** Each check cites the Gospel (Ross's PDFs or transcripts) or is marked MY OWN, matching the journal tag taxonomy.

Scope: the 1–3 tickers being watched, not the whole market. ChartsWatcher stays the scanner of record.

This spec supersedes the v1 `gatekeeper-spec.md` wherever they conflict. All work happens in the `Gatekeeper/` folder; `Gatekeeper - Copy/` and the archived zip are reference only.

## Architecture

Webull is the only source for price, volume, depth, tape and fills; outside APIs supply float, country and news.

&#91;embedded content: Gatekeeper v2 architecture · 3 sources, 1 engine\]

The provider sits behind an interface so Schwab and Webull can run side by side for comparison. Everything runs on corpus; the dashboard is the only browser-facing part.

## Data sources

Webull OpenAPI covers all price, volume, depth, tape and account data. Float, country and news need outside sources.

| Field | Source | Refresh | Notes |
| --- | --- | --- | --- |
| Price, bid/ask, spread | OpenAPI L1 stream (MQTT) | Push | Requires the OpenAPI-specific L1 subscription |
| 1-min bars, PRE + RTH | OpenAPI bars (HTTP) backfill, then built from the stream | Push | Seeds all indicators before the stream attaches |
| % change from close | Computed: last price vs. prior RTH close | Push | Includes pre-market moves |
| Daily volume, 5-min volume | Computed from 1-min bars | Push | Never from ranking payloads (prior-session fields) |
| Daily RVOL | Computed from daily bars + today's bars | Per bar | Definition in Pillar table |
| Level 2 depth | OpenAPI Quotes / L2 stream | Push | Requires L2 subscription |
| Time and sales | OpenAPI Tick / stream | Push | Feeds tape exit warnings; 20-min rolling buffer in memory, HTTP backfill on ticker add |
| Positions, fills, orders | OpenAPI trading: positions + gRPC order events | Push | Read-only use |
| Float | Outside reference-data API | Daily cache | Not in the OpenAPI market-data endpoints |
| Country of origin | Outside reference-data API | Daily cache | Static per ticker |
| News headline + timestamp | Outside news API | Poll per ticker, \~60 s | Not in the OpenAPI market-data endpoints |
| News sentiment | Local Ollama + keyword override | On new headline | Runs on the home server |

Open items to verify before building:

- [ ] OpenAPI L1 tier is consolidated tape, not Nasdaq Basic (compare one candle's volume against the Webull chart)
- [ ] Single-device lock: does the API stream kick the Webull app's real-time data, or the reverse?
- [ ] Official SDK languages; is there a Node SDK, or does a Python sidecar run the stream?
- [ ] Whether OpenAPI exposes a gainers ranking endpoint for auto-populating watch tickers
- [ ] Pick the float/country source and the news source; confirm cost and rate limits
- [ ] Rate limits: 300 HTTP requests per 60 s; confirm the US limit on stream subscribe calls

## Pillar table

The top quarter shows up to 3 tickers, entered by hand from ChartsWatcher, each scored against the 5 Pillars with color bands.

Ross's 5 Pillars: price $2–20, float under 20M, 5× relative volume, up at least 10% on the day, and breaking news.

**Columns, in order:** Ticker · Country · Hours since news · Sentiment · Price · Float · % change from close · Daily volume · 5-min volume · Daily RVOL.

**Color bands.** Purple is best, red is worst. Bands are discrete, not a gradient, so they read at a glance.

| Column | Purple | Green | Yellow | Orange | Red |
| --- | --- | --- | --- | --- | --- |
| Price | $2–10 | $10–15 | $15–20 | $1–2 | Under $1 or over $20 |
| Float | Under 5M | 5–10M | 10–20M | 20–50M | Over 50M |
| % change | Over 50% | 30–50% | 20–30% | 10–20% | Under 10% |
| Daily RVOL | Over 20× | 10–20× | 5–10× | 2–5× | Under 2× |

Thresholds live in one config file so they can be tuned without code changes.

**Hours since news** is colored by sentiment, not by age: green = Good, yellow = Neutral, red = Bad. Opacity fades as hours increase, so a 20-hour-old catalyst reads weaker than a 20-minute-old one. No news in 24 hours shows grey, which fails pillar 5.

**RVOL definition.** Option A: today's cumulative volume ÷ the average daily volume of the prior 10 completed sessions. Today is not part of the average. This understates RVOL early in the day.

**Sentiment pipeline.**

1. Fetch the newest headline per ticker; record its timestamp.
2. Keyword override first. Offering, ATM, registered direct, warrant, reverse split, dilution, shelf, or going-concern = **Bad**, regardless of the model.
3. Otherwise ask local Ollama to classify the headline as Good, Neutral or Bad, with a one-line reason.
4. Cache by headline hash so each headline is classified once.
5. Show the reason on hover, so a wrong label is easy to spot.

## Alignment panel

Below the pillar table, the v1 layout stays: a verdict banner, rule dots, bearish/bullish notes, clock, and key values. v2 adds a setup line driven by a micro-pullback state machine.

**Rule dots.** Each dot is green, amber or red. All green means the rules align; it never means buy.

| Dot | Green when | Source |
| --- | --- | --- |
| 9/20 EMA (1m) | 9 EMA above 20 EMA | v1 |
| MACD (1m) | MACD histogram above 0 | v1, seeding bug fixed |
| VWAP | Price above VWAP | v1 |
| No high-volume sell | No high-volume sell in the last 8 minutes | v1 |
| Spread ≤ 10¢ | Bid/ask spread at or under 10¢ | v1 |
| Resistance | No daily/intraday level within 20¢ above | v1 |
| Support | Pullback low or VWAP within 20¢ below | v1 |
| Front side | Higher highs and higher lows on 1-min | v1 |
| Giveback | Pullback retraced under 50% of the surge leg | v1 |
| Near half/whole dollar | Trigger within 5¢ under a .00 or .50 level | New: Ross criterion 3 |
| Not extended | Price within N× ATR of the 5-min 9 EMA | New: Ross pitfall, chasing |

**Revised 2026-10-29: Gospel vs Context.** Audited against Ross's Micro Pullback PDF, the Technical Analysis Series, and the Warrior pullback-strategy page. This supersedes the table above for what drives the verdict.

| Row | Dot | Source |
| --- | --- | --- |
| Gospel | MACD positive | Histogram above 0 (MACD line above its signal line). Ross's videos, per Kevin; citation to add |
| Gospel | No high-volume sell | Split (2026-10-30): volume and large-candle are two checks. See the Gospel set below |
| Gospel | Resistance | MOVED (2026-10-30): daily-chart resistance is a stock-selection fact (PDF criterion 2), shown with the pillar data, never in the verdict. Intraday pivots and half/whole dollars are ladder levels and Phase 3 break triggers |
| Gospel | Front side | Web page: higher highs and higher lows, early in the breakout |
| Gospel | Giveback | Web page: shallow pullback; pitfall, too deep |
| Gospel | Spread ≤ 10¢ | Web page pitfall: wide spreads; 10¢ is MY OWN |
| Context | VWAP | Session VWAP. Since 4:00 in premarket; since 9:30 in regular hours and after-hours. Value shown only |
| Context | 9/20 EMA | MY OWN; might be useful |
| Context | Support | MY OWN (v1) |

Context dots render grey with values and never affect the verdict. The verdict reads ALIGNED or NOT ALIGNED and lists only failing Gospel checks. Every dot's hover names its source.

**Gospel set (revised 2026-10-30, supersedes the rows above).** Seven alignment checks, all from final bars unless noted:

| Check | Pass label | Fail label | Rule |
| --- | --- | --- | --- |
| MACD | ✓ MACD | ✕ MACD −0.01 | Histogram above 0 (forming bar OK). The chip is the short label; the hover says MACD histogram |
| High-volume sell | ✓ No HV sell | ✕ HV sell 11:10 | Red bar volume above the largest green bar of the run, last 8 min |
| Large sell candle | ✓ No big red | ✕ Big red 11:10 | Red body ≥ 2× the 10-bar median body, last 8 min |
| Topping tail | ✓ No tail | ✕ Tail 09:41 | Spec tail rule; in the last 3 closed bars, cleared early if a later bar closes above the tail's high. The hover says Topping tail |
| Front side | ✓ Front side | ✕ Choppy | Higher highs and higher lows |
| Giveback | ✓ Giveback 30% | ✕ Giveback 60% | Pullback retrace of the leg |
| Spread | ✓ Spread 1¢ | ✕ Spread 14¢ | ≤ 10¢ (MY OWN number) |

High-volume sell, large sell candle and topping tail: Ross's videos, per Kevin; citations to add. Daily-chart resistance shows in the ticker header and on the pillar tab, muted, amber when the nearest prior high is within 10%. Example: `Daily res. 3.54 · +3%`. It does not change ALIGNED.

**Notes rules (revised 2026-10-30).**

- Every note is BEAR, NEUTRAL or BULL, never two at once for the same bar.
- Tape slowdown is NEUTRAL ("consolidation"), not bearish or bullish.
- Price below VWAP is a BEAR note, never a verdict check.
- Topping and bottoming tails need a meaningful bar: wick at least 50% of the bar's range, and the range at least 1.5× the median range of the last 10 bars. A topping tail's high is within 2% of the highest high of the last 15 bars; a bottoming tail's low is within 2% of the lowest low of those bars. A doji is not a tail.
- One line per event, latest occurrence only, newest first.

**Layout (revised 2026-10-30): D · Ladder rail.** One vertical column, about 600 px wide, black theme matching Webull. Top to bottom: pillar tabs (up to 3 tickers), ticker header with price and live status, verdict with seven Gospel chips, an auto-zoomed price ladder, the setup state, and the last 3 events. In trade, the same ladder shows structure levels on the left and entry, stop, 1R–3R on the right, plus an "in your path" callout naming any level between entry and 3R. Each number appears in exactly one place.

**Chips (revised 2026-10-30).** Seven chips, in the Gospel-set order, each on one line. A chip names the state, not the rule. MACD fails as `✕ MACD −0.01`; the hover says MACD histogram. High-volume sell and the large red candle each cite their own bar start. A topping tail passes as `✓ No tail` and fails as `✕ Tail 09:41`; the hover says Topping tail. Front side fails as `✕ Choppy`. Giveback shows the percent and spread shows the cents.

**Intraday pivots (unchanged detector).** A pivot high is a bar whose high is not beaten by any of the 3 bars on the left or the bars on the right. The right side is 3 bars, or fewer at the end of the series, so a fresh high can count before three later bars have printed. Pivot lows use the same window on the lows. An equal neighbor still counts; only a strictly higher high, or a strictly lower low, knocks the swing out. Swings come from today's completed 1-minute bars once at least 7 exist. A separate 48-bar pass builds 5-cent clusters with at least two touches. "Nearest" is a score, not the closest price: candidates beyond `max($0.01, 0.2% of price)` score `touches × 100` plus a half/whole-dollar bonus. Two or more touches beat a single touch. Ties go to the closer price. The most recent swing is always in that pool. The pick is labeled Premarket High, HOD, Whole Dollar, Half Dollar, or Pivot when it sits within `max($0.03, 1.2% of price)` of that kind. It is recomputed on every state refresh. Those rows stay on the ladder. They do not affect ALIGNED.

**Ladder levels.** Price is always its own blue pill. A level within 2¢ of price is not a separate row; its name sits beside the pill (`· 9 EMA`). The 9 EMA line is cyan and the 20 EMA line is magenta. Green and red are only support and resistance. Half- and whole-dollar lines in the zoomed range are faint and labeled `$3.50`. The high-of-day edge marker stays, and the pullback-low marker stays when that low is below the range. VWAP gets an edge marker only when it is outside the range (`VWAP 4.14 · +90¢`). No other new edge markers.

**Event times.** Every note and warning label is the bar's start time in ET. Live bars use the minute of the trade. An HTTP replace keeps that start; it does not move the label by a minute.

**Setup line until Phase 3.** The setup title stays IDLE. Price under the 9 EMA is not its own setup state. The Phase 3 state machine below is not on the ladder yet.

Rows marked v1 are summaries. The v1 code's existing definitions and thresholds are the source of truth; port them exactly and change behavior only where this spec says so (the MACD seeding fix).

**Setup line (Phase 3).** One line under the dots reports the state machine, with the trade math pre-computed before any entry. Until that phase ships, the ladder shows IDLE.

`PULLBACK (2 candles, vol down 38%) → trigger 5.61 · stop 5.40 · R 0.21 · 2R 6.03`

State rules (diagram below):

- **Surge:** consecutive green 1-min bars making new highs, volume above the 20-bar average.
- **Pullback:** 1–3 candles, shallow, volume falling vs. the surge bars.
- **Armed:** trigger = high of the last pullback candle; bumped up to a .00 or .50 level if within 3¢ below it.
- **Triggered:** a candle breaks the trigger on rising volume. Ross enters on the first 1-min candle to break its own high after the pullback.
- **Failed:** more than 3 pullback candles ("that's lunch"), a retrace over 50%, or a close under the 9 EMA. Resets to Idle.

&#91;embedded content: micro-pullback states · 5 forward, 1 fail\]

A failed setup always returns to Idle; only a fresh surge can arm a new trigger.

## In-trade mode

A buy fill on a watched ticker switches Gatekeeper from pre-trade to in-trade mode automatically; the position closing switches it back.

**Fill detection.** Subscribe to Webull order events (gRPC). On a filled BUY, read the average fill price as the entry. Positions are polled at most every 10 s as a fallback.

**Stop and R math.** Stop is the pullback low minus 1¢, capped at 20¢ below entry (MY OWN rule, from watching Ross's stops):

```latex
\text{stop} = \max(\text{pullback\_low} - 0.01,\ \text{entry} - 0.20)
```

```latex
R = \text{entry} - \text{stop}, \qquad nR = \text{entry} + n \times R
```

Worked example, entry $5.60, pullback low $5.37:

| Line | Value | Display |
| --- | --- | --- |
| Entry | $5.60 |  |
| Pullback low − 1¢ | $5.36 | Greyed out: beyond the 20¢ cap |
| Stop | $5.40 | Capped at entry − 0.20 |
| R | $0.20 |  |
| 1R / 2R / 3R | $5.80 / $6.00 / $6.20 |  |

The pullback low comes from the state machine (the lowest low of the pullback candles), not only the previous candle.

**Risk lockouts.** These take over the whole screen and cannot be dismissed until the condition clears.

| Condition | Display | Source |
| --- | --- | --- |
| Last price under stop while position open | Full-screen red: STOP HIT, YOU ARE STILL IN | MY OWN |
| Daily realized loss reaches max loss | DONE FOR THE DAY lock until next session | Ross Rule 2 |
| Three consecutive losing trades | DONE FOR THE DAY lock until next session | Ross Rule 3 |

Max loss is set in config, in dollars and in R. Realized P&L and the losing streak come from the day's Webull fills. Gatekeeper still places no orders: the stop is a real order you set in Webull.

## Exit warnings

In-trade mode adds exit warnings built from Level 2 and the tape. Like the dots, they flag stacking evidence; the exit decision stays yours.

| Warning | Rule | Ross source |
| --- | --- | --- |
| Ask wall | Ask size at one level within 5¢ above price exceeds N× the median ask size | Gap and Go exit 1: heavy L2 resistance |
| Tape slowdown | Trailing 15-s print rate and buy volume fall X% below the surge peak | Gap and Go exit 2: buying slowdown on L2 and T&S |
| First red 5-min | First red 5-min candle after entry | Gap and Go exit 3 |
| Topping tail | 1-min upper wick over 2× body near highs | v1 bearish note |
| Lost 9 EMA | 1-min close under the 9 EMA | v1 bearish note |
| 1R reached | Price touches 1R | MY OWN: Ross sells most into the first target |

N and X start as placeholders. Every warning is logged with its timestamp, ticker and price, so thresholds can be calibrated against journaled trades later.

**Tape buffer.** Each ticker in the pillar table keeps a rolling 20-minute buffer of trades in memory, trimmed by time, plus the live L2 book.

- All 3 pillar tickers stream continuously, so switching the display between them is instant.
- A ticker added to the table backfills its last 20 minutes of trades over HTTP (Tick endpoint), then hands off to the stream. A server restart does the same.
- L2 has no history; the book builds from the moment of subscription.
- Nothing raw is written to disk. When a warning fires, one line of the derived features behind it (prints per second, buy-volume ratio, largest ask vs. median) goes to the signal log.
- On exit from a trade, the buffer from entry to exit is saved to disk for calibration. That's KB to low MB per day, on corpus.

## Testing

Indicator math is tested against values read off Webull's own chart; if Gatekeeper disagrees with the chart, Gatekeeper is wrong.

**Golden fixture: BRAI, 1-min, extended hours, 2026-10-28 at 9:24 ET.**

| Indicator | Webull chart value |
| --- | --- |
| VWAP | 4.697 |
| EMA 9 | 4.880 |
| EMA 20 | 4.871 |
| MACD (12,26,9) line | 0.0356 |
| MACD signal | 0.0630 |
| MACD histogram | −0.0274 |
| 9:15 bar | O 4.93 · H 5.20 · L 4.93 · C 5.11 · V 242,726 |

Tests to write:

- [ ] Save BRAI's 1-min PRE + RTH bars for 2026-10-28 as a JSON fixture
- [ ] Assert VWAP, EMAs and MACD match the table within rounding
- [ ] MACD regression: the signal line is an EMA of the MACD line, seeded only once enough MACD values exist (the v1 bug)
- [x] VWAP anchor: 4:00 before 9:30, then 9:30 through the close. EMAs still carry across the open.
- [ ] Stop math: entry 5.60 / low 5.37 → stop 5.40; entry 5.60 / low 5.48 → stop 5.47
- [ ] State machine: replay fixture bars and assert the expected state sequence
- [ ] Smoke test before every deploy to corpus

**Signal log.** Every dot change, state transition, and warning is written to a log with a timestamp. Joined with journal exports, this lets each rule be scored by outcome later.

## Phase 1 findings

Measured on live data, 2026-10-28 and 29. These override earlier assumptions in this spec.

- **HTTP bars are consolidated.** The BRAI 9:15 bar matched the Webull chart exactly, volume included. Closed bars are final and trustworthy.
- **Live ticks are Nasdaq-only** (Nasdaq Basic). Tick-built OHLC matches HTTP within sub-penny; tick volume runs about 60–70% of consolidated.
- **Forming-bar rule.** Price-based checks may read the forming bar. Volume-based checks (high-volume sell, 5-min volume, tape slowdown, RVOL) read final bars only.
- **One streaming session per account.** A new session takes the stream (notice type 1002). The sidecar never auto-reconnects on 1002; scripts refuse to run while Gatekeeper streams unless forced.
- **Three distinct failure states.** DATA STALE (sidecar heartbeat over 3 s), GATEKEEPER UNREACHABLE (browser can't reach the app for 3 s), STREAM TAKEN. The first two dim the last values with "last update Xs ago"; a quiet ticker is not stale and shows "last print Xs ago".
- **Tick messages carry no sale-condition codes**, but do carry a buy/sell `side` field, which Phase 6 can use for buy-volume ratio.
- **Deployment.** Gatekeeper serves plain HTTP at `corpus:4000`, bound to the Tailscale IP only; a systemd unit waits for Tailscale before starting the container.

## Build phases

Six phases, in order. Phases 1–4 need only Webull; phase 5 waits on outside data sources, so it comes late despite sitting at the top of the screen.

1. **Data layer.** Webull provider behind a `MarketDataProvider` interface: backfill bars, stream L1, build 1-min bars live.
   - Done when: BRAI fixture bars match the Webull chart candle for candle, and the lock test result is documented.
2. **Port v1 dots.** Move the existing rule dots onto the new data with v1 definitions unchanged; fix MACD seeding.
   - Done when: every golden-fixture indicator test passes.
3. **Micro-pullback state machine.** Add the setup line with trigger, stop and R before entry.
   - Done when: fixture replay produces the expected states, and two live sessions show correct states on review.
4. **In-trade mode and lockouts.** Fill detection, stop/R ladder, stop-breach screen, daily max loss and three-loser locks.
   - Done when: a 1-share live trade switches modes automatically, and each lockout fires in a simulated test.
5. **Pillar table.** Float, country and news sources; Ollama sentiment with keyword override; color bands.
   - Done when: 3 tickers populate within 10 s, and the keyword override labels a sample offering headline Bad.
6. **Exit warnings.** L2 ask wall, tape slowdown, and remaining warnings, all logged.
   - Done when: Switching between pillar tickers is instant, a newly added ticker backfills 20 minutes of trades, and warnings fire on a saved per-trade recording and appear in the signal log.

Workflow stays the same: edit on cetus in Cursor, push to GitHub, deploy to corpus with deploy.sh, never edit on corpus.
