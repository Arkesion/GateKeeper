"""Webull market-data HTTP. Does not import or call any order endpoint."""

import json
import logging
import os
import re
import sys
import time
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


def notice_fields(payload):
    items = payload if isinstance(payload, list) else [payload]
    found = []
    for item in items:
        if isinstance(item, dict):
            found.append((str(item.get("type") or ""), str(item.get("content") or "")))
        else:
            found.append((str(getattr(item, "type", "") or ""), str(getattr(item, "content", "") or "")))
    return found


def gatekeeper_stream_check(force):
    """Return an exit code when Gatekeeper already holds the only stream. 0 means continue."""
    import urllib.error
    import urllib.request

    url = os.environ.get("GATEKEEPER_URL", "").strip().rstrip("/")
    if not url:
        print("warning: GATEKEEPER_URL is unset; continuing", flush=True)
        return 0
    try:
        with urllib.request.urlopen(url + "/api/health", timeout=3) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError, TimeoutError):
        print("warning: GATEKEEPER_URL is unreachable; continuing", flush=True)
        return 0
    if body.get("stream") != "streaming":
        return 0
    if not force:
        print(
            "Gatekeeper is streaming. Pass --force to take the stream from Gatekeeper.",
            file=sys.stderr,
        )
        return 2
    print("warning: --force will take the stream from Gatekeeper", flush=True)
    return 0


def make_data_client(token_dir):
    key, secret, http_host, _mqtt = credentials()
    if not key or not secret:
        raise RuntimeError("WEBULL_APP_KEY and WEBULL_APP_SECRET are required")
    api = ApiClient(key, secret, "us")
    api.add_endpoint("us", http_host)
    api.set_token_dir(str(token_dir))
    silence_webull_logs()
    api._stream_logger_set = True
    api._file_logger_set = True
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


def fetch_daily_bars(data_client, symbol, limiter=None):
    """One daily history call. The caller caches it for the rest of the ET day."""
    limiter = limiter or LIMITER
    symbol = symbol.upper()
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - 40 * 24 * 60 * 60 * 1000
    limiter.acquire("bars")
    response = data_client.market_data.get_batch_history_bar(
        [symbol],
        Category.US_STOCK.name,
        Timespan.D.name,
        count="20",
        real_time_required=True,
        trading_sessions=["RTH"],
        start_time=start_ms,
        end_time=end_ms,
    )
    _raise_for_status(response, "daily bars")
    bars = []
    for raw in unwrap_bars(response_json(response)):
        bar = normalize_bar(raw)
        if bar and bar["volume"] > 0:
            bars.append(bar)
    bars.sort(key=lambda bar: bar["datetime"])
    return bars[-20:]


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


_HEADER_KEY = re.compile(r"(x-app-key)([\"'\s:=]+)([^\s\"',}]+)", re.IGNORECASE)
_HEADER_SIG = re.compile(r"(x-signature)([\"'\s:=]+)([^\s\"',}]+)", re.IGNORECASE)


def last4(value):
    text = str(value or "")
    if len(text) <= 4:
        return "****"
    return "***" + text[-4:]


def redact_secrets(text, app_key="", app_secret=""):
    if not text:
        return text

    def key_header(match):
        return match.group(1) + match.group(2) + last4(match.group(3))

    def sig_header(match):
        return match.group(1) + match.group(2) + "***"

    text = _HEADER_SIG.sub(sig_header, text)
    text = _HEADER_KEY.sub(key_header, text)
    secret = str(app_secret or "")
    key = str(app_key or "")
    if len(secret) >= 8 and secret in text:
        text = text.replace(secret, "***")
    if len(key) > 4 and key in text:
        text = text.replace(key, last4(key))
    return text


class SecretRedactFilter(logging.Filter):
    def __init__(self, app_key="", app_secret=""):
        super().__init__()
        self.app_key = app_key or ""
        self.app_secret = app_secret or ""

    def filter(self, record):
        try:
            message = record.getMessage()
        except Exception:
            return True
        redacted = redact_secrets(message, self.app_key, self.app_secret)
        if redacted != message:
            record.msg = redacted
            record.args = ()
        return True


def silence_webull_logs():
    """Keep SDK request dumps off, and mask key and signature if a log line still has them."""
    key, secret, _http, _mqtt = credentials()
    redact = SecretRedactFilter(key, secret)
    for name in ("webull", "webull.core", "webull.data"):
        log = logging.getLogger(name)
        log.setLevel(logging.CRITICAL)
        if not any(isinstance(item, SecretRedactFilter) for item in log.filters):
            log.addFilter(redact)
    root = logging.getLogger()
    if not any(isinstance(item, SecretRedactFilter) for item in root.filters):
        root.addFilter(redact)


def mqtt_client_id(prefix, attempt):
    return f"{prefix}-{os.getpid()}-{attempt}"


def disconnect_reason(rc):
    if rc is None:
        return "none"
    import paho.mqtt.client as mqttc

    return mqttc.error_string(rc)


def connect_failure(exc):
    from webull.data.internal.exceptions import ConnectException, LoopException

    if isinstance(exc, (ConnectException, LoopException)):
        return exc.error_code, exc.error_msg or "unknown"
    return "none", type(exc).__name__


def make_streaming_client(session_id, token_dir):
    from webull.core.retry.retry_policy import NO_RETRY_POLICY
    from webull.data.data_streaming_client import DataStreamingClient

    key, secret, http_host, mqtt_host = credentials()
    client = DataStreamingClient(
        key,
        secret,
        "us",
        session_id,
        http_host=http_host,
        mqtt_host=mqtt_host,
        retry_policy=NO_RETRY_POLICY,
    )
    client.set_token_dir(str(token_dir))
    return client


def retry_subscribe(client, subscribe, is_current, on_error, attempts=4):
    """Subscribe after the connect callback returns so the MQTT loop is reading.

    Retries a few times. If all fail, disconnects so the caller can open a new id.
    on_error receives http status, code, and message only.
    """
    from webull.core.exception.exceptions import ServerException

    delay = 0.5
    for _ in range(attempts):
        if not is_current():
            return False
        time.sleep(delay)
        if not is_current():
            return False
        try:
            subscribe()
            return True
        except ServerException as exc:
            on_error(exc.get_http_status(), exc.get_error_code(), exc.get_error_msg())
        except Exception as exc:
            on_error("none", type(exc).__name__, "")
        delay = min(delay * 2, 8)
    if is_current():
        try:
            client.disconnect()
        except Exception:
            pass
    return False


def reconnect_wait(held, delay, cap=30):
    """Return (seconds to sleep, delay to store). A CONNACK resets the wait to 1s."""
    if held:
        return 1, 1
    return delay, min(delay * 2, cap)
