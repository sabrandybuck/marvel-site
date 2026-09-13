"""Minimal MediaWiki API client used by the crawler.

Design goals:
- stdlib only (urllib), no third-party dependencies
- polite crawling: descriptive User-Agent, maxlag, request throttling
- resilient: retries with capped exponential backoff + jitter on 429/503,
  network errors, empty bodies and malformed JSON (observed in the wild)
- disk cache: every successful response is stored, so interrupted crawls
  can resume without re-fetching
"""

from __future__ import annotations

import hashlib
import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

USER_AGENT = (
    "marvel-crawler/1.0 "
    "(educational social-network analysis; python-urllib; contact: n/a)"
)

RETRYABLE_HTTP = {403, 429, 500, 502, 503, 504}


class CrawlerError(RuntimeError):
    """Raised when the API keeps failing after all retries."""


def batched(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


class WikiClient:
    """Thin wrapper around action=query with throttle/cache/retry."""

    def __init__(
        self,
        lang: str = "en",
        sleep: float = 1.0,
        cache_dir: str | Path | None = None,
        refresh_cache: bool = False,
        max_retries: int = 6,
        timeout: float = 40.0,
    ):
        self.api_url = f"https://{lang}.wikipedia.org/w/api.php"
        self.sleep = sleep
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.refresh_cache = refresh_cache
        self.max_retries = max_retries
        self.timeout = timeout
        self._last_request = 0.0
        self.n_requests = 0
        self.n_cache_hits = 0
        if self.cache_dir is not None:
            self.cache_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ core

    def _build_url(self, params: dict) -> str:
        full = {
            "action": "query",
            "format": "json",
            "formatversion": "2",
            "maxlag": "5",
            **params,
        }
        return self.api_url + "?" + urllib.parse.urlencode(full, doseq=True)

    def _cache_path(self, url: str) -> Path | None:
        if self.cache_dir is None:
            return None
        return self.cache_dir / (hashlib.sha1(url.encode()).hexdigest() + ".json")

    def _throttle(self) -> None:
        now = time.monotonic()
        wait = self._last_request + self.sleep - now
        if wait > 0:
            time.sleep(wait)
        self._last_request = time.monotonic()

    def _fetch_once(self, url: str) -> tuple[int, bytes, str | None]:
        """One HTTP attempt. Returns (status, body, retry_after_header)."""
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        retry_after = None
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return 200, resp.read(), None
        except urllib.error.HTTPError as e:
            retry_after = e.headers.get("Retry-After") if e.headers else None
            return e.code, b"", retry_after
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            return 599, b"", retry_after

    def get(self, **params) -> dict:
        """GET one API response (following nothing; use query_all to paginate)."""
        url = self._build_url(params)
        cpath = self._cache_path(url)
        if cpath is not None and not self.refresh_cache and cpath.exists():
            self.n_cache_hits += 1
            return json.loads(cpath.read_text(encoding="utf-8"))

        backoff = 2.0
        last_error = ""
        for attempt in range(1, self.max_retries + 1):
            self._throttle()
            self.n_requests += 1
            status, body, retry_after = self._fetch_once(url)

            if status == 200 and body:
                try:
                    data = json.loads(body)
                except json.JSONDecodeError:
                    data = None
                if data is not None:
                    if "error" in data:
                        code = data["error"].get("code", "")
                        if code == "maxlag":
                            last_error = "maxlag exceeded, retrying"
                        else:
                            raise CrawlerError(
                                f"API error {code}: {data['error'].get('info', '')}"
                            )
                    else:
                        if cpath is not None:
                            cpath.write_text(body.decode("utf-8"), encoding="utf-8")
                        return data
                else:
                    last_error = "malformed JSON body"

            if status == 200 and not body:
                last_error = "empty body"

            if attempt == self.max_retries:
                break

            wait = None
            if retry_after:
                try:
                    wait = float(retry_after)
                except ValueError:
                    wait = None
            if wait is None:
                wait = backoff + random.uniform(0, 1.5)
                backoff = min(backoff * 2, 20.0)
            reason = last_error or f"HTTP {status}"
            print(
                f"  [retry {attempt}/{self.max_retries}] {reason}; "
                f"waiting {wait:.1f}s",
                flush=True,
            )
            time.sleep(wait)

        raise CrawlerError(
            f"API request failed after {self.max_retries} attempts ({last_error}): {url}"
        )

    def query_all(self, **params):
        """Yield every page of a continuing action=query call."""
        cont: dict = {}
        while True:
            data = self.get(**params, **cont)
            yield data
            if "continue" not in data:
                break
            cont = data["continue"]
