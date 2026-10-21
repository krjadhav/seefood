"""SeeFood recognition backend.

Loads EmbeddingGemma 2 once, pre-embeds the candidate food / non-food labels,
and exposes POST /api/classify. For a posted image it returns the top food
name (or "Not Food"), plus a pile of metadata the frontend renders on the side.
"""
from __future__ import annotations

import hashlib
import io
import json
import platform
import re
import time
from pathlib import Path

import numpy as np
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

import guard as guardmod
import jev as jevmod
from embed import get_embedder
from labels import FOOD_ALL, NON_FOOD_LABELS

HERE = Path(__file__).resolve().parent
MODEL_DIR = str(HERE.parent / "google_embeddinggemma_2")
PROTO_PATH = HERE / "prototypes.npz"
TARLA_PROTO_PATH = HERE / "tarla_prototypes.npz"
CATALOG_PATH = HERE / "dish_catalog.json"
TARLA_CATALOG_PATH = HERE / "tarla_catalog.json"
LABEL_CACHE_PATH = HERE / "label_emb_cache.npz"
MODEL_NAME = "google/embeddinggemma-2"
# Khana centroids average many photos and are the 80 curated dishes; Tarla
# anchors are single noisy images. Prefer a khana prototype whenever its score
# clears this floor, so Tarla look-alikes can't steal an in-set dish.
KHANA_FLOOR = 0.44
# A curated western label overrides the prototype when it beats the prototype
# dish's own text score by more than this. Khana names are trusted (hard to
# override); single-image Tarla anchors yield easily.
KHANA_OVERRIDE_GAP = 0.05
TARLA_OVERRIDE_GAP = 0.0
# A single-image Tarla anchor is only trusted to name a dish when its visual
# score clears this; weaker Tarla matches (out-of-dataset foods landing on a
# look-alike) defer to the curated text name.
TARLA_TRUST = 0.55
# Below this Jev Choice confidence, defer to a confident khana prototype rather
# than Jev's uncertain pick among catalog look-alikes.
JEV_MIN_CONFIDENCE = 0.5


def _key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _short(name: str) -> str:
    """Collapse a multi-name title to its first clean name:
    'Spring Rolls, Chinese Veg ... | ...' -> 'Spring Rolls'."""
    s = str(name).split("|")[0].split(",")[0]
    s = re.sub(r"\brecipe\b", "", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip()
    return s or str(name)


def _load_proto(path: Path):
    data = np.load(path, allow_pickle=True)
    return [_short(n) for n in data["names"]], data["centroids"].astype(np.float32)
# Cross-modal cosine scores sit in a narrow band, so sharpen with a low
# temperature before softmax to make the displayed confidences readable.
SOFTMAX_TEMPERATURE = 0.05
TOP_K = 8

app = FastAPI(title="SeeFood recognition")
# CORS pinned to the app's own origin(s) — blocks other websites' browsers.
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(guardmod.ALLOWED_ORIGINS),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

_state: dict = {}


@app.on_event("startup")
def load_model() -> None:
    t0 = time.time()
    # Embedding backend is swappable (local EmbeddingGemma 2 or hosted Vertex);
    # retrieval/routing below is identical either way.
    embedder = get_embedder(MODEL_DIR)
    device, dtype = embedder.device, embedder.dtype
    # Visual prototypes: khana (multi-image centroids) + Tarla (single-image).
    # Mean-centering amplifies the distinctive part of each prototype; a bonus
    # keeps khana authoritative. Food-plate photos otherwise cluster in a narrow
    # high-cosine cone where raw nearest-centroid barely separates dishes.
    proto_names: list[str] = []
    proto_is_khana: list[bool] = []
    raw_list = []
    if PROTO_PATH.exists():
        kn, kc = _load_proto(PROTO_PATH)
        proto_names += kn
        proto_is_khana += [True] * len(kn)
        raw_list.append(kc)
    if TARLA_PROTO_PATH.exists():
        tn, tc = _load_proto(TARLA_PROTO_PATH)
        proto_names += tn
        proto_is_khana += [False] * len(tn)
        raw_list.append(tc)

    proto_cent, proto_mean, proto_khana = None, None, None
    khana_count = sum(proto_is_khana)
    if raw_list:
        raw = np.vstack(raw_list)
        raw /= np.linalg.norm(raw, axis=1, keepdims=True) + 1e-9
        proto_mean = raw.mean(axis=0)
        proto_mean /= np.linalg.norm(proto_mean) + 1e-9
        centered = raw - raw.mean(axis=0, keepdims=True)
        centered /= np.linalg.norm(centered, axis=1, keepdims=True) + 1e-9
        proto_cent = centered
        proto_khana = np.array(proto_is_khana)
    proto_keys = {_key(n) for n in proto_names}

    # Text-label pool. Two catalogs bring rich descriptions and extend coverage
    # far beyond the photo dishes: indian_food.csv (structured facts) and the
    # Tarla recipes (ingredients + photo). CSV facts take precedence on overlap.
    def _norm_cat(d: dict) -> dict:
        nm = _short(d["name"])
        return {**d, "name": nm, "key": _key(nm)}

    csv_catalog = (
        [_norm_cat(d) for d in json.loads(CATALOG_PATH.read_text())]
        if CATALOG_PATH.exists()
        else []
    )
    tarla_catalog = (
        [_norm_cat(d) for d in json.loads(TARLA_CATALOG_PATH.read_text())]
        if TARLA_CATALOG_PATH.exists()
        else []
    )
    catalog_by_key: dict = {}
    for d in csv_catalog:
        catalog_by_key.setdefault(d["key"], d)
    for d in tarla_catalog:
        catalog_by_key.setdefault(d["key"], d)

    names, keys, texts, is_food, has_proto, is_cat = [], [], [], [], [], []
    seen: set[tuple[str, bool]] = set()

    def add(name: str, text: str, food: bool, proto: bool, cat: bool) -> None:
        k = _key(name)
        if (k, food) in seen:
            return
        seen.add((k, food))
        names.append(name)
        keys.append(k)
        texts.append(text)
        is_food.append(food)
        has_proto.append(proto)
        is_cat.append(cat)

    # Catalog first so its description wins over a plain "a photo of" label.
    for d in csv_catalog:
        add(d["name"], d["text"], True, d["key"] in proto_keys, True)
    for d in tarla_catalog:
        add(d["name"], d["text"], True, d["key"] in proto_keys, True)
    for name in FOOD_ALL:
        add(name, f"a photo of {name}", True, _key(name) in proto_keys, False)
    for name in proto_names:  # ensure every prototype dish is representable
        add(name, f"a photo of {name}", True, True, _key(name) in catalog_by_key)
    for name in NON_FOOD_LABELS:
        add(name, name, False, False, False)

    # Embedding the ~7k-label pool is slow, so cache it keyed by the exact texts
    # AND the provider — vectors from a different model must not be reused.
    sig = hashlib.sha1(
        (embedder.name + "\x1e" + "\x1f".join(texts)).encode("utf-8")
    ).hexdigest()
    label_emb = None
    if LABEL_CACHE_PATH.exists():
        cached = np.load(LABEL_CACHE_PATH, allow_pickle=True)
        if str(cached["sig"]) == sig:
            label_emb = cached["emb"].astype(np.float32)
    if label_emb is None:
        label_emb = embedder.embed_texts(texts).astype(np.float32)
        np.savez(LABEL_CACHE_PATH, sig=sig, emb=label_emb)

    _state.update(
        embedder=embedder,
        model_name=embedder.name,
        device=device,
        dtype=dtype,
        label_names=names,
        label_keys=keys,
        label_is_food=is_food,
        label_has_proto=has_proto,
        label_is_cat=is_cat,
        label_emb=label_emb,
        catalog_by_key=catalog_by_key,
        catalog_count=len(catalog_by_key),
        proto_keys=proto_keys,
        proto_names=proto_names,
        proto_cent=proto_cent,
        proto_mean=proto_mean,
        proto_khana=proto_khana,
        khana_count=khana_count,
        load_ms=round((time.time() - t0) * 1000),
    )


@app.get("/api/health")
def health() -> dict:
    return {
        "ready": "embedder" in _state,
        "model": _state.get("model_name", MODEL_NAME),
        "device": _state.get("device"),
        "labels": len(_state.get("label_names", [])),
        "catalog": _state.get("catalog_count", 0),
        "prototypes": len(_state.get("proto_names", [])),
        "khanaPrototypes": _state.get("khana_count", 0),
        "load_ms": _state.get("load_ms"),
        "guard": guardmod.status(),
        "jev": jevmod.status(),
    }


@app.get("/api/dishes")
def dishes(_: None = Depends(guardmod.guard_light)) -> dict:
    """All catalog dish names, for the 'evaluating' scrolling ticker."""
    names = _state.get("label_names", [])
    is_food = _state.get("label_is_food", [])
    is_cat = _state.get("label_is_cat", [])
    out = [names[i] for i in range(len(names)) if is_food[i] and is_cat[i]]
    return {"count": len(out), "names": out}


@app.post("/api/classify")
async def classify(
    image: UploadFile = File(...), _: None = Depends(guardmod.guard)
) -> dict:
    if "embedder" not in _state:
        raise HTTPException(503, "Model is still loading, try again in a moment.")
    raw = await image.read()
    try:
        pil = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        raise HTTPException(400, "Could not decode that image.")

    embedder = _state["embedder"]
    t0 = time.time()
    img_emb = embedder.embed_image(pil)
    infer_ms = round((time.time() - t0) * 1000)

    label_emb: np.ndarray = _state["label_emb"]
    names: list[str] = _state["label_names"]
    keys: list[str] = _state["label_keys"]
    is_food: list[bool] = _state["label_is_food"]
    is_cat: list[bool] = _state["label_is_cat"]
    catalog_by_key: dict = _state.get("catalog_by_key", {})

    sims = label_emb @ img_emb  # cosine, both normalized
    scaled = sims / SOFTMAX_TEMPERATURE
    probs = np.exp(scaled - scaled.max())
    probs = probs / probs.sum()

    order = np.argsort(-sims)
    best = int(order[0])
    text_is_food = bool(is_food[best])
    text_name = names[best]
    food_prob = float(sum(probs[i] for i in range(len(names)) if is_food[i]))

    top = [
        {
            "label": names[i],
            "similarity": round(float(sims[i]), 4),
            "probability": round(float(probs[i]), 4),
            "isFood": bool(is_food[i]),
        }
        for i in order[:TOP_K]
    ]

    # Visual prototype match: mean-center the image embedding, then cosine-rank
    # against the mean-centered dish centroids (far more discriminative than raw
    # cosine, ~0.95 vs ~0.75 top-1 on held-out dataset images).
    proto_cent = _state.get("proto_cent")
    proto_names = _state.get("proto_names", [])
    proto_mean = _state.get("proto_mean")
    proto_khana = _state.get("proto_khana")
    prototype = None
    if proto_cent is not None and len(proto_cent):
        vc = img_emb - proto_mean
        vc = vc / (np.linalg.norm(vc) + 1e-9)
        psims = proto_cent @ vc
        porder = np.argsort(-psims)
        pj = int(porder[0])
        # Prefer the best khana prototype if it clears the floor.
        if proto_khana is not None:
            kh = np.where(proto_khana.astype(bool), psims, -2.0)
            kbest = int(np.argmax(kh))
            if psims[kbest] >= KHANA_FLOOR:
                pj = kbest
        second = psims[porder[1]] if porder[0] == pj else psims[porder[0]]
        margin = float(psims[pj] - second) if len(porder) > 1 else 0.0
        prototype = {
            "dish": proto_names[pj],
            "similarity": round(float(psims[pj]), 4),
            "margin": round(margin, 4),
            "fromKhana": bool(proto_khana[pj]) if proto_khana is not None else True,
            "used": False,
            "top": [
                {"dish": proto_names[k], "similarity": round(float(psims[k]), 4)}
                for k in porder[:TOP_K]
            ],
        }

    # Best image-to-text score per dish key, for corroborating the prototype.
    keymap: dict[str, float] = {}
    for i in range(len(names)):
        if is_food[i] and sims[i] > keymap.get(keys[i], -2.0):
            keymap[keys[i]] = float(sims[i])

    # Food vs. Not Food is decided only by the CURATED labels (western foods +
    # non-food) — the 7k-dish catalog is excluded here, otherwise some food
    # description always outscores the ~40 non-food labels and nothing is ever
    # "Not Food".
    gate = [i for i in order if not is_cat[i]]
    gate_best = int(gate[0]) if gate else best
    gate_is_food = bool(is_food[gate_best])

    # Top curated FOOD label, the override target for out-of-dataset foods.
    curated_food = [i for i in order if is_food[i] and not is_cat[i]]
    top_cur = int(curated_food[0]) if curated_food else gate_best

    # For food, the visual prototype names the dish UNLESS a curated western
    # label beats the prototype dish's own text score. Khana centroids are
    # trusted (high gap to override); noisy single-image Tarla anchors yield
    # easily, so out-of-dataset foods (hotdog, salmon, burger) get the right
    # western name instead of a random lookalike.
    if not gate_is_food:
        is_food_final = False
        display = "Not Food"
        display_key = ""
        source = "text"
    elif prototype is not None:
        is_food_final = True
        pk = _key(prototype["dish"])
        proto_text = keymap.get(pk, -1.0)
        gap = KHANA_OVERRIDE_GAP if prototype["fromKhana"] else TARLA_OVERRIDE_GAP
        tarla_weak = (
            not prototype["fromKhana"] and prototype["similarity"] < TARLA_TRUST
        )
        override = tarla_weak or (
            keys[top_cur] != pk and float(sims[top_cur]) - proto_text > gap
        )
        if override:
            display = names[top_cur]
            display_key = keys[top_cur]
            source = "text"
        else:
            display = prototype["dish"]
            display_key = pk
            prototype["used"] = True
            source = "prototype"
    else:
        is_food_final = True
        display = names[top_cur]
        display_key = keys[top_cur]
        source = "text"

    # Facts for the named dish, pulled from the CSV catalog when available.
    info = catalog_by_key.get(display_key)
    dish = None
    if is_food_final and info:
        dish = {
            "name": info.get("name", display),
            "course": info.get("course", ""),
            "flavor": info.get("flavor", ""),
            "diet": info.get("diet", ""),
            "region": info.get("region", ""),
            "state": info.get("state", ""),
            "ingredients": info.get("ingredients", ""),
        }

    # Catalog dishes ranked by image-to-description similarity (descriptions are
    # text, so this is a coarse semantic match, not the verdict).
    proto_keys: set = _state.get("proto_keys", set())
    cat_order = [i for i in order if is_cat[i]]

    # Closest described dishes (compact, with scores) for the panel.
    described = []
    if is_food_final:
        for i in cat_order[:TOP_K]:
            d = catalog_by_key.get(keys[i], {})
            described.append(
                {
                    "name": names[i],
                    "similarity": round(float(sims[i]), 4),
                    "course": d.get("course", ""),
                    "flavor": d.get("flavor", ""),
                    "region": d.get("region", ""),
                    "hasPhoto": keys[i] in proto_keys,
                }
            )

    # Full copyable ranking: top 254 dishes as {name: {facts}}, no scores,
    # ordered by similarity (JSON preserves insertion order).
    ranked_dishes: dict = {}
    for i in cat_order[:254]:
        d = catalog_by_key.get(keys[i], {})
        ranked_dishes[names[i]] = {
            "course": d.get("course", ""),
            "flavor": d.get("flavor", ""),
            "diet": d.get("diet", ""),
            "region": d.get("region", ""),
            "state": d.get("state", ""),
            "ingredients": d.get("ingredients", ""),
        }

    # The embedding verdict so far is the fallback. Jev (if enabled) sees the
    # image and picks the correct dish from the retrieved shortlist — or "No
    # food" — replacing the hand-tuned threshold routing when it succeeds.
    embedding_name = display
    embedding_source = source
    jev_result = None
    if jevmod.available():
        # Seed Jev's shortlist with the prototype's VISUAL top matches (accurate)
        # ahead of the noisy catalog text ranking, so the right dish is always
        # selectable even when thousands of look-alikes crowd the text ranking.
        seed: list[str] = []
        if prototype is not None:
            seed = [t["dish"] for t in prototype["top"]]
        if is_food_final and display not in seed:
            seed = [display] + seed
        candidates, seen_c = [], set()
        for nm in seed + list(ranked_dishes.keys()):
            k = nm.lower()
            if k not in seen_c:
                seen_c.add(k)
                candidates.append(nm)
        jt0 = time.time()
        jev_result = jevmod.decide(raw, candidates)
        jev_ms = round((time.time() - jt0) * 1000)
        if jev_result is not None:
            jev_result["latencyMs"] = jev_ms
            jev_result["agreesWithEmbedding"] = (
                (not jev_result["isFood"] and not is_food_final)
                or (jev_result["choice"] == embedding_name)
            )
            # When Jev is unsure (low confidence) and disagrees with a confident
            # khana prototype, trust the prototype — the 80 curated dishes are
            # the reliable core; Jev only overrides them when it's confident.
            khana_reliable = (
                prototype is not None
                and prototype.get("fromKhana")
                and prototype.get("used")
                and embedding_source == "prototype"
            )
            keep_khana = (
                khana_reliable
                and jev_result["confidence"] < JEV_MIN_CONFIDENCE
                and not jev_result["agreesWithEmbedding"]
            )
            if keep_khana:
                jev_result["overriddenByKhana"] = True
                # leave the embedding verdict (display/dish/source) untouched
            else:
                is_food_final = jev_result["isFood"]
                source = "jev"
                if is_food_final:
                    display = jev_result["choice"]
                    display_key = _key(display)
                    info = catalog_by_key.get(display_key)
                    dish = (
                        {
                            "name": info.get("name", display),
                            "course": info.get("course", ""),
                            "flavor": info.get("flavor", ""),
                            "diet": info.get("diet", ""),
                            "region": info.get("region", ""),
                            "state": info.get("state", ""),
                            "ingredients": info.get("ingredients", ""),
                        }
                        if info
                        else None
                    )
                else:
                    display = "Not Food"
                    dish = None

    return {
        "isFood": is_food_final,
        "name": display,
        "source": source,
        "embeddingName": embedding_name,
        "embeddingSource": embedding_source,
        "jev": jev_result,
        "topLabel": text_name,
        "foodProbability": round(food_prob, 4),
        "topSimilarity": round(float(sims[best]), 4),
        "top": top,
        "prototype": prototype,
        "dish": dish,
        "described": described,
        "rankedDishes": ranked_dishes,
        "metadata": {
            "model": _state.get("model_name", MODEL_NAME),
            "architecture": "EmbeddingGemma2Model",
            "device": _state["device"],
            "dtype": _state["dtype"],
            "embeddingDim": int(img_emb.shape[0]),
            "embeddingNorm": round(float(np.linalg.norm(img_emb)), 4),
            "imageTokens": 280,
            "candidateLabels": len(names),
            "catalogDishes": _state.get("catalog_count", 0),
            "dishPrototypes": len(proto_names),
            "khanaPrototypes": _state.get("khana_count", 0),
            "protoScoring": "mean-centered cosine",
            "softmaxTemperature": SOFTMAX_TEMPERATURE,
            "inferenceMs": infer_ms,
            "imageSize": {"width": pil.width, "height": pil.height},
            "uploadBytes": len(raw),
            "backend": _state.get("model_name", MODEL_NAME),
            "host": platform.platform(),
        },
    }
