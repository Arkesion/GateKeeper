"""Live bar labels use the trade's minute. HTTP `time` is that same start."""

import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from bars import MinuteBarBuilder, normalize_bar

ET = ZoneInfo("America/New_York")


def label(ms):
    return datetime.fromtimestamp(ms / 1000, ET).strftime("%H:%M")


def at(hour, minute, second):
    return int(datetime(2026, 10, 30, hour, minute, second, tzinfo=ET).timestamp() * 1000)


class LiveBarStartTest(unittest.TestCase):
    def test_print_at_11_11_labels_the_bar_start(self):
        builder = MinuteBarBuilder()
        closed = builder.on_print(3.20, 100, at(11, 10, 30), "RTH")
        self.assertIsNone(closed)
        closed = builder.on_print(3.16, 100, at(11, 11, 30), "RTH")
        self.assertEqual(label(closed["datetime"]), "11:10")
        self.assertEqual(label(builder.forming["datetime"]), "11:11")

    def test_http_time_matches_the_live_start_and_replace_keeps_it(self):
        # TNMG 2026-10-30 red bar. The payload has `time` and no start_time.
        # 15:10:00Z is 11:10 ET, the same minute a print at 11:10:30 builds.
        raw = {
            "time": "2026-10-30T15:10:00.000+0000",
            "open": "3.2000",
            "high": "3.2400",
            "low": "3.1500",
            "close": "3.1700",
            "volume": "98815",
        }
        official = normalize_bar(raw)
        self.assertEqual(label(official["datetime"]), "11:10")
        builder = MinuteBarBuilder()
        builder.on_print(3.20, 10, at(11, 10, 30), "RTH")
        builder.on_print(3.16, 10, at(11, 11, 30), "RTH")
        builder.upsert_official([official])
        replaced = [bar for bar in builder.closed if label(bar["datetime"]) == "11:10"]
        self.assertEqual(len(replaced), 1)
        self.assertEqual(replaced[0]["close"], 3.17)
        self.assertEqual(replaced[0]["volume"], 98815)
        self.assertEqual(label(builder.forming["datetime"]), "11:11")


if __name__ == "__main__":
    unittest.main()
