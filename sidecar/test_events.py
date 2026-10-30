"""Order and position payloads parse without opening a connection."""

import unittest

from events import (
    classify_event_log,
    find_account,
    mask_display,
    parse_account_list,
    parse_order_event,
    parse_positions,
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
        self.assertEqual(line, "recent fill count=1 last=TNMG BUY 2026-10-30T15:11:00Z")
        self.assertNotIn("4.20", line)
        self.assertNotIn("ord-secret", line)
        self.assertEqual(recent_fill_line([]), "recent fill count=0 last=none")
