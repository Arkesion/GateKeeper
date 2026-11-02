"""Read account events and the position list. This module does not send orders."""

import json
import logging
import threading
import time

LOG = logging.getLogger("gatekeeper.sidecar")
ORDER_LOG = logging.getLogger("gatekeeper.order_events")
_stream_counts = {"n": 0}
_secret_bits = []
RAW_SINK = None

ORDER_EVENT = 1024
POSITION_EVENT = 1028
# SDK 3.0.4 writes subscribeType 7 (1|2|4). Its own comment says 1, 2, and 4 are
# the allowed values, and the trade-events example subscribes for order status.
# 1 is ORDER_STATUS_CHANGED. 7 is not an allowed value, and a stream on 7 can
# ack and then stay silent.
ORDER_SUBSCRIBE_TYPE = 1
# The trade-events docs describe the stream as the OpenAPI order channel.
# Two app orders produced pings and no order event, so health says so.
APP_ORDERS_NOT_PUSHED = "app orders not pushed"
CHANNEL_EVENTS = {
    0: "SubscribeSuccess",
    1: "Ping",
    2: "AuthError",
    3: "NumOfConnExceed",
    4: "SubscribeExpired",
}
FILLED = {"FILLED", "PARTIAL_FILLED", "PARTIALLY_FILLED"}
PLACED = {"NEW", "SUBMITTED", "PENDING", "WORKING", "PENDING_SUBMIT"}


def _num(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:
        return None
    return number


def _first(payload, *keys):
    if not isinstance(payload, dict):
        return None
    for key in keys:
        value = payload.get(key)
        if value not in (None, ""):
            return value
    return None


def _side(value):
    text = str(value or "").upper()
    if text in ("BUY", "B"):
        return "BUY"
    if text in ("SELL", "S"):
        return "SELL"
    return None


def parse_order_event(payload):
    if isinstance(payload, list):
        rows = []
        for item in payload:
            rows.extend(parse_order_event(item))
        return rows
    if not isinstance(payload, dict):
        return []
    inner = payload.get("order") or payload.get("data") or payload
    if isinstance(inner, list):
        return parse_order_event(inner)
    if not isinstance(inner, dict):
        return []
    status = str(_first(inner, "order_status", "orderStatus", "status") or "").upper().replace(" ", "_")
    if status and status not in FILLED:
        return []
    symbol = str(_first(inner, "symbol", "ticker") or "").upper()
    side = _side(_first(inner, "side", "order_side", "orderSide"))
    cumulative = _num(_first(inner, "filled_quantity", "filledQuantity", "filled_qty"))
    average = _num(_first(
        inner, "avg_filled_price", "average_price", "avgFilledPrice", "filled_price", "filledPrice"
    ))
    order_id = str(_first(inner, "client_order_id", "clientOrderId", "order_id", "orderId") or "")
    if not symbol or not side or not order_id or cumulative is None or cumulative <= 0 or average is None:
        return []
    return [{
        "id": f"{order_id}:{cumulative}",
        "order_id": order_id,
        "symbol": symbol,
        "side": side,
        "cumulative": cumulative,
        "average": average,
        "ts": _first(inner, "filled_time", "filledTime", "timestamp"),
    }]


def parse_positions(payload):
    if isinstance(payload, dict):
        rows = payload.get("positions") or payload.get("holdings") or payload.get("data") or []
        if isinstance(rows, dict):
            nested = rows.get("positions") or rows.get("holdings")
            rows = nested if isinstance(nested, list) else [rows]
    elif isinstance(payload, list):
        rows = payload
    else:
        return []
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        symbol = str(_first(row, "symbol", "ticker") or "").upper()
        shares = _num(_first(row, "quantity", "position", "shares", "position_quantity"))
        average = _num(_first(row, "cost_price", "average_price", "avg_price", "costPrice", "averagePrice"))
        if not symbol or shares is None or shares <= 0:
            continue
        out.append({"symbol": symbol, "shares": shares, "average": average})
    return out


def publish_fill(redis_client, fill):
    redis_client.rpush("gk:fills", json.dumps(fill))
    redis_client.ltrim("gk:fills", -200, -1)


def publish_positions(redis_client, rows):
    redis_client.set("gk:positions", json.dumps(rows))


def publish_account(redis_client, status, account_type=None, orders_stream="down"):
    body = {"status": status, "orders_stream": orders_stream}
    if account_type:
        body["type"] = account_type
    redis_client.set("gk:account", json.dumps(body))


def _rows(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    for key in ("accounts", "data", "account_list"):
        rows = payload.get(key)
        if isinstance(rows, list):
            return rows
        if isinstance(rows, dict):
            nested = rows.get("accounts") or rows.get("data") or rows.get("account_list")
            if isinstance(nested, list):
                return nested
    return []


def parse_account_list(payload):
    out = []
    for row in _rows(payload):
        if not isinstance(row, dict):
            continue
        account_id = str(_first(row, "account_id", "accountId") or "")
        display = str(_first(row, "account_number", "accountNumber") or "")
        kind = str(_first(row, "account_type", "accountType") or "").lower()
        if account_id:
            out.append({"account_id": account_id, "display": display, "type": kind})
    return out


def find_account(accounts, account_id):
    wanted = str(account_id or "")
    if not wanted:
        return None
    for row in accounts or []:
        if row.get("account_id") == wanted:
            return row
    return None


def mask_display(number):
    text = str(number or "")
    if len(text) < 4:
        return "****"
    return text[:4] + "****"


def classify_event_log(message):
    text = str(message or "")
    if text.startswith("subscribe success"):
        return None
    if text.startswith("grpc error") or text.startswith("grpc exception"):
        return ("disconnected", _event_reason(text))
    if text.startswith("next retry") or "not be retryable" in text:
        return ("reconnecting", _event_reason(text))
    return None


def _event_reason(text):
    code = _between(text, "code:", ",")
    msg = _between(text, "error msg:", ", details")
    if code or msg:
        return " ".join(part for part in (code, msg) if part)
    if text.startswith("grpc exception:"):
        return text.split(":", 1)[1].strip()[:160]
    delay = _between(text, "started in ", " ms")
    if delay:
        return f"in {delay} ms"
    if "not be retryable" in text:
        return "not retryable"
    return text[:160]


def _between(text, start, end):
    begin = text.find(start)
    if begin < 0:
        return ""
    begin += len(start)
    stop = text.find(end, begin)
    if stop < 0:
        return text[begin:].strip()
    return text[begin:stop].strip()


def _history_rows(payload):
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("orders", "data", "historical_orders", "items"):
        rows = payload.get(key)
        if isinstance(rows, list):
            return [row for row in rows if isinstance(row, dict)]
        if isinstance(rows, dict):
            nested = rows.get("orders") or rows.get("data") or rows.get("items")
            if isinstance(nested, list):
                return [row for row in nested if isinstance(row, dict)]
    return []


def _order_rows(payload):
    out = []
    for row in _history_rows(payload):
        nested = row.get("orders")
        if isinstance(nested, list):
            out.extend(item for item in nested if isinstance(item, dict))
            continue
        out.append(row)
    return out


def _epoch_ms(value):
    if isinstance(value, bool) or value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        number = int(value)
        return number * 1000 if number < 10000000000 else number
    text = str(value).strip()
    if text.isdigit():
        number = int(text)
        return number * 1000 if number < 10000000000 else number
    from datetime import datetime, timezone
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return int(moment.timestamp() * 1000)


def format_et(ms):
    from datetime import datetime
    from zoneinfo import ZoneInfo
    moment = datetime.fromtimestamp(ms / 1000, ZoneInfo("America/New_York"))
    return moment.strftime("%Y-%m-%d %H:%M ET")


def parse_recent_fills(payload):
    out = []
    for row in _order_rows(payload):
        kind = str(_first(row, "instrument_type", "instrumentType") or "EQUITY").upper()
        if kind != "EQUITY":
            continue
        status = str(_first(row, "order_status", "orderStatus", "status") or "").upper().replace(" ", "_")
        if status not in FILLED:
            continue
        symbol = str(_first(row, "symbol", "ticker") or "").upper()
        side = _side(_first(row, "side", "order_side", "orderSide"))
        ts = _epoch_ms(_first(row, "filled_time", "filledTime", "place_time", "create_time", "createTime"))
        shares = _num(_first(row, "filled_quantity", "filledQuantity", "filled_qty", "quantity"))
        price = _num(_first(row, "filled_price", "filledPrice", "avg_filled_price", "average_price"))
        if not symbol or not side or ts is None:
            continue
        order_id = str(_first(row, "client_order_id", "clientOrderId", "order_id", "orderId") or "")
        out.append({
            "symbol": symbol,
            "side": side,
            "ts": ts,
            "shares": shares,
            "price": price,
            "order_id": order_id,
        })
    return out


def day_lots(rows):
    lots = []
    for row in rows or []:
        if not row.get("shares") or row.get("price") is None or row.get("ts") is None:
            continue
        lot = {
            "symbol": row["symbol"],
            "side": row["side"],
            "shares": row["shares"],
            "price": row["price"],
            "ts": row["ts"],
        }
        if row.get("order_id"):
            lot["order_id"] = row["order_id"]
        lots.append(lot)
    return lots


def recent_fill_line(rows):
    if not rows:
        return "recent fill count=0 last=none"
    last = max(rows, key=lambda row: row["ts"])
    return f"recent fill count={len(rows)} last={last['symbol']} {last['side']} {format_et(last['ts'])}"


def _id_key(key):
    text = str(key or "").lower()
    if "token" in text or "account" in text or "signature" in text:
        return True
    return text.endswith("id")


def mask_event(payload):
    if isinstance(payload, list):
        return [mask_event(item) for item in payload]
    if not isinstance(payload, dict):
        return payload
    out = {}
    for key, value in payload.items():
        out[key] = "****" if _id_key(key) else mask_event(value)
    return out


def remember_secret(value):
    text = str(value or "")
    if len(text) >= 8 and text not in _secret_bits:
        _secret_bits.append(text)


def mask_text(text):
    raw = "" if text is None else str(text)
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        parsed = None
    if isinstance(parsed, (dict, list)):
        raw = json.dumps(mask_event(parsed), separators=(",", ":"))
    for bit in _secret_bits:
        raw = raw.replace(bit, "****")
    if len(raw) > 240:
        raw = raw[:240]
    return raw


def enable_order_event_log():
    if ORDER_LOG.handlers:
        return
    ORDER_LOG.setLevel(logging.DEBUG)
    ORDER_LOG.propagate = False
    handler = logging.StreamHandler()
    handler.setLevel(logging.DEBUG)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    ORDER_LOG.addHandler(handler)


def raw_event_line(response):
    kind = int(response.eventType)
    name = CHANNEL_EVENTS.get(kind, str(kind))
    payload = response.payload or ""
    body = ""
    if payload and name != "Ping":
        body = " " + mask_text(payload)
    return (
        f"order event raw type={name} subscribe={int(response.subscribeType)} "
        f"bytes={len(payload)}{body}"
    )


def note_raw_event(response):
    _stream_counts["n"] += 1
    line = raw_event_line(response)
    ORDER_LOG.debug(line)
    sink = RAW_SINK
    if sink:
        sink(line)
    return line


def _payload_keys(payload):
    if isinstance(payload, dict):
        return sorted(str(key) for key in payload.keys())
    if isinstance(payload, list):
        for item in payload:
            if isinstance(item, dict):
                return sorted(str(key) for key in item.keys())
    return []


def _order_body(payload):
    if isinstance(payload, list):
        for item in payload:
            body = _order_body(item)
            if body:
                return body
        return None
    if not isinstance(payload, dict):
        return None
    inner = payload.get("order") or payload.get("data") or payload
    if isinstance(inner, list):
        return _order_body(inner)
    return inner if isinstance(inner, dict) else None


def order_event_line(payload):
    """A non-fill order event, as one log line. Fills return None."""
    body = _order_body(payload)
    if not body:
        return None
    status = str(_first(body, "order_status", "orderStatus", "status") or "").upper().replace(" ", "_")
    symbol = str(_first(body, "symbol", "ticker") or "").upper() or "unknown"
    if not status or status in FILLED:
        return None
    if status in PLACED:
        return f"order event placed {symbol}"
    if "CANCEL" in status:
        return f"order event cancelled {symbol}"
    return f"order event status={status} symbol={symbol}"


def looks_like_buy(payload):
    if isinstance(payload, list):
        return any(looks_like_buy(item) for item in payload)
    if not isinstance(payload, dict):
        return False
    if _side(_first(payload, "side", "order_side", "orderSide")) == "BUY":
        return True
    nested = payload.get("order") or payload.get("orders") or payload.get("data")
    return looks_like_buy(nested)


class QuietTradeEvents:
    """SDK event client without the request print, which includes the signature."""

    def __init__(self, app_key, app_secret):
        from webull.trade.trade_events_client import TradeEventsClient
        self._client = TradeEventsClient(app_key, app_secret, "us")

    def subscribe(self, account_id, on_message, on_connect=None, on_log=None):
        client = self._client
        client.on_events_message = on_message
        if on_connect:
            client.on_connect = on_connect
        if on_log:
            client.on_log = on_log
        client._build_request = _quiet_request.__get__(client, type(client))
        client.do_subscribe = _quiet_subscribe.__get__(client, type(client))
        client.do_subscribe([account_id])


def _quiet_request(self, app_key, app_secret, accounts):
    from webull.core.auth.algorithm import sha_hmac256_new
    from webull.trade.events import events_pb2 as pb
    from webull.trade.events.signature_composer import calc_signature
    request = pb.SubscribeRequest(
        subscribeType=ORDER_SUBSCRIBE_TYPE,
        timestamp=int(time.time() * 1000),
        accounts=accounts,
    )
    _signature, metadata = calc_signature(app_key, app_secret, request, sha_hmac256_new)
    return request, metadata


def _grpc_channel_options():
    return [
        ("grpc.keepalive_time_ms", 30000),
        ("grpc.keepalive_timeout_ms", 10000),
        ("grpc.keepalive_permit_without_calls", 1),
        ("grpc.http2.max_pings_without_data", 0),
    ]


def _quiet_subscribe(self, accounts):
    import grpc
    from webull.trade.events import events_pb2_grpc as pb_grpc
    target = self._host + ":" + str(self._port)
    LOG.info(
        "order events target %s subscribeType=%s tls=%s",
        target, ORDER_SUBSCRIBE_TYPE, int(bool(self._tls_enable)),
    )
    handler = self._easy_handler

    def wrapped(response):
        note_raw_event(response)
        return handler(response)

    self._easy_handler = wrapped
    options = _grpc_channel_options()
    if self._tls_enable:
        channel = grpc.secure_channel(target, grpc.ssl_channel_credentials(), options)
    else:
        channel = grpc.insecure_channel(target, options)
    with channel:
        stub = pb_grpc.EventServiceStub(channel)
        self._stream_processing(stub, accounts)


def make_account_reader(token_dir):
    from webull.core.client import ApiClient
    from webull.trade.trade.v2.account_info_v2 import AccountV2
    from webull_data import credentials
    key, secret, http_host, _mqtt = credentials()
    api = ApiClient(key, secret, "us")
    api.add_endpoint("us", http_host)
    api.set_token_dir(str(token_dir))
    return AccountV2(api)


def read_account_list(reader):
    from webull_data import response_json
    response = reader.get_account_list()
    status = getattr(response, "status_code", None)
    if status is None:
        status = getattr(response, "status", None)
    if status not in (None, 200):
        return None
    return parse_account_list(response_json(response))


def _http_status(response):
    status = getattr(response, "status_code", None)
    if status is None:
        status = getattr(response, "status", None)
    return status


def poll_interval_seconds(moment=None):
    """2s from 04:00 until 20:00 ET, otherwise 10s.

    Production allows 2 calls per 2s on GET /trading/assets/positions/list.
    One call per 2s uses half of that quota. Order history is a separate limit.
    """
    from datetime import datetime
    from zoneinfo import ZoneInfo
    zone = ZoneInfo("America/New_York")
    now = moment or datetime.now(zone)
    if now.tzinfo is None:
        now = now.replace(tzinfo=zone)
    else:
        now = now.astimezone(zone)
    minutes = now.hour * 60 + now.minute
    if 4 * 60 <= minutes < 20 * 60:
        return 2
    return 10


def next_rate_delay(failures, base, cap, retry_after=None):
    """Next wait after one more 429. The header wins when Webull sends one."""
    failures += 1
    step = min(cap, base * (2 ** (failures - 1)))
    if isinstance(retry_after, (int, float)) and retry_after > 0:
        return failures, float(retry_after)
    return failures, step


def _header(response, name):
    headers = getattr(response, "headers", None)
    if not hasattr(headers, "get"):
        return None
    value = headers.get(name)
    if value not in (None, ""):
        return value
    wanted = name.lower()
    try:
        pairs = headers.items()
    except Exception:
        return None
    for key, item in pairs:
        if str(key).lower() == wanted and item not in (None, ""):
            return item
    return None


def retry_after_seconds(response, now=None):
    raw = _header(response, "Retry-After")
    if raw in (None, ""):
        return None
    text = str(raw).strip()
    try:
        value = float(text)
    except (TypeError, ValueError):
        value = None
    if value is not None:
        return value if value > 0 else None
    from datetime import datetime, timezone
    from email.utils import parsedate_to_datetime
    try:
        moment = parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        return None
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    current = now or datetime.now(timezone.utc)
    delta = (moment - current).total_seconds()
    return delta if delta > 0 else None


def _wait_label(delay):
    if abs(delay - round(delay)) < 0.05:
        return str(int(round(delay)))
    return f"{delay:.1f}"


def poll_once(reader, account_id):
    from webull_data import response_json
    response = reader.get_account_position(account_id)
    status = _http_status(response)
    retry_after = retry_after_seconds(response)
    if status not in (None, 200):
        return None, status, retry_after
    return parse_positions(response_json(response)), status or 200, None


def history_bounds(moment):
    from datetime import timedelta
    start = moment - timedelta(days=30)
    stamp = "%Y-%m-%dT%H:%M:%S.000Z"
    return start.strftime(stamp), moment.strftime(stamp)


def read_recent_fills(reader, account_id, now=None):
    from datetime import datetime, timezone
    from webull.trade.request.v3.get_order_history_request_v2 import OrderHistoryRequestV2
    from webull_data import response_json
    moment = now or datetime.now(timezone.utc)
    start, end = history_bounds(moment)
    rows = []
    page_key = None
    status = 200
    for _ in range(5):
        request = OrderHistoryRequestV2()
        request.set_account_id(account_id)
        request.set_start_time(start)
        request.set_end_time(end)
        if page_key:
            request.set_pagination_key(page_key)
        response = reader.client.get_response(request)
        status = _http_status(response)
        retry_after = retry_after_seconds(response)
        if status not in (None, 200):
            return None, status, retry_after
        payload = response_json(response)
        rows.extend(parse_recent_fills(payload))
        page_key = payload.get("pagination_key") if isinstance(payload, dict) else None
        if not page_key:
            break
    return rows, status or 200, None


def run_account(stop_event, redis_client, token_dir, account_id):
    account_id = str(account_id or "").strip()
    remember_secret(account_id)
    enable_order_event_log()
    if not account_id:
        publish_account(redis_client, "unconfigured")
        LOG.info("no account configured")
        return

    reader = None
    matched = None
    while not stop_event.is_set() and matched is None:
        try:
            if reader is None:
                reader = make_account_reader(token_dir)
            accounts = read_account_list(reader)
            if accounts is None:
                stop_event.wait(10)
                continue
            found = find_account(accounts, account_id)
            if not found:
                publish_account(redis_client, "not_found")
                LOG.error("account id not found")
                return
            matched = found
            LOG.info("account %s type %s", mask_display(found.get("display")), found.get("type") or "unknown")
        except Exception as exc:
            LOG.error("account list failed: %s", exc)
            reader = None
            stop_event.wait(10)

    if matched is None or stop_event.is_set() or reader is None:
        return

    watch = {"status": "ok", "orders_stream": "reconnecting"}
    if matched.get("type"):
        watch["type"] = matched.get("type")

    def publish():
        redis_client.set("gk:account", json.dumps(watch))

    publish()
    last_fill_line = {"text": None}

    def history_loop():
        history_reader = None
        failures = 0
        while not stop_event.is_set():
            wait = 60
            try:
                if history_reader is None:
                    history_reader = make_account_reader(token_dir)
                fills, status, retry_after = read_recent_fills(history_reader, account_id)
            except Exception as exc:
                code = getattr(exc, "error_code", None)
                http = getattr(exc, "http_status", None)
                if http or code:
                    LOG.info("recent fills failed: %s %s", http, code)
                else:
                    LOG.info("recent fills failed: %s", type(exc).__name__)
                history_reader = None
                failures = 0
            else:
                if status == 429:
                    failures, wait = next_rate_delay(failures, 60, 300, retry_after)
                    LOG.info("recent fills limited, retry in %ss", _wait_label(wait))
                elif fills is None:
                    LOG.info("recent fills failed: %s", status)
                    failures = 0
                    if status in (401, 403):
                        history_reader = None
                else:
                    failures = 0
                    line = recent_fill_line(fills)
                    if line != last_fill_line["text"]:
                        LOG.info("%s", line)
                        last_fill_line["text"] = line
                    redis_client.set("gk:day_fills", json.dumps(day_lots(fills)))
            if stop_event.wait(wait):
                return

    threading.Thread(target=history_loop, name="order-history", daemon=True).start()

    seen = set()
    shape_logged = {"done": False}
    ignored_logged = {"done": False}

    def on_message(event_type, _subscribe_type, payload, _raw):
        try:
            kind = int(event_type)
        except (TypeError, ValueError):
            return
        if not shape_logged["done"]:
            LOG.info(
                "order event shape type=%s %s",
                kind,
                json.dumps(mask_event(payload), separators=(",", ":")),
            )
            shape_logged["done"] = True
        if kind in (ORDER_EVENT, POSITION_EVENT):
            LOG.info("order events message type=%s", kind)
        if kind == ORDER_EVENT:
            fills = parse_order_event(payload)
            if not fills:
                line = order_event_line(payload)
                if line:
                    LOG.info("%s", line)
                elif not ignored_logged["done"]:
                    LOG.info("order event ignored keys=%s", ",".join(_payload_keys(payload)))
                    ignored_logged["done"] = True
            for fill in fills:
                if fill["id"] in seen:
                    continue
                seen.add(fill["id"])
                publish_fill(redis_client, fill)
        elif kind == POSITION_EVENT:
            publish_positions(redis_client, parse_positions(payload))

    def on_connect(_client, _payload, _response):
        watch["orders_stream"] = APP_ORDERS_NOT_PUSHED
        publish()
        LOG.info("order events connected")
        LOG.info("order events %s", APP_ORDERS_NOT_PUSHED)
        LOG.info("order events keepalive active 30s")

    def on_sdk_log(_level, message):
        classified = classify_event_log(message)
        if not classified:
            return
        kind, reason = classified
        watch["orders_stream"] = "reconnecting"
        publish()
        if kind == "disconnected":
            LOG.info("order events disconnected: %s", reason)
        else:
            LOG.info("order events reconnecting: %s", reason)

    def subscribe():
        from webull_data import credentials
        key, secret, _http, _mqtt = credentials()
        while not stop_event.is_set():
            try:
                QuietTradeEvents(key, secret).subscribe(
                    account_id, on_message, on_connect, on_sdk_log
                )
                reason = "stream ended"
            except Exception as exc:
                reason = type(exc).__name__
            watch["orders_stream"] = "reconnecting"
            publish()
            LOG.info("order events disconnected: %s", reason)
            if stop_event.is_set():
                return
            LOG.info("order events reconnecting: retry")
            stop_event.wait(5)

    def alive_loop():
        while not stop_event.is_set():
            if stop_event.wait(60):
                return
            LOG.info("order events alive, %s messages", _stream_counts["n"])

    threading.Thread(target=subscribe, name="grpc-events", daemon=True).start()
    threading.Thread(target=alive_loop, name="grpc-alive", daemon=True).start()
    poll_failures = 0
    while not stop_event.is_set():
        started = time.monotonic()
        try:
            if reader is None:
                reader = make_account_reader(token_dir)
            rows, status, retry_after = poll_once(reader, account_id)
            if status == 429:
                poll_failures, delay = next_rate_delay(poll_failures, 2, 10, retry_after)
                watch["positions_backoff"] = True
                publish()
                LOG.info("positions poll limited, retry in %ss", _wait_label(delay))
                stop_event.wait(delay)
                continue
            if rows is None:
                LOG.info("positions poll failed: %s", status)
                poll_failures = 0
                if watch.get("positions_backoff"):
                    watch["positions_backoff"] = False
                    publish()
                if status in (401, 403):
                    reader = make_account_reader(token_dir)
            else:
                poll_failures = 0
                watch["positions_backoff"] = False
                watch["positions_poll_at"] = int(time.time() * 1000)
                watch["open_positions"] = len(rows)
                publish()
                publish_positions(redis_client, rows)
                symbols = ",".join(row["symbol"] for row in rows) or "none"
                LOG.info("positions poll %s open %s", len(rows), symbols)
        except Exception as exc:
            LOG.info("positions poll failed: %s", type(exc).__name__)
            reader = None
            poll_failures = 0
            if watch.get("positions_backoff"):
                watch["positions_backoff"] = False
                publish()
        pause = poll_interval_seconds() - (time.monotonic() - started)
        if pause > 0:
            stop_event.wait(pause)


def probe_order_events(seconds=120):
    """Print channel messages for `seconds`, then exit. Does not send orders."""
    global RAW_SINK
    import os
    from webull_data import credentials
    key, secret, _http, _mqtt = credentials()
    account_id = os.environ.get("WEBULL_ACCOUNT_ID", "").strip()
    if not key or not secret or not account_id:
        print("order events probe missing credentials or WEBULL_ACCOUNT_ID", flush=True)
        return 1
    remember_secret(account_id)
    enable_order_event_log()

    def show(line):
        print(line, flush=True)

    RAW_SINK = show

    def on_message(event_type, subscribe_type, payload, _raw):
        text = payload if isinstance(payload, str) else json.dumps(payload)
        print(
            f"order event message type={event_type} subscribe={subscribe_type} {mask_text(text)}",
            flush=True,
        )

    def on_connect(_client, _payload, _response):
        print("order events connected", flush=True)
        print("order events unverified", flush=True)

    def on_log(_level, message):
        classified = classify_event_log(message)
        if not classified:
            return
        kind, reason = classified
        print(f"order events {kind}: {reason}", flush=True)

    def subscribe():
        client = QuietTradeEvents(key, secret)
        inner = client._client
        print(
            f"order events probe host={inner._host} port={inner._port} "
            f"subscribeType={ORDER_SUBSCRIBE_TYPE} seconds={seconds}",
            flush=True,
        )
        client.subscribe(account_id, on_message, on_connect, on_log)

    threading.Thread(target=subscribe, name="order-events-probe", daemon=True).start()
    time.sleep(seconds)
    print(f"order events probe done messages={_stream_counts['n']}", flush=True)
    return 0
