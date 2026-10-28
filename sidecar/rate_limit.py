"""Sliding-window limiter for Webull HTTP. Live quotes do not pass through here."""

import threading
import time
from collections import deque


class RateLimiter:
    def __init__(self, global_limit=300, global_window=60, endpoint_limit=60, endpoint_window=60):
        self.global_limit = global_limit
        self.global_window = global_window
        self.endpoint_limit = endpoint_limit
        self.endpoint_window = endpoint_window
        self._global = deque()
        self._endpoints = {}
        self._lock = threading.Lock()

    def acquire(self, endpoint):
        while True:
            with self._lock:
                wait = self._reserve(endpoint)
            if wait <= 0:
                return
            time.sleep(wait)

    def _reserve(self, endpoint):
        now = time.monotonic()
        self._trim(self._global, now, self.global_window)
        bucket = self._endpoints.setdefault(endpoint, deque())
        self._trim(bucket, now, self.endpoint_window)
        if len(self._global) >= self.global_limit:
            return self.global_window - (now - self._global[0]) + 0.05
        if len(bucket) >= self.endpoint_limit:
            return self.endpoint_window - (now - bucket[0]) + 0.05
        self._global.append(now)
        bucket.append(now)
        return 0

    @staticmethod
    def _trim(bucket, now, window):
        while bucket and now - bucket[0] >= window:
            bucket.popleft()
