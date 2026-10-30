# Testing Gatekeeper

Automated suites first. The live checks are what to look at on corpus after a deploy.

## Automated

From `Gatekeeper/`:

```bash
node --test
```

59 tests. The suites are:

- `test/brai-bar.test.js` — the BRAI 9:15 bar matches the chart
- `test/golden-indicators.test.js` — VWAP, EMA, and MACD against the BRAI and CHSN fixtures. The printed deltas are the regression lock
- `test/calibration.test.js` — closed-bar calibration scaffold
- `test/session-dst.test.js` — EDT and EST session bounds
- `test/setup-machine.test.js` — surge, pullback, arm, trigger, fail
- `test/tape.test.js` — synthetic Nasdaq prints. No surge does not warn. A new surge leg clears a warning
- `test/tnmg-notes.test.js` — notes, chips, giveback, ladder, and the TNMG session
- `test/trades.test.js` — fills, frozen stop, lockouts, session rebuild, estimated R
- `test/readonly.test.js` — the repo does not name an order place, modify, or cancel endpoint

From `Gatekeeper/sidecar/`:

```bash
py -3 -m unittest test_bars.py test_events.py
```

`test_bars.py` covers tick buckets. `test_events.py` covers account matching, the order-history timestamp, and the grouped fill fixture.

Golden indicator deltas, last run before and after the cleanup:

```
BRAI delta vwap=-0.0040 ema9=0.0150 ema20=0.0056 macd=0.00954 signal=0.00763 hist=0.00191
CHSN delta vwap=-0.0043 ema9=-0.0079 ema20=-0.0070 macd=-0.00128 signal=-0.00297 hist=0.00169
```

Those lines must stay the same. The production VWAP formula is not retuned here.

## Live checks

After `deploy.sh` on corpus, the health probe prints only these four fields:

- `authenticated` true
- `provider` webull
- `stream` streaming
- `rate_limit_status` ok

On the rail, with a symbol loaded:

- The header reads `LIVE · Webull` and a print age
- Seven chips, ALIGNED or NOT ALIGNED, newest notes first
- Setup state matches the last closed bars
- If `WEBULL_ACCOUNT_ID` is unset, the rail says "no account configured" and does not open an in-trade view
- If the account id is set and the stream is connected, FILLS OFFLINE stays hidden and the position poll age on `/api/health` is under 60 seconds

Schwab mode is not the corpus default. If it is selected, the header reads `LIVE · Schwab` and the tape row says `n/a in Schwab mode`. Live fills do not update in that mode.
