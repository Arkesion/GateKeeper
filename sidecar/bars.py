"""1-minute bar normalization and live bar building. Market data only."""

import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
PRE_START = 4 * 60
OVERNIGHT_EVENING = 20 * 60
RTH_START = 9 * 60 + 30
RTH_END = 16 * 60
_CLOCK_RE = re.compile(r"^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$")


def parse_time_ms(value, now=None):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        ms = int(value)
        return ms * 1000 if ms < 10**12 else ms
    text = str(value).strip()
    if text.isdigit():
        return parse_time_ms(int(text))
    clock = _clock_on_exchange_date(text, now)
    if clock is not None:
        return int(clock.timestamp() * 1000)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ET)
    return int(dt.timestamp() * 1000)


def _clock_on_exchange_date(text, now=None):
    """HH:MM:SS on today's America/New_York date, rolled across midnight overnight."""
    match = _CLOCK_RE.match(text)
    if match is None:
        return None
    hour, minute, second, frac = match.groups()
    micro = int((frac + "000000")[:6]) if frac else 0
    now_et = now.astimezone(ET) if now is not None else datetime.now(ET)
    if now_et.tzinfo is None:
        now_et = now_et.replace(tzinfo=ET)
    candidate = datetime(
        now_et.year,
        now_et.month,
        now_et.day,
        int(hour),
        int(minute),
        int(second),
        micro,
        tzinfo=ET,
    )
    clock_mins = int(hour) * 60 + int(minute)
    now_mins = now_et.hour * 60 + now_et.minute
    if clock_mins >= OVERNIGHT_EVENING and now_mins < PRE_START:
        candidate -= timedelta(days=1)
    elif clock_mins < PRE_START and now_mins >= OVERNIGHT_EVENING:
        candidate += timedelta(days=1)
    return candidate


def money(value):
    if value is None or value == "":
        return None
    return round(float(value), 4)


def normalize_bar(raw):
    if not isinstance(raw, dict):
        return None
    dt = parse_time_ms(
        raw.get("time", raw.get("timestamp", raw.get("t", raw.get("datetime", raw.get("start_time")))))
    )
    open_ = money(raw.get("open", raw.get("o")))
    high = money(raw.get("high", raw.get("h")))
    low = money(raw.get("low", raw.get("l")))
    close = money(raw.get("close", raw.get("c")))
    if dt is None or None in (open_, high, low, close):
        return None
    volume = raw.get("volume", raw.get("v", 0))
    return {
        "datetime": dt,
        "open": open_,
        "high": high,
        "low": low,
        "close": close,
        "volume": int(round(float(volume or 0))),
    }


def unwrap_bars(payload):
    if isinstance(payload, dict):
        if isinstance(payload.get("bars"), list):
            return payload["bars"]
        for key in ("data", "result", "list"):
            if key in payload:
                found = unwrap_bars(payload[key])
                if found:
                    return found
        collected = []
        for value in payload.values():
            if isinstance(value, list):
                collected.extend(unwrap_bars(value))
        return collected
    if isinstance(payload, list):
        if not payload:
            return []
        if any(isinstance(item, dict) and ("open" in item or "o" in item) for item in payload):
            return [item for item in payload if isinstance(item, dict)]
        collected = []
        for item in payload:
            collected.extend(unwrap_bars(item))
        return collected
    return []


def et_minutes(ms):
    dt = datetime.fromtimestamp(ms / 1000, ET)
    return dt.hour * 60 + dt.minute


def in_sessions(ms, sessions):
    mins = et_minutes(ms)
    wanted = set(sessions or ("PRE", "RTH"))
    if "PRE" in wanted and PRE_START <= mins < RTH_START:
        return True
    if "RTH" in wanted and RTH_START <= mins < RTH_END:
        return True
    return False


def floor_minute_ms(ms):
    dt = datetime.fromtimestamp(ms / 1000, ET).replace(second=0, microsecond=0)
    return int(dt.timestamp() * 1000)


def session_window(now=None, day=None):
    """PRE+RTH window for an ET day. End is min(16:00 ET, now) when day is today."""
    current = now or datetime.now(ET)
    if current.tzinfo is None:
        current = current.replace(tzinfo=ET)
    if day is None:
        start = current.replace(hour=4, minute=0, second=0, microsecond=0)
        if current < start:
            start = start - timedelta(days=1)
    else:
        start = datetime(day.year, day.month, day.day, 4, 0, tzinfo=ET)
    end = start.replace(hour=16, minute=0)
    if current < end and (day is None or current.date() == day):
        end = current
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def dedupe_bars(bars):
    merged = {}
    for bar in bars:
        if bar:
            merged[bar["datetime"]] = bar
    return [merged[key] for key in sorted(merged)]


OHLCV_FIELDS = ("open", "high", "low", "close", "volume")
MINUTE_MS = 60_000


def ohlcv_equal(left, right):
    return all(left.get(name) == right.get(name) for name in OHLCV_FIELDS)


class MinuteBarBuilder:
    """Seed from HTTP bars, then fold trade prints into the current ET minute.

    Stream bars are provisional. replace() writes the HTTP bar over a closed minute.
    """

    def __init__(self):
        self.closed = []
        self.forming = None
        self.prev_cum = None
        self.cum_session = None

    def seed(self, bars, now_ms):
        rows = dedupe_bars(bars)
        for row in rows:
            row["provisional"] = False
        current = floor_minute_ms(now_ms)
        if rows and rows[-1]["datetime"] == current:
            self.forming = dict(rows[-1])
            self.forming["provisional"] = True
            self.closed = rows[:-1]
        else:
            self.forming = None
            self.closed = rows
        self.prev_cum = None
        self.cum_session = None

    def rows(self):
        rows = list(self.closed)
        if self.forming:
            rows.append(self.forming)
        return rows

    def on_trade(self, price, cum, trade_ms, bucket):
        """Return the bar that just closed, or None."""
        if price is None or trade_ms is None or bucket not in ("PRE", "RTH"):
            return None
        minute = floor_minute_ms(trade_ms)
        if not in_sessions(minute, ["PRE", "RTH"]):
            return None
        if self.cum_session != bucket:
            self.prev_cum = None
            self.cum_session = bucket
        closed_out = None
        if self.forming is None or self.forming["datetime"] != minute:
            if self.forming is not None:
                self.closed.append(self.forming)
                closed_out = self.forming
            delta = 0
            if cum is not None and self.prev_cum is not None and cum >= self.prev_cum:
                delta = cum - self.prev_cum
            self.forming = {
                "datetime": minute,
                "open": price,
                "high": price,
                "low": price,
                "close": price,
                "volume": int(round(delta)),
                "provisional": True,
            }
        else:
            bar = self.forming
            bar["high"] = max(bar["high"], price)
            bar["low"] = min(bar["low"], price)
            bar["close"] = price
            if cum is not None and self.prev_cum is not None and cum >= self.prev_cum:
                bar["volume"] = int(bar["volume"] + round(cum - self.prev_cum))
        if cum is not None:
            self.prev_cum = cum
        return closed_out

    def on_print(self, price, size, trade_ms, bucket):
        """Add one trade. Volume is the sum of trade sizes. Returns the bar just closed.

        TODO: Webull tick messages have no SIP sale-condition field, only price,
        size, time, and side. Every print updates high, low, and last. When a
        condition field exists, keep every print in volume and exclude late,
        out-of-sequence, average-price, and odd-lot prints from high, low, and last.
        Do not guess odd lots from size.
        """
        if price is None or trade_ms is None or bucket not in ("PRE", "RTH"):
            return None
        minute = floor_minute_ms(trade_ms)
        if not in_sessions(minute, ["PRE", "RTH"]):
            return None
        size = int(size or 0)
        closed_out = None
        if self.forming is None or self.forming["datetime"] != minute:
            if self.forming is not None:
                self.closed.append(self.forming)
                closed_out = self.forming
            self.forming = {
                "datetime": minute,
                "open": price,
                "high": price,
                "low": price,
                "close": price,
                "volume": max(size, 0),
                "provisional": True,
            }
        else:
            bar = self.forming
            bar["high"] = max(bar["high"], price)
            bar["low"] = min(bar["low"], price)
            bar["close"] = price
            if size > 0:
                bar["volume"] = int(bar["volume"]) + size
        return closed_out

    def replace(self, minute_ms, bar):
        """Overwrite one closed bar with a final HTTP bar."""
        return bool(self.upsert_official([dict(bar, datetime=int(minute_ms))]))

    def upsert_official(self, bars):
        """Write HTTP bars over closed minutes. Skip a bar whose OHLCV already matches
        and is already final. Returns the bars that were written.
        """
        changed = []
        for bar in bars:
            minute = int(bar["datetime"])
            official = dict(bar)
            official["datetime"] = minute
            official["provisional"] = False
            for index, row in enumerate(self.closed):
                if row["datetime"] != minute:
                    continue
                if row.get("provisional") is False and ohlcv_equal(row, official):
                    break
                self.closed[index] = official
                changed.append(official)
                break
        return changed


def session_bucket(session, trade_ms=None):
    label = str(session or "").upper()
    if label.startswith("PRE") or label in ("PM", "BEFORE", "PREMARKET"):
        return "PRE"
    if "RTH" in label or label in ("REGULAR", "CORE", "CT", "TRADING"):
        return "RTH"
    if trade_ms is None:
        return None
    minute = floor_minute_ms(trade_ms)
    if in_sessions(minute, ["PRE"]):
        return "PRE"
    if in_sessions(minute, ["RTH"]):
        return "RTH"
    return None


def tick_print(tick):
    """Price, trade size, time, and session bucket from one tick message."""
    basic = getattr(tick, "basic", None)
    session = getattr(basic, "trading_session", None) if basic is not None else None
    symbol = getattr(basic, "symbol", None) if basic is not None else None
    price = _num(getattr(tick, "price", None))
    raw_size = getattr(tick, "volume", None)
    size = int(round(float(raw_size))) if raw_size not in (None, "") else 0
    trade_ms = parse_time_ms(getattr(tick, "time", None))
    if trade_ms is None and basic is not None:
        trade_ms = parse_time_ms(getattr(basic, "timestamp", None))
    bucket = session_bucket(session, trade_ms)
    if symbol:
        symbol = str(symbol).upper()
    return symbol, price, size, trade_ms, bucket, session


def snapshot_trade(snap):
    """Pick price, cumulative volume, and session bucket from an SDK snapshot."""
    basic = getattr(snap, "basic", None)
    session = (getattr(basic, "trading_session", None) or "")
    session = str(session).upper()
    timestamp = getattr(basic, "timestamp", None) if basic is not None else None
    ext_price = _num(getattr(snap, "ext_price", None))
    last_price = _num(getattr(snap, "price", None))
    pre_close = _num(getattr(snap, "pre_close", None))
    if session.startswith("PRE") or session in ("PM", "BEFORE", "PREMARKET"):
        bucket = "PRE"
        price = ext_price if ext_price is not None else last_price
        cum = _num(getattr(snap, "ext_volume", None))
        trade_ms = getattr(snap, "ext_trade_time", None) or timestamp
    elif "RTH" in session or session in ("REGULAR", "CORE", "CT", "TRADING"):
        bucket = "RTH"
        price = last_price
        cum = _num(getattr(snap, "volume", None))
        trade_ms = getattr(snap, "last_trade_time", None) or timestamp
    elif ext_price is not None and last_price is None:
        bucket = "PRE"
        price = ext_price
        cum = _num(getattr(snap, "ext_volume", None))
        trade_ms = getattr(snap, "ext_trade_time", None) or timestamp
    else:
        bucket = "RTH" if last_price is not None else "PRE"
        price = last_price if last_price is not None else ext_price
        cum = _num(getattr(snap, "volume", None) if bucket == "RTH" else getattr(snap, "ext_volume", None))
        trade_ms = getattr(snap, "last_trade_time", None) or getattr(snap, "ext_trade_time", None) or timestamp
    return price, cum, parse_time_ms(trade_ms), pre_close, bucket, session


def _num(value):
    if value is None or value == "":
        return None
    return float(value)


def quote_from_trade(price, pre_close, bid=None, ask=None):
    return {
        "lastPrice": price,
        "closePrice": pre_close,
        "bidPrice": bid,
        "askPrice": ask,
    }
