# Gatekeeper

Real-time **front-side health monitor** for a single stock symbol. Gatekeeper answers one question continuously: *Is this ticker in play right now, or should I wait?*

It is **not** a scanner, setup classifier, or entry signal. It is a traffic-light panel plus contextual warnings, built for Ross Cameron–style momentum day trading with Schwab market data and ThinkorSwim-aligned math where it matters (VWAP, MACD, EMAs).

---

## Features

### Main banner (3 states)

| State | Meaning |
|--------|---------|
| **NO ENTRY** | Any Row 1 GO check failed |
| **CAUTION** | Row 1 green; setup row (resistance / support / HH) not fully clear |
| **LOOK FOR SETUP** | Row 1 and Row 2 all green |

Row 2 issues (e.g. resistance reject) do **not** force NO ENTRY—only Row 1 failures do.

### Row 1 — five GO checks

- 9 EMA > 20 EMA (1m)
- MACD histogram > 0 (1m, TOS ExpAverage)
- Price above session VWAP (4:00 AM ET anchor, matches TOS DAY)
- No high-volume sell in last 8 minutes
- Bid–ask spread ≤ $0.10

Failed checks show descriptive subtext (e.g. spread amount, high-volume bar time).

### Row 2 — setup row

- **Resistance** — tri-state vs KEY LVL ↑
- **Support** — tri-state vs KEY LVL ↓
- **Front-side HH (~5m)** — parabolic higher-highs ladder (informational; not a GO veto)

### Warnings (two columns)

Timed bar warnings only list times from the **last 8 minutes**.

| Bearish (red) | Bullish (green) |
|---------------|-----------------|
| Topping tail | Bottoming tail |
| Doji on bullish run | Doji on bearish run |
| Momentum exhaustion (bullish run) | Momentum exhaustion (bearish run) |
| Tape slowdown after bullish run | Tape slowdown after bearish run |
| Failed resistance breakout | Resistance breakout |
| Failed support hold | Held support |
| Price below 9 / 20 EMA | Price above 9 / 20 EMA |

High-volume **sell** appears under **NO ENTRY** only (not duplicated in the warning list). **Large buy volume** can appear in the bullish column.

### Context grid

Price, day change, VWAP and delta, RVOL, 9/20 EMA, MACD hist, key levels, session label, halt status. Hover cells for calculation hints.

---

## Stack

- **Node.js** (Express) — `server.js`
- **Vanilla HTML/JS** — `public/index.html`
- **Schwab API** — quotes + 1m/daily price history
- **Docker** — production on corpus (`docker compose`)

---

## Requirements

- Node.js 20+ (Docker image uses Node 24)
- Schwab developer app with OAuth (Market Data production)
- `.env` with API credentials (see below)

---

## Configuration

Create `.env` in the project root (never commit it):

```env
SCHWAB_CLIENT_ID=your_app_key
SCHWAB_CLIENT_SECRET=your_app_secret
PUBLIC_URL=https://your-host.example
REDIRECT_URI=https://your-host.example/callback

# Optional
TOKEN_PATH=/data/tokens.json
CERT_PATH=/path/to/cert.pem
KEY_PATH=/path/to/key.pem
QUOTE_POLL_MS=1000
CANDLE_POLL_MS=2000
```

| Variable | Purpose |
|----------|---------|
| `SCHWAB_CLIENT_ID` / `SCHWAB_CLIENT_SECRET` | OAuth |
| `PUBLIC_URL` | Base URL for OAuth redirect |
| `REDIRECT_URI` | Must match Schwab app settings |
| `TOKEN_PATH` | Persisted tokens (Docker volume recommended) |
| `CERT_PATH` / `KEY_PATH` | HTTPS in production; omit for local HTTP |

---

## Local development

```bash
cd Gatekeeper
npm install
# Create .env from the Configuration section above
node server.js
```

Open `http://localhost:3000`, enter a symbol, and complete Schwab login at `/login` if prompted.

Tokens are stored in `tokens.json` locally (or path from `TOKEN_PATH`).

---

## Docker

```bash
docker compose up --build
```

Default compose maps host **443 → 3000**, mounts TLS certs and a persistent volume for tokens. Adjust `docker-compose.yml` for your environment.

---

## API (summary)

| Endpoint | Description |
|----------|-------------|
| `GET /` | UI |
| `GET /login` | Schwab OAuth |
| `GET /callback` | OAuth redirect |
| `GET /api/state/:symbol` | Full state JSON for symbol |
| `GET /api/health` | Auth, rate limits, poll cadence |
| `GET /api/status` | Session hours / market session |

---

## Deployment (corpus)

From your machine (example):

```bash
scp server.js ark@corpus:~/Gatekeeper/server.js
scp public/index.html ark@corpus:~/Gatekeeper/public/index.html
ssh ark@corpus "cd ~/Gatekeeper && docker compose up --build -d"
```

Or on the server:

```bash
cd ~/Gatekeeper && ./deploy.sh
```

Backend changes are picked up after container restart; the image copies `server.js` and `public/` at build time.

---

## Documentation

| File | Contents |
|------|----------|
| [gatekeeper-spec.md](gatekeeper-spec.md) | Full signal definitions, math, and UI rules |
| [TESTING.md](TESTING.md) | Manual verification checklist vs ThinkorSwim |
| [CLAUDE.md](CLAUDE.md) | Notes for AI-assisted development |

---

## Trading hours

Gatekeeper is intended for extended hours monitoring aligned with the cheatsheet: roughly **4:00 AM – 8:00 PM ET**, with pre-market data included where Schwab provides it.

---

## License

ISC (see `package.json`).
