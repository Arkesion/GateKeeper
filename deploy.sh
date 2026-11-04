#!/bin/bash
cd ~/Gatekeeper
git pull

force=0
for arg in "$@"; do
  [ "$arg" = "--force-open-position" ] && force=1
done

if [ "$force" -eq 0 ] && docker exec gatekeeper-redis redis-cli ping >/dev/null 2>&1; then
  raw=$(docker exec gatekeeper-redis redis-cli --raw GET gk:positions 2>/dev/null || true)
  if [ -n "$raw" ] && [ "$raw" != "(nil)" ]; then
    if ! open=$(printf '%s' "$raw" | docker exec -i gatekeeper-webull python -c '
import json, sys
raw = sys.stdin.read().strip()
try:
    rows = json.loads(raw) if raw else []
except json.JSONDecodeError:
    rows = []
names = []
if isinstance(rows, list):
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            shares = float(row.get("shares") or 0)
        except (TypeError, ValueError):
            shares = 0
        if shares > 0:
            symbol = row.get("symbol") or "?"
            shown = int(shares) if shares == int(shares) else shares
            names.append("%s %s shares" % (symbol, shown))
print("; ".join(names))
'); then
      echo "refusing deploy: could not read positions. Re-run with --force-open-position to override." >&2
      exit 1
    fi
    if [ -n "$open" ]; then
      echo "refusing deploy: open position ${open}. Re-run with --force-open-position to override." >&2
      exit 1
    fi
  fi
fi

docker compose up --build -d
echo "✅ GateKeeper deployed"
