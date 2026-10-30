"""Read account events and the position list. This module does not send orders."""

import json
import logging
import threading
import time

LOG = logging.getLogger("gatekeeper.sidecar")

ORDER_EVENT = 1024
POSITION_EVENT = 1028
FILLED = {"FILLED", "PARTIAL_FILLED", "PARTIALLY_FILLED"}


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


def publish_account(redis_client, status, account_type=None):
    body = {"status": status}
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


class QuietTradeEvents:
    """SDK event client without the request print, which includes the signature."""

    def __init__(self, app_key, app_secret):
        from webull.trade.trade_events_client import TradeEventsClient
        self._client = TradeEventsClient(app_key, app_secret, "us")

    def subscribe(self, account_id, on_message):
        client = self._client
        client.on_events_message = on_message
        client._build_request = _quiet_request.__get__(client, type(client))
        client.do_subscribe = _quiet_subscribe.__get__(client, type(client))
        client.do_subscribe([account_id])


def _quiet_request(self, app_key, app_secret, accounts):
    from webull.core.auth.algorithm import sha_hmac256_new
    from webull.trade.events import events_pb2 as pb
    from webull.trade.events.signature_composer import calc_signature
    request = pb.SubscribeRequest(
        subscribeType=7,
        timestamp=int(time.time() * 1000),
        accounts=accounts,
    )
    _signature, metadata = calc_signature(app_key, app_secret, request, sha_hmac256_new)
    return request, metadata


def _quiet_subscribe(self, accounts):
    import grpc
    from webull.trade.events import events_pb2_grpc as pb_grpc
    target = self._host + ":" + str(self._port)
    if self._tls_enable:
        channel = grpc.secure_channel(target, grpc.ssl_channel_credentials())
    else:
        channel = grpc.insecure_channel(target)
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


def poll_once(reader, account_id):
    from webull_data import response_json
    response = reader.get_account_position(account_id)
    status = getattr(response, "status_code", None)
    if status is None:
        status = getattr(response, "status", None)
    if status not in (None, 200):
        return None
    return parse_positions(response_json(response))


def run_account(stop_event, redis_client, token_dir, account_id):
    account_id = str(account_id or "").strip()
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
            publish_account(redis_client, "ok", found.get("type") or None)
            LOG.info("account %s type %s", mask_display(found.get("display")), found.get("type") or "unknown")
        except Exception as exc:
            LOG.error("account list failed: %s", exc)
            reader = None
            stop_event.wait(10)

    if matched is None or stop_event.is_set():
        return

    seen = set()

    def on_message(event_type, _subscribe_type, payload, _raw):
        try:
            kind = int(event_type)
        except (TypeError, ValueError):
            return
        if kind == ORDER_EVENT:
            for fill in parse_order_event(payload):
                if fill["id"] in seen:
                    continue
                seen.add(fill["id"])
                publish_fill(redis_client, fill)
        elif kind == POSITION_EVENT:
            publish_positions(redis_client, parse_positions(payload))

    def subscribe():
        from webull_data import credentials
        key, secret, _http, _mqtt = credentials()
        while not stop_event.is_set():
            try:
                QuietTradeEvents(key, secret).subscribe(account_id, on_message)
            except Exception as exc:
                LOG.error("account events stopped: %s", exc)
            stop_event.wait(5)

    threading.Thread(target=subscribe, name="grpc-events", daemon=True).start()
    reader = None
    while not stop_event.is_set():
        try:
            if reader is None:
                reader = make_account_reader(token_dir)
            rows = poll_once(reader, account_id)
            if rows is not None:
                publish_positions(redis_client, rows)
        except Exception as exc:
            LOG.error("position poll failed: %s", exc)
            reader = None
        stop_event.wait(10)
