"""Webull market-data sidecar. Publishes bars and L1 quotes to Redis.

Trade prints build provisional 1-minute bars. When a minute closes, the HTTP
bar overwrites that minute. No order placement, modification, or cancellation.
Historical tick backfill and gRPC order events are later phases.
"""

import json
import logging
import os
import signal
import threading
import time
from datetime import datetime, timezone

import redis

from bars import (
    MinuteBarBuilder,
    quote_from_trade,
    session_window,
    snapshot_trade,
    tick_print,
)
from rate_limit import RateLimiter
from webull_data import (
    connect_failure,
    credentials,
    disconnect_reason,
    fetch_bars,
    fetch_closed_bars,
    fetch_quote,
    make_data_client,
    make_streaming_client,
    mqtt_client_id,
    reconnect_wait,
    retry_subscribe,
)

LOG = logging.getLogger("gatekeeper.sidecar")
WATCH_LIMIT = 3
RECONCILE_DELAYS = (2, 3)


class Sidecar:
    def __init__(self):
        self.limiter = RateLimiter()
        self.redis = None
        self.data = None
        self.stream = None
        self.connected = threading.Event()
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.order = []
        self.builders = {}
        self.quotes = {}
        self.subscribed = set()
        self.logged_sessions = set()
        self.taken = threading.Event()

    def run(self):
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(message)s",
        )
        logging.getLogger("webull").setLevel(logging.CRITICAL)
        key, _secret, http_host, mqtt_host = credentials()
        redis_url = os.environ.get("REDIS_URL", "redis://redis:6379")
        self.redis = redis.Redis.from_url(redis_url, decode_responses=True)
        self.redis.ping()
        if not key:
            LOG.error("WEBULL_APP_KEY and WEBULL_APP_SECRET are required; sidecar idle")
            while not self.stop.wait(3600):
                pass
            return

        token_dir = os.environ.get("WEBULL_TOKEN_DIR", "/tmp/webull-tokens")
        os.makedirs(token_dir, exist_ok=True)
        self.token_dir = token_dir
        self.data = make_data_client(token_dir)
        threading.Thread(target=self._mqtt_loop, name="mqtt", daemon=True).start()
        threading.Thread(target=self._heartbeat, name="heartbeat", daemon=True).start()
        LOG.info("sidecar ready http=%s mqtt=%s", http_host, mqtt_host)
        self._commands()

    def _mqtt_loop(self):
        attempt = 0
        delay = 1
        while not self.stop.is_set():
            attempt += 1
            session_id = mqtt_client_id("gk-sidecar", attempt)
            previous = self.stream
            if previous is not None:
                try:
                    previous.disconnect()
                except Exception:
                    pass
                if self.stream is previous:
                    self.stream = None
            held = {"ok": False}
            client = make_streaming_client(session_id, self.token_dir)

            def on_connect(stream, api_client, connected_session, _held=held):
                _held["ok"] = True
                self._on_connect(stream, api_client, connected_session)

            def on_disconnect(stream, userdata, *args):
                self._on_disconnect(stream, userdata, *args)

            client.on_connect_success = on_connect
            client.on_quotes_message = self._on_message
            client.on_disconnect = on_disconnect
            self.stream = client
            try:
                client.connect_and_loop_forever(timeout=1, logger_enable=False)
            except Exception as exc:
                rc, reason = connect_failure(exc)
                LOG.warning("connect rc=%s reason=%s client_id=%s", rc, reason, session_id)
            finally:
                self.connected.clear()
                try:
                    client.disconnect()
                except Exception:
                    pass
                if self.stream is client:
                    self.stream = None
            if self.stop.is_set():
                return
            if self.taken.is_set():
                while self.taken.is_set():
                    if self.stop.wait(0.5):
                        return
                continue
            sleep_for, delay = reconnect_wait(held["ok"], delay)
            if self.stop.wait(sleep_for):
                return

    def _on_connect(self, client, api_client, session_id):
        self.connected.set()
        self._set_stream_status("streaming")
        LOG.info("connect rc=0 reason=Connection successful client_id=%s", session_id)

        def is_current():
            return self.stream is client and not self.stop.is_set()

        def subscribe_all():
            with self.lock:
                symbols = [symbol for symbol in self.order if symbol not in self.subscribed]
            if not symbols:
                return
            failed = None
            for symbol in symbols:
                if not is_current():
                    return
                try:
                    self._subscribe(symbol)
                except Exception as exc:
                    failed = exc
                    self._log_subscribe_error(symbol, exc, session_id)
            if failed is not None:
                raise failed

        threading.Thread(
            target=retry_subscribe,
            args=(client, subscribe_all, is_current, lambda *_args: None),
            name="resubscribe",
            daemon=True,
        ).start()

    def _log_subscribe_error(self, symbol, exc, session_id):
        from webull.core.exception.exceptions import ServerException

        if isinstance(exc, ServerException):
            LOG.error(
                "subscribe %s http=%s code=%s msg=%s client_id=%s",
                symbol,
                exc.get_http_status(),
                exc.get_error_code(),
                exc.get_error_msg(),
                session_id,
            )
            return
        LOG.error("subscribe %s failed %s client_id=%s", symbol, type(exc).__name__, session_id)

    def _on_disconnect(self, client, userdata, *args):
        self.connected.clear()
        with self.lock:
            self.subscribed.clear()
        rc = args[0] if args else None
        session_id = client.get_session_id() if hasattr(client, "get_session_id") else None
        LOG.warning(
            "disconnect rc=%s reason=%s client_id=%s",
            rc,
            disconnect_reason(rc),
            session_id,
        )

    def _set_stream_status(self, value):
        try:
            self.redis.set("gk:stream", value)
        except Exception as exc:
            LOG.error("stream status failed: %s", type(exc).__name__)

    def _on_notice(self, client, payload):
        from webull_data import notice_fields

        for kind, content in notice_fields(payload):
            if kind != "1002":
                continue
            LOG.warning(
                "%s notice type=1002 content=%s",
                datetime.now(timezone.utc).isoformat(),
                content,
            )
            self.taken.set()
            self._set_stream_status("stream_taken")
            try:
                client.disconnect()
            except Exception:
                pass

    def _on_message(self, client, topic, payload):
        try:
            self._handle_message(client, topic, payload)
        except Exception as exc:
            LOG.error("message error %s", type(exc).__name__)

    def _handle_message(self, client, topic, payload):
        items = payload if isinstance(payload, list) else [payload]
        if topic == "notice":
            self._on_notice(client, payload)
            return
        if topic == "tick":
            for tick in items:
                self._on_tick(tick)
            return
        if topic == "snapshot":
            for snap in items:
                self._on_snapshot(snap)

    def _on_tick(self, tick):
        symbol, price, size, trade_ms, bucket, session = tick_print(tick)
        if session and session not in self.logged_sessions:
            self.logged_sessions.add(str(session))
            LOG.info("tick session label=%s", session)
        if not symbol or price is None:
            return
        with self.lock:
            builder = self.builders.get(symbol)
            if builder is None:
                return
            closed = builder.on_print(price, size, trade_ms, bucket)
            prev = self.quotes.get(symbol) or {}
            quote = quote_from_trade(
                price,
                prev.get("closePrice"),
                prev.get("bidPrice"),
                prev.get("askPrice"),
            )
            self.quotes[symbol] = quote
            forming = dict(builder.forming) if builder.forming else None
            rows = builder.rows() if closed is not None else None
            provisional = dict(closed) if closed is not None else None
        self._publish_live(symbol, quote, forming, closed, rows)
        if provisional is not None:
            threading.Thread(
                target=self._reconcile,
                args=(symbol, provisional["datetime"]),
                name=f"reconcile-{symbol}",
                daemon=True,
            ).start()

    def _on_snapshot(self, snap):
        price, _cum, _trade_ms, pre_close, _bucket, session = snapshot_trade(snap)
        symbol = getattr(getattr(snap, "basic", None), "symbol", None)
        if symbol:
            symbol = symbol.upper()
        if session and session not in self.logged_sessions:
            self.logged_sessions.add(session)
            LOG.info("snapshot session label=%s", session)
        if not symbol:
            return
        with self.lock:
            if symbol not in self.builders:
                return
            prev = self.quotes.get(symbol) or {}
            last = prev.get("lastPrice")
            if last is None:
                last = price
            if pre_close is None:
                pre_close = prev.get("closePrice")
            quote = quote_from_trade(
                last,
                pre_close,
                prev.get("bidPrice"),
                prev.get("askPrice"),
            )
            self.quotes[symbol] = quote
        self.redis.set(f"gk:quote:{symbol}", json.dumps(quote))
        self.redis.publish(
            f"gk:live:{symbol}",
            json.dumps({"quote": quote, "forming": None, "closed": None}),
        )

    def _publish_live(self, symbol, quote, forming, closed, rows):
        self.redis.set(f"gk:quote:{symbol}", json.dumps(quote))
        if rows is not None:
            self.redis.set(f"gk:bars:{symbol}", json.dumps(rows))
        self.redis.publish(
            f"gk:live:{symbol}",
            json.dumps({"quote": quote, "forming": forming, "closed": closed}),
        )

    def _reconcile(self, symbol, minute_ms):
        """Refetch the last 3 closed bars in one call. Retry once if the newest is missing."""
        official = []
        for delay in RECONCILE_DELAYS:
            if self.stop.wait(delay):
                return
            try:
                official = fetch_closed_bars(self.data, symbol, minute_ms, limiter=self.limiter)
            except Exception as exc:
                LOG.warning("reconcile %s %s failed: %s", symbol, minute_ms, exc)
                official = []
            if any(bar["datetime"] == minute_ms for bar in official):
                break
        if not any(bar["datetime"] == minute_ms for bar in official):
            LOG.warning("reconcile %s %s: newest HTTP bar missing", symbol, minute_ms)
        if not official:
            return
        with self.lock:
            builder = self.builders.get(symbol)
            if builder is None:
                return
            changed = builder.upsert_official(official)
            if not changed:
                return
            rows = builder.rows()
            quote = self.quotes.get(symbol)
            forming = dict(builder.forming) if builder.forming else None
        self.redis.set(f"gk:bars:{symbol}", json.dumps(rows))
        self.redis.publish(
            f"gk:live:{symbol}",
            json.dumps({"quote": quote, "forming": forming, "closed": None, "updates": changed}),
        )
        LOG.info("reconciled %s minutes=%s", symbol, [bar["datetime"] for bar in changed])

    def _heartbeat(self):
        while not self.stop.is_set():
            stamp = datetime.now(timezone.utc).isoformat()
            try:
                self.redis.set("gk:heartbeat", stamp)
                self.redis.publish("gk:heartbeat", stamp)
            except Exception as exc:
                LOG.error("heartbeat failed: %s", exc)
            self.stop.wait(1)

    def _commands(self):
        while not self.stop.is_set():
            item = self.redis.blpop("gk:cmd", timeout=1)
            if not item:
                continue
            _key, raw = item
            try:
                cmd = json.loads(raw)
            except json.JSONDecodeError:
                LOG.error("ignored malformed command")
                continue
            cmd_id = str(cmd.get("id") or "")
            try:
                op = cmd.get("op")
                if op == "watch":
                    self._watch(cmd)
                elif op == "unwatch":
                    self._unwatch(str(cmd.get("symbol") or "").upper())
                elif op == "reclaim":
                    self.taken.clear()
                else:
                    raise RuntimeError(f"unknown op")
                if cmd_id:
                    self._ack(cmd_id, True, None)
            except Exception as exc:
                LOG.error("command failed: %s", exc)
                if cmd_id:
                    self._ack(cmd_id, False, str(exc))

    def _watch(self, cmd):
        symbol = str(cmd.get("symbol") or "").upper()
        if not symbol:
            raise RuntimeError("symbol required")
        sessions = cmd.get("sessions") or ["PRE", "RTH"]
        with self.lock:
            already = symbol in self.builders
            needs_sub = symbol not in self.subscribed
        if already:
            self._write_symbol(symbol)
            if needs_sub:
                if not self.connected.wait(20):
                    raise RuntimeError("mqtt not connected")
                self._subscribe(symbol)
            return
        start_ms, end_ms = session_window()
        bars = fetch_bars(self.data, symbol, start_ms, end_ms, sessions, self.limiter)
        quote = None
        try:
            quote = fetch_quote(self.data, symbol, self.limiter)
        except Exception as exc:
            LOG.warning("quote seed %s failed: %s", symbol, exc)
        builder = MinuteBarBuilder()
        builder.seed(bars, int(time.time() * 1000))
        with self.lock:
            if symbol not in self.order and len(self.order) >= WATCH_LIMIT:
                self._evict_oldest()
            self.builders[symbol] = builder
            if quote:
                self.quotes[symbol] = quote
        self._write_symbol(symbol)
        with self.lock:
            if symbol not in self.order:
                self.order.append(symbol)
        if not self.connected.wait(20):
            raise RuntimeError("mqtt not connected")
        self._subscribe(symbol)
        LOG.info("watching %s bars=%s", symbol, len(bars))

    def _write_symbol(self, symbol):
        with self.lock:
            builder = self.builders.get(symbol)
            quote = self.quotes.get(symbol)
            rows = builder.rows() if builder else []
        self.redis.set(f"gk:bars:{symbol}", json.dumps(rows))
        if quote:
            self.redis.set(f"gk:quote:{symbol}", json.dumps(quote))

    def _evict_oldest(self):
        if not self.order:
            return
        old = self.order.pop(0)
        self.builders.pop(old, None)
        self.quotes.pop(old, None)
        self.subscribed.discard(old)
        try:
            self._unsubscribe(old)
        except Exception as exc:
            LOG.warning("unsubscribe %s failed: %s", old, exc)
        self.redis.delete(f"gk:bars:{old}", f"gk:quote:{old}")
        LOG.info("evicted %s", old)

    def _unwatch(self, symbol):
        with self.lock:
            if symbol in self.order:
                self.order.remove(symbol)
            self.builders.pop(symbol, None)
            self.quotes.pop(symbol, None)
            self.subscribed.discard(symbol)
        if symbol:
            try:
                self._unsubscribe(symbol)
            except Exception as exc:
                LOG.warning("unsubscribe %s failed: %s", symbol, exc)
            self.redis.delete(f"gk:bars:{symbol}", f"gk:quote:{symbol}")

    def _subscribe(self, symbol):
        """Subscribe this symbol on the sidecar's single MQTT session."""
        from webull.data.common.category import Category
        from webull.data.common.subscribe_type import SubscribeType
        from webull.data.quotes.market_streaming_data import MarketDataStreaming

        self.limiter.acquire("subscribe")
        streaming = MarketDataStreaming(self.stream.api_client)
        response = streaming.subscribe(
            self.stream.get_session_id(),
            [symbol],
            Category.US_STOCK.name,
            [SubscribeType.SNAPSHOT.name, SubscribeType.TICK.name],
        )
        status = getattr(response, "status_code", None)
        if status != 200:
            raise RuntimeError(f"subscribe failed status={status}")
        with self.lock:
            self.subscribed.add(symbol)
        LOG.info("subscribed SNAPSHOT+TICK %s", symbol)

    def _unsubscribe(self, symbol):
        from webull.data.common.category import Category
        from webull.data.common.subscribe_type import SubscribeType
        from webull.data.quotes.market_streaming_data import MarketDataStreaming

        self.limiter.acquire("subscribe")
        streaming = MarketDataStreaming(self.stream.api_client)
        streaming.unsubscribe(
            self.stream.get_session_id(),
            [symbol],
            Category.US_STOCK.name,
            [SubscribeType.SNAPSHOT.name, SubscribeType.TICK.name],
        )

    def _ack(self, cmd_id, ok, error):
        self.redis.set(f"gk:ack:{cmd_id}", json.dumps({"ok": ok, "error": error}), ex=60)

    def shutdown(self, *_args):
        self.stop.set()
        client = self.stream
        if client is not None:
            try:
                client.disconnect()
            except Exception:
                pass


def main():
    sidecar = Sidecar()
    signal.signal(signal.SIGTERM, sidecar.shutdown)
    signal.signal(signal.SIGINT, sidecar.shutdown)
    sidecar.run()


if __name__ == "__main__":
    main()
