# Gatekeeper

## Purpose

Real-time front-side health monitor for a single ticker that the trader has already qualified via scanner. Answers one question continuously: "Is this stock in play right now, or should I wait?"

## Architecture

Single-page web app, backend in Node.js (`server.js`), frontend in vanilla HTML/CSS/JS (`public/index.html`). Backend polls Schwab API at 5s (quote) and 15s (candles) intervals, computes signals, caches state per symbol. Frontend polls backend at 5s for signal state and 30s for auth health.

## Signal layers

1. **Front-side health:** 4 binary conditions (9/20 EMA cross on 5m, MACD histogram > 0 on 1m, price > VWAP, higher highs on 5m). Combined into traffic light state (IN_PLAY / CAUTION / BACK_SIDE) with two-poll confirmation to prevent flicker.
2. **Warnings:** 5 effective warnings (topping tail, doji, momentum exhaustion combining body+height shrinking, tape slowdown via volume, lost 20 EMA on 1m). Fire only when triggered. Auto-dismiss after one bar.
3. **Context data:** Price, day change, VWAP delta, RVOL, EMA values, MACD histogram, session indicator, time. Display-only, no judgment.

## Methodology constraints (locked)

- Trader is at 1-share rep-accumulation stage. No "experienced trader" assumptions.
- Pre-market trading is intentional. Pre-market entries are not flagged.
- Above-VWAP trading is intentional. Distance from VWAP is not flagged.
- Candle scheme: green-filled (bullish) / white-filled (bearish) / yellow doji. Frontend matches.
- Gatekeeper does NOT track P&L, consecutive losses, or trade count. Those belong to TradeZella.

## What Gatekeeper is NOT

Not a scanner. Not a setup classifier. Not a buy/sell signal generator. Not a stop/target calculator. Not a trade execution interface. Not a watch list. Not a score/rating. See `gatekeeper-spec.md` for the full anti-scope list.

## Verification

See `TESTING.md` for the manual verification checklist. Run through it after any signal-computation, frontend, or polling change.

## Deployment

Local-first development (`docker compose up` or `node server.js`). After local pass of `TESTING.md`:

1. Commit and push from the dev machine (Cetus/Cursor).
2. On Corpus: `ssh` in and run `~/Gatekeeper/deploy.sh` (git pull + `docker compose up --build -d`).

Never edit application code directly on Corpus — deploy from git so server matches repo.

## File map

- `server.js` — API endpoints, signal computation, token handling, polling
- `public/index.html` — frontend (HTML + CSS + JS in one file)
- `gatekeeper-spec.md` — authoritative spec
- `TESTING.md` — manual verification plan
- `CLAUDE.md` — this file
- `docker-compose.yml`, `Dockerfile`, `deploy.sh` — deployment
- `.env` — Schwab credentials (gitignored)

## Last verified

_Not yet run — update after full TESTING.md pass._
