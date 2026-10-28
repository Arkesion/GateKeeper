"""Webull market-data HTTP. Does not import or call any order endpoint."""

import json
import os
from pathlib import Path

from webull.core.client import ApiClient
from webull.data.common.category import Category
from webull.data.common.timespan import Timespan
from webull.data.data_client import DataClient

from bars import MINUTE_MS, dedupe_bars, in_sessions, normalize_bar, unwrap_bars
from rate_limit import RateLimiter

LIMITER = RateLimiter()
BAR_COUNT = "1200"


def load_env_file(path=None):
    env_path = Path(path) if path else Path(__file__).resolve().parents[1] / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def host_name(value, default):
    text = (value or default).strip()
    text = text.removeprefix("https://").removeprefix("http://").strip("/")
    return text.split(":")[0]


def credentials():
    load_env_file()
    key = os.environ.get("WEBULL_APP_KEY", "").strip()
    secret = os.environ.get("WEBULL_APP_SECRET", "").strip()
    http_host = host_name(os.environ.get("WEBULL_HTTP_HOST"), "api.webull.com")
    mqtt_host = host_name(os.environ.get("WEBULL_MQTT_HOST"), "data-api.webull.com")
    return key, secret, http_host, mqtt_host


def make_data_client(token_dir):
    key, secret, http_host, _mqtt = credentials()
    if not key or not secret:
        raise RuntimeError("WEBULL_APP_KEY and WEBULL_APP_SECRET are required")
    api = ApiClient(key, secret, "us")
    api.add_endpoint("us", http_host)
    api.set_token_dir(str(token_dir))
    return DataClient(api)


def response_json(response):
    body = getattr(response, "json", None)
    if callable(body):
        return body()
    if isinstance(body, (dict, list)):
        return body
    text = getattr(response, "text", None)
    if isinstance(text, str) and text:
        return json.loads(text)
    raise RuntimeError("response had no JSON body")


def _raise_for_status(response, label):
    status = getattr(response, "status_code", None)
    if status is None:
        status = getattr(response, "status", None)
    if status != 200:
        raise RuntimeError(f"{label} failed status={status}")


def fetch_bars(data_client, symbol, start_ms, end_ms, sessions, limiter=None):
    """Page 1-minute PRE+RTH bars. Count stays inside the HTTP limiter."""
    limiter = limiter or LIMITER
    symbol = symbol.upper()
    wanted = list(sessions or ["PRE", "RTH"])
    collected = []
    cursor_end = int(end_ms)
    seen_earliest = None
    for _ in range(6):
        limiter.acquire("bars")
        response = data_client.market_data.get_batch_history_bar(
            [symbol],
            Category.US_STOCK.name,
            Timespan.M1.name,
            count=BAR_COUNT,
            real_time_required=True,
            trading_sessions=wanted,
            start_time=int(start_ms),
            end_time=cursor_end,
        )
        _raise_for_status(response, "bars")
        raw_rows = unwrap_bars(response_json(response))
        if raw_rows and not normalize_bar(raw_rows[0]):
            raise RuntimeError(
                "bars payload missing OHLC fields: " + ",".join(sorted(raw_rows[0].keys())[:12])
            )
        page = []
        for raw in raw_rows:
            bar = normalize_bar(raw)
            if not bar:
                continue
            if bar["datetime"] < start_ms or bar["datetime"] > end_ms:
                continue
            if not in_sessions(bar["datetime"], wanted):
                continue
            page.append(bar)
        if not page:
            break
        earliest = min(bar["datetime"] for bar in page)
        collected.extend(page)
        if earliest <= start_ms or len(raw_rows) < int(BAR_COUNT):
            break
        if seen_earliest == earliest:
            break
        seen_earliest = earliest
        cursor_end = earliest - 1
    return dedupe_bars(collected)


def fetch_closed_bars(data_client, symbol, end_minute_ms, count=3, sessions=None, limiter=None):
    """Last `count` closed 1-minute bars ending at end_minute_ms. One HTTP call."""
    end_minute_ms = int(end_minute_ms)
    count = int(count)
    start_ms = end_minute_ms - (count - 1) * MINUTE_MS
    bars = fetch_bars(
        data_client,
        symbol,
        start_ms,
        end_minute_ms + MINUTE_MS - 1,
        sessions or ["PRE", "RTH"],
        limiter,
    )
    wanted = {start_ms + index * MINUTE_MS for index in range(count)}
    return [bar for bar in bars if bar["datetime"] in wanted]


def fetch_quote(data_client, symbol, limiter=None):
    """One snapshot so the quote exists before the stream attaches. Not a poll loop."""
    limiter = limiter or LIMITER
    limiter.acquire("snapshot")
    response = data_client.market_data.get_snapshot(
        [symbol.upper()],
        Category.US_STOCK.name,
        extend_hour_required=True,
    )
    _raise_for_status(response, "snapshot")
    payload = response_json(response)
    row = _first_quote_row(payload)
    if not row:
        return None
    price = _num(row.get("price", row.get("last_price", row.get("last"))))
    if price is None:
        price = _num(row.get("ext_price", row.get("p_price")))
    if price is None:
        return None
    return {
        "lastPrice": price,
        "closePrice": _num(row.get("pre_close", row.get("prev_close", row.get("close")))),
        "bidPrice": _num(row.get("bid_price", row.get("bid"))),
        "askPrice": _num(row.get("ask_price", row.get("ask"))),
    }


def _first_quote_row(payload):
    if isinstance(payload, list):
        for item in payload:
            found = _first_quote_row(item)
            if found:
                return found
        return None
    if isinstance(payload, dict):
        if "price" in payload or "last_price" in payload or "ext_price" in payload:
            return payload
        for key in ("data", "result", "list"):
            if key in payload:
                found = _first_quote_row(payload[key])
                if found:
                    return found
    return None


def _num(value):
    if value is None or value == "":
        return None
    return float(value)
