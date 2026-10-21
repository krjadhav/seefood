"""TypeSafe Jev decision stage.

The embedding does retrieval (ranks the catalog into a shortlist). Jev is a
System One model that *sees the image* and picks the correct dish from that
shortlist — or "No food". It replaces the brittle hand-tuned thresholds with a
calibrated judgment, and falls back to the embedding verdict on any failure.

Config via env:
  JEV_API_KEY            TypeSafe key (Secret Manager on Cloud Run; .env locally)
  SEEFOOD_JEV_ENABLED    "1" (default) to use Jev; "0" kill-switch -> embedding only
  SEEFOOD_JEV_TIMEOUT    seconds, default 4
  SEEFOOD_JEV_MODEL      optional model override

NOTE: image input is an *experimental* TypeSafe feature, gated behind the
`TypeSafe-Danger-Zone-Images: true` header. Preview — may change.
"""
from __future__ import annotations

import os

NO_FOOD = "No food"
MAX_OPTIONS = 255  # TypeSafe Choice hard limit

_ENABLED = os.environ.get("SEEFOOD_JEV_ENABLED", "1") == "1"
_TIMEOUT = float(os.environ.get("SEEFOOD_JEV_TIMEOUT", "4"))
_MODEL = os.environ.get("SEEFOOD_JEV_MODEL") or None
_KEY = os.environ.get("JEV_API_KEY") or os.environ.get("TYPESAFE_API_KEY")

_client = None


def available() -> bool:
    return bool(_ENABLED and _KEY)


def _get_client():
    global _client
    if _client is None:
        from typesafe_sdk import TypeSafeClient

        _client = TypeSafeClient(
            api_key=_KEY,
            timeout=_TIMEOUT,
            model=_MODEL,
            headers={"TypeSafe-Danger-Zone-Images": "true"},
        )
    return _client


def decide(image_bytes: bytes, candidates: list[str]) -> dict | None:
    """Pick the dish shown, from `candidates` + "No food". Returns
    {choice, confidence, probabilities, isFood} or None on any failure."""
    if not available() or not candidates:
        return None
    try:
        from typesafe_sdk import Choice, Image

        # Shortlist + No food, deduped, within the 255 option limit.
        opts, seen = [], set()
        for name in candidates:
            k = name.lower()
            if name and k not in seen:
                seen.add(k)
                opts.append(name)
            if len(opts) >= MAX_OPTIONS - 1:
                break
        opts.append(NO_FOOD)

        resp = _get_client().system_one(
            state={"photo": Image(image_bytes)},
            questions={
                "dish": Choice(
                    instructions=(
                        "Which candidate dish does the photo show? "
                        f"Choose '{NO_FOOD}' if the image is not food."
                    ),
                    criteria={o: None for o in opts},
                )
            },
        )
        a = resp.choices["dish"]
        probs = dict(sorted(a.probabilities.items(), key=lambda x: -x[1])[:8])
        return {
            "choice": a.choice,
            "confidence": round(float(a.confidence), 4),
            "isFood": a.choice != NO_FOOD,
            "probabilities": {k: round(float(v), 4) for k, v in probs.items()},
        }
    except Exception:
        return None


def status() -> dict:
    return {"enabled": _ENABLED, "hasKey": bool(_KEY), "timeout": _TIMEOUT}
