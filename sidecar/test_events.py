"""Order and position payloads parse without opening a connection."""

import unittest

from datetime import datetime, timezone

from events import (
    ORDER_SUBSCRIBE_TYPE,
    classify_event_log,
    chase_exit,
    day_lots,
    raw_event_line,
    remember_secret,
    find_account,
    history_bounds,
    mask_display,
    mask_event,
    parse_account_list,
    order_event_line,
    next_rate_delay,
    parse_order_event,
    has_open_position,
    parse_positions,
    poll_interval_seconds,
    retry_after_seconds,
    parse_recent_fills,
    recent_fill_line,
)


class ParseEventsTest(unittest.TestCase):
    def test_partial_buy_keeps_the_cumulative_average(self):
        rows = parse_order_event({
            "client_order_id": "ord-1",
            "symbol": "tnmg",
            "side": "BUY",
            "order_status": "PARTIALLY_FILLED",
            "filled_quantity": "2",
            "avg_filled_price": "4.05",
        })
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["symbol"], "TNMG")
        self.assertEqual(rows[0]["side"], "BUY")
        self.assertEqual(rows[0]["id"], "ord-1:2.0")
        self.assertEqual(rows[0]["cumulative"], 2)
        self.assertEqual(rows[0]["average"], 4.05)

    def test_a_working_order_logs_placed_and_a_cancel_logs_cancelled(self):
        placed = {
            "client_order_id": "ord-2",
            "symbol": "TNMG",
            "side": "BUY",
            "order_status": "SUBMITTED",
            "filled_quantity": "0",
        }
        cancelled = {**placed, "order_status": "CANCELLED"}
        self.assertEqual(order_event_line(placed), "order event placed TNMG")
        self.assertEqual(order_event_line(cancelled), "order event cancelled TNMG")
        self.assertIsNone(order_event_line({**placed, "order_status": "FILLED"}))

    def test_a_working_order_is_not_a_fill(self):
        self.assertEqual(parse_order_event({
            "client_order_id": "ord-2",
            "symbol": "TNMG",
            "side": "BUY",
            "order_status": "WORKING",
            "filled_quantity": "0",
        }), [])

    def test_position_list_keeps_a_long(self):
        rows = parse_positions({
            "positions": [
                {"symbol": "TNMG", "quantity": "1", "cost_price": "4.20"},
                {"symbol": "BRAI", "quantity": "0", "cost_price": "5"},
            ]
        })
        self.assertEqual(rows, [{"symbol": "TNMG", "shares": 1, "average": 4.20}])

    def test_open_position_refuses_and_an_empty_list_does_not(self):
        self.assertFalse(has_open_position([]))
        self.assertFalse(has_open_position(None))
        self.assertFalse(has_open_position([{"symbol": "CHSN", "shares": 0}]))
        self.assertTrue(has_open_position([{"symbol": "CHSN", "shares": 100, "average": 4.09}]))

    def test_exit_chase_finds_a_new_sell_and_stops_after_three_retries(self):
        old = {"symbol": "CHSN", "side": "SELL", "order_id": "old-sell", "shares": 1, "price": 3.93, "ts": 1}
        new = {"symbol": "CHSN", "side": "SELL", "order_id": "new-sell", "shares": 1, "price": 3.91, "ts": 2}
        immediate = {"n": 0}

        def fetch_now():
            immediate["n"] += 1
            return [old, new]

        sleeps = []
        status, lots = chase_exit("CHSN", {"old-sell"}, fetch_now, sleeps.append)
        self.assertEqual(status, "found")
        self.assertEqual(sleeps, [])
        self.assertEqual(immediate["n"], 1)
        self.assertIn(new, lots)

        late = {"n": 0}

        def fetch_late():
            late["n"] += 1
            if late["n"] < 4:
                return [old]
            return [old, new]

        waited = []
        status, _lots = chase_exit("CHSN", {"old-sell"}, fetch_late, waited.append)
        self.assertEqual(status, "found")
        self.assertEqual(waited, [2, 2, 2])

        def fetch_never():
            return [old]

        gave_up = []
        status, missed = chase_exit("CHSN", {"old-sell"}, fetch_never, gave_up.append)
        self.assertEqual(status, "unconfirmed")
        self.assertIsNone(missed)
        self.assertEqual(gave_up, [2, 2, 2])

    def test_account_id_is_not_the_display_number(self):
        rows = parse_account_list({
            "accounts": [
                {"account_id": "id-1", "account_number": "CVU7R6E8", "account_type": "CASH"},
                {"account_id": "id-2", "account_number": "ABC12345", "account_type": "MARGIN"},
            ]
        })
        found = find_account(rows, "id-1")
        self.assertEqual(mask_display(found["display"]), "CVU7****")
        self.assertEqual(found["type"], "cash")
        self.assertIsNone(find_account(rows, "CVU7R6E8"))

    def test_position_poll_is_two_seconds_from_4am_until_8pm_et(self):
        from zoneinfo import ZoneInfo
        ny = ZoneInfo("America/New_York")
        self.assertEqual(poll_interval_seconds(datetime(2026, 11, 2, 4, 0, tzinfo=ny)), 2)
        self.assertEqual(poll_interval_seconds(datetime(2026, 11, 2, 10, 19, tzinfo=ny)), 2)
        self.assertEqual(poll_interval_seconds(datetime(2026, 11, 2, 19, 59, tzinfo=ny)), 2)
        self.assertEqual(poll_interval_seconds(datetime(2026, 11, 2, 20, 0, tzinfo=ny)), 10)
        self.assertEqual(poll_interval_seconds(datetime(2026, 11, 2, 3, 59, tzinfo=ny)), 10)

    def test_a_run_of_429s_backs_off_and_a_success_resets(self):
        failures = 0
        waits = []
        for _ in range(5):
            failures, delay = next_rate_delay(failures, 2, 10)
            waits.append(delay)
        self.assertEqual(waits, [2, 4, 8, 10, 10])
        failures = 0
        failures, delay = next_rate_delay(failures, 2, 10)
        self.assertEqual(delay, 2)
        failures, delay = next_rate_delay(failures, 2, 10, retry_after=6)
        self.assertEqual(delay, 6)

        failures = 0
        history = []
        for _ in range(5):
            failures, delay = next_rate_delay(failures, 60, 300)
            history.append(delay)
        self.assertEqual(history, [60, 120, 240, 300, 300])

        class Response:
            headers = {"Retry-After": "7"}
        self.assertEqual(retry_after_seconds(Response()), 7)

    def test_order_subscribe_type_is_order_status_only(self):
        self.assertEqual(ORDER_SUBSCRIBE_TYPE, 1)

    def test_raw_channel_line_hides_the_account_id(self):
        remember_secret("ACCTSECRET")
        class Response:
            eventType = 0
            subscribeType = 1
            payload = '{"account_id":"ACCTSECRET","symbol":"CLRO"}'
        line = raw_event_line(Response())
        self.assertIn("SubscribeSuccess", line)
        self.assertIn("CLRO", line)
        self.assertNotIn("ACCTSECRET", line)

    def test_event_log_drops_the_subscribe_payload(self):
        self.assertIsNone(classify_event_log("subscribe success, response: account_id=SECRET"))

    def test_grpc_error_is_a_disconnect_without_the_debug_string(self):
        kind, reason = classify_event_log(
            "grpc error code:UNAVAILABLE, error msg:unavailable, details:debug SECRET"
        )
        self.assertEqual(kind, "disconnected")
        self.assertEqual(reason, "UNAVAILABLE unavailable")
        self.assertNotIn("SECRET", reason)

    def test_retry_is_a_reconnect(self):
        kind, reason = classify_event_log("next retry will be started in 5000 ms, retry_context:SECRET")
        self.assertEqual(kind, "reconnecting")
        self.assertEqual(reason, "in 5000 ms")
        self.assertNotIn("SECRET", reason)

    def test_recent_fill_line_is_symbol_side_and_time(self):
        line = recent_fill_line(parse_recent_fills({
            "orders": [
                {
                    "symbol": "TNMG",
                    "side": "BUY",
                    "order_status": "FILLED",
                    "filled_time": "2026-10-30T15:11:00Z",
                    "filled_price": "4.20",
                    "order_id": "ord-secret",
                },
                {
                    "symbol": "BRAI",
                    "side": "SELL",
                    "order_status": "CANCELLED",
                    "filled_time": "2026-10-30T16:00:00Z",
                },
            ]
        }))
        self.assertEqual(line, "recent fill count=1 last=TNMG BUY 2026-10-30 11:11 ET")
        self.assertNotIn("4.20", line)
        self.assertNotIn("ord-secret", line)
        self.assertEqual(recent_fill_line([]), "recent fill count=0 last=none")

    def test_grouped_history_names_the_purr_sell(self):
        line = recent_fill_line(parse_recent_fills({
            "data": [
                {
                    "client_order_id": "secret-buy",
                    "orders": [{
                        "symbol": "PURR",
                        "side": "BUY",
                        "status": "FILLED",
                        "instrument_type": "EQUITY",
                        "filled_quantity": "1",
                        "filled_price": "12.22",
                        "filled_time": 1793290926884,
                        "client_order_id": "secret-buy",
                    }],
                },
                {
                    "client_order_id": "secret-sell",
                    "orders": [{
                        "symbol": "PURR",
                        "side": "SELL",
                        "status": "FILLED",
                        "instrument_type": "EQUITY",
                        "filled_quantity": "1",
                        "filled_price": "12.18",
                        "filled_time": 1793290965286,
                        "order_id": "secret-sell",
                    }],
                },
                {
                    "orders": [{
                        "symbol": "PURR",
                        "side": "BUY",
                        "status": "FILLED",
                        "instrument_type": "OPTION",
                        "filled_quantity": "1",
                        "filled_price": "1.00",
                        "filled_time": 1793290999999,
                    }],
                },
            ]
        }))
        self.assertEqual(line, "recent fill count=2 last=PURR SELL 2026-10-29 12:22 ET")
        self.assertNotIn("secret", line)
        self.assertNotIn("12.18", line)
        lots = day_lots(parse_recent_fills({
            "data": [{"orders": [{
                "symbol": "PURR",
                "side": "SELL",
                "status": "FILLED",
                "filled_quantity": "1",
                "filled_price": "12.18",
                "filled_time": 1793290965286,
                "client_order_id": "secret-sell",
                "order_id": "broker-sell",
            }]}]
        }))
        self.assertEqual(lots[0]["order_id"], "secret-sell")

    def test_buy_event_shape_masks_ids(self):
        masked = mask_event({
            "client_order_id": "secret-buy",
            "symbol": "PURR",
            "side": "BUY",
            "status": "FILLED",
            "filled_quantity": "1",
            "filled_price": "12.22",
        })
        self.assertEqual(masked["client_order_id"], "****")
        self.assertEqual(masked["symbol"], "PURR")
        self.assertEqual(masked["side"], "BUY")
        self.assertEqual(masked["filled_price"], "12.22")

    def test_history_window_uses_a_z_suffix(self):
        start, end = history_bounds(datetime(2026, 10, 30, 20, 10, 4, tzinfo=timezone.utc))
        self.assertEqual(end, "2026-10-30T20:10:04.000Z")
        self.assertTrue(start.endswith("Z"))
        self.assertNotIn("+0000", start)
