# Gatekeeper

A read-only rail for one ticker at a time. It shows whether the seven Gospel checks are aligned, the setup state, and, once a fill arrives, the frozen stop and the day's lockouts. It does not place, modify, or cancel orders.

ChartsWatcher stays the scanner. Tickers are entered by hand.

## Architecture

Three processes, one Redis.

- **webull-sidecar** holds the single Webull session. It builds 1-minute bars from Nasdaq Basic ticks, publishes quotes on `gk:live`, and writes account fills and positions when `WEBULL_ACCOUNT_ID` is set.
- **Redis** is the bus. The sidecar writes bars, quotes, heartbeats, and account keys. The app reads them.
- **gatekeeper** is the Node app. It turns those bars into the rail: indicators, the setup machine, tape slowdown, and the session book.

`MARKET_DATA_PROVIDER` chooses the market-data source: `webull` or `schwab`. Schwab mode polls the Schwab HTTP API instead of the sidecar's tick stream. Fills, positions, session risk, and lockouts come from the Webull account (`WEBULL_ACCOUNT_ID`) either way. Schwab mode still has no Nasdaq prints, so tape slowdown stays `n/a in Schwab mode`.

## Market-data provider

A new provider implements `MarketDataProvider` in `lib/providers/`.

Required:

- `start()`
- `stop()`
- `isDataStale()`
- `stream(symbol)`

Optional, and only called when the method exists:

- `getStreamStatus()`
- `ensureDaily(symbol)`
- `reclaim()`
- `unstream(symbol)`

`backfill` and `getState` are on the base class. Only the Webull provider calls them. Account data is not part of this interface. The header shows the active provider (`LIVE · Webull` or `LIVE · Schwab`). Tape slowdown needs Nasdaq prints, so in Schwab mode that row says `n/a in Schwab mode`.

## Setup

```bash
docker compose up --build -d
```

Copy `.env.example` to `.env` and fill in the values. Do not commit `.env`.

| Variable | Role |
| --- | --- |
| `WEBULL_APP_KEY` | Webull OpenAPI app key |
| `WEBULL_APP_SECRET` | Webull OpenAPI app secret |
| `WEBULL_ACCOUNT_ID` | API account id, not the display number. Unset: the rail says "no account configured" and in-trade stays off |
| `DAILY_MAX_LOSS_R` | Realized-R lock. Default 3 |
| `DAILY_MAX_LOSS_USD` | Dollar lock. Default $0.50. It races the R lock |
| `DEFAULT_R_PER_SHARE` | R used when a closed trade has no log line. Default $0.10. The session row says "R estimated" |
| `MARKET_DATA_PROVIDER` | `webull` or `schwab`. Default in `.env.example` is `schwab` |
| `SCHWAB_CLIENT_ID` | Schwab app key, used when the provider is Schwab |
| `SCHWAB_CLIENT_SECRET` | Schwab app secret |

Corpus sets `NODE_ENV=production`. The dev fill injector stays off unless `GK_INJECT_FILLS=1` and `NODE_ENV` is exactly `development`.

## Deploy

From cetus, push to `main`, then on corpus:

```bash
cd ~/Gatekeeper
bash deploy.sh
```

That pulls and runs `docker compose up --build -d`. Do not edit files on corpus.

## Failure banners

| Banner | Meaning |
| --- | --- |
| WAITING FOR DATA | The symbol is selected and a full state has not arrived |
| DATA STALE | The Webull heartbeat is older than 3 seconds. Last values stay, dimmed |
| GATEKEEPER UNREACHABLE | The browser has not reached the app for 3 seconds |
| STREAM TAKEN BY ANOTHER SESSION | Another client took the one Webull stream. Reclaim is on the overlay |
| DISCONNECTED | The last successful state is older than 60 seconds |
| AUTH FAILED — re-login | Schwab auth failed. Webull mode does not use this path |
| RATE LIMITED — backing off | Schwab returned a rate limit |
| UNKNOWN SYMBOL | The ticker is not a symbol the provider accepts |
| STOP HIT · YOU ARE STILL IN | Last price is under the frozen stop while the position is open |
| DONE FOR THE DAY | Realized loss hit the R cap or the dollar cap, or three losers in a row. Until 4:00 AM ET |
| FILLS OFFLINE | An account is configured, and the order stream is down or the position poll is older than 60 seconds |
| no account configured | `WEBULL_ACCOUNT_ID` is unset |
| ACCOUNT NOT FOUND | The configured id is not in the account list. No other account is used |

ALIGNED and NOT ALIGNED are the verdict, not a lock. A tape caution does not change ALIGNED.
