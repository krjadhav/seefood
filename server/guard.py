"""Abuse protection for the classify endpoint.

Layers (all free, pure in-process):
  1. Origin/Referer allowlist — reject requests not coming from the site. A
     speed bump: headers are spoofable by a determined caller, but it blocks
     other websites' browsers and casual curl.
  2. Per-IP sliding-window rate limit — slows a single abuser.
  3. Global daily cap — the bankruptcy bound. Even a spoofed origin cannot run
     the day's cost past this.

CAVEAT: counters are in-memory, so they reset when the Cloud Run instance cold-
starts. Run max-instances=1 so there is a single counter, and keep the cap low.
For a cap that survives restarts, back it with Firestore (see deployment plan).

Config via env:
  SEEFOOD_ALLOWED_ORIGINS  comma list, default the production domain
  SEEFOOD_RATE_PER_MIN     per-IP requests/min, default 10
  SEEFOOD_DAILY_CAP        global accepted requests/day, default 800
  SEEFOOD_ENFORCE_ORIGIN   "1" to reject bad origins (default), "0" to log-only
"""
from __future__ import annotations

import os
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

ALLOWED_ORIGINS = {
    o.strip().rstrip("/")
    for o in os.environ.get(
        "SEEFOOD_ALLOWED_ORIGINS",
        "https://seefood.verygoodproduct.company",
    ).split(",")
    if o.strip()
}
RATE_PER_MIN = int(os.environ.get("SEEFOOD_RATE_PER_MIN", "10"))
DAILY_CAP = int(os.environ.get("SEEFOOD_DAILY_CAP", "800"))
ENFORCE_ORIGIN = os.environ.get("SEEFOOD_ENFORCE_ORIGIN", "1") == "1"

_hits: dict[str, deque] = defaultdict(deque)  # ip -> recent request timestamps
_day = {"key": "", "count": 0}


def _client_ip(request: Request) -> str:
    # Cloud Run sets X-Forwarded-For: "<client>, <proxy>..."
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _origin_ok(request: Request) -> bool:
    origin = (request.headers.get("origin") or "").rstrip("/")
    if origin:
        return origin in ALLOWED_ORIGINS
    # No Origin (e.g. some same-origin GETs): fall back to Referer prefix.
    referer = request.headers.get("referer") or ""
    return any(referer.startswith(o) for o in ALLOWED_ORIGINS)


def _origin_and_rate(request: Request) -> None:
    # 1. Origin / Referer allowlist.
    if ENFORCE_ORIGIN and not _origin_ok(request):
        raise HTTPException(403, "This endpoint only serves the SeeFood app.")
    # 2. Per-IP sliding-window rate limit.
    now = time.time()
    ip = _client_ip(request)
    window = _hits[ip]
    cutoff = now - 60
    while window and window[0] < cutoff:
        window.popleft()
    if len(window) >= RATE_PER_MIN:
        raise HTTPException(
            429, "Too many requests. Wait a minute and try again.",
            headers={"Retry-After": "60"},
        )
    window.append(now)
    if len(_hits) > 10000:  # bound memory
        _hits.pop(next(iter(_hits)), None)


def guard_light(request: Request) -> None:
    """Origin + rate limit only. For cheap endpoints (no Vertex call)."""
    _origin_and_rate(request)


def guard(request: Request) -> None:
    """Full guard for the costly classify path: origin + rate + global daily cap.
    The daily cap is the bankruptcy bound — it only counts paid Vertex calls."""
    _origin_and_rate(request)
    now = time.time()
    today = time.strftime("%Y-%m-%d", time.gmtime(now))
    if _day["key"] != today:
        _day["key"], _day["count"] = today, 0
    if _day["count"] >= DAILY_CAP:
        raise HTTPException(
            429, "The app hit today's usage limit. Try again tomorrow.",
            headers={"Retry-After": "3600"},
        )
    _day["count"] += 1


def status() -> dict:
    return {
        "allowedOrigins": sorted(ALLOWED_ORIGINS),
        "enforceOrigin": ENFORCE_ORIGIN,
        "ratePerMin": RATE_PER_MIN,
        "dailyCap": DAILY_CAP,
        "todayCount": _day["count"],
    }
