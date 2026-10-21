"""Integrate the Tarla Dalal recipe dataset (.numbers) into SeeFood.

Phases (run all by default):
  1. catalog  -> tarla_catalog.json  (name, key, ingredients, image, text)
  2. download -> cache photos locally (resumable)
  3. embed    -> tarla_prototypes.npz (one single-image centroid per dish)

Usage:
    python server/build_tarla.py                 # all phases
    python server/build_tarla.py --catalog-only
    python server/build_tarla.py --limit 1500    # cap downloaded images
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NUMBERS = ROOT / "indian_food_dataset_3" / "all_indian_recipes_tarla.numbers"
HERE = Path(__file__).resolve().parent
CATALOG_OUT = HERE / "tarla_catalog.json"
PROTO_OUT = HERE / "tarla_prototypes.npz"
IMG_CACHE = ROOT / "indian_food_dataset_3" / "images"  # gitignored


def key_of(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def main_name(raw: str | None) -> str:
    """First pipe segment, with a trailing 'recipe' removed. 'upma recipe |
    rava upma | ...' -> 'upma'."""
    if not raw:
        return ""
    first = raw.split("|")[0]
    first = re.sub(r"\brecipe\b", "", first, flags=re.I)
    return re.sub(r"\s+", " ", first).strip()


def ingredient_str(row: dict) -> str:
    for col in ("cleaned_ingredients_list", "ingredients_list"):
        val = row.get(col)
        if not val:
            continue
        try:
            items = ast.literal_eval(val)
        except Exception:
            continue
        items = [str(x).strip() for x in items if str(x).strip()]
        # de-dup preserving order, cap length
        seen, out = set(), []
        for it in items:
            lk = it.lower()
            if lk not in seen:
                seen.add(lk)
                out.append(it)
            if len(out) >= 20:
                break
        if out:
            return ", ".join(out)
    return (row.get("ingredients_str") or "").strip()


def read_rows() -> list[dict]:
    from numbers_parser import Document

    rows = Document(str(NUMBERS)).sheets[0].tables[0].rows(values_only=True)
    header = rows[0]
    return [dict(zip(header, r)) for r in rows[1:]]


def build_catalog() -> list[dict]:
    dishes, seen = [], set()
    for row in read_rows():
        name = main_name(row.get("name"))
        if not name:
            continue
        k = key_of(name)
        if k in seen:
            continue
        seen.add(k)
        ingredients = ingredient_str(row)
        image = row.get("image") or ""
        image = image if str(image).startswith("http") else ""
        text = f"{name}: made with {ingredients}" if ingredients else name
        dishes.append(
            {
                "name": name,
                "key": k,
                "ingredients": ingredients,
                "image": image,
                "text": text,
            }
        )
    CATALOG_OUT.write_text(json.dumps(dishes, ensure_ascii=False))
    size_mb = CATALOG_OUT.stat().st_size / 1e6
    print(f"catalog: {len(dishes)} dishes -> {CATALOG_OUT.name} ({size_mb:.1f} MB)")
    return dishes


def download(dishes: list[dict], limit: int | None) -> list[dict]:
    IMG_CACHE.mkdir(parents=True, exist_ok=True)
    targets = [d for d in dishes if d["image"]]
    if limit:
        targets = targets[:limit]

    def fetch(d: dict) -> tuple[str, bool]:
        dest = IMG_CACHE / f"{d['key']}.img"
        if dest.exists() and dest.stat().st_size > 0:
            return d["key"], True
        try:
            req = urllib.request.Request(d["image"], headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=20) as r:
                data = r.read()
            if len(data) < 500:
                return d["key"], False
            dest.write_bytes(data)
            return d["key"], True
        except Exception:
            return d["key"], False

    ok = 0
    with ThreadPoolExecutor(max_workers=16) as pool:
        for i, (k, good) in enumerate(pool.map(fetch, targets)):
            ok += good
            if (i + 1) % 250 == 0:
                print(f"  downloaded {i + 1}/{len(targets)} (ok={ok})", flush=True)
    print(f"download: {ok}/{len(targets)} images in {IMG_CACHE}")
    return targets


def embed(dishes: list[dict], limit: int | None) -> None:
    import numpy as np
    from PIL import Image

    from embed import get_embedder

    # Skip dishes that already have a strong multi-image khana prototype.
    khana = set()
    if (HERE / "prototypes.npz").exists():
        z = np.load(HERE / "prototypes.npz", allow_pickle=True)
        khana = {key_of(str(n)) for n in z["names"]}

    targets = [d for d in dishes if d["image"] and d["key"] not in khana]
    if limit:
        targets = targets[:limit]

    embedder = get_embedder(str(ROOT / "google_embeddinggemma_2"))

    names, vecs = [], []
    batch_imgs, batch_names = [], []

    def flush() -> None:
        if not batch_imgs:
            return
        emb = embedder.embed_images(batch_imgs)
        vecs.append(emb.astype(np.float16))
        names.extend(batch_names)
        batch_imgs.clear()
        batch_names.clear()

    done = 0
    for d in targets:
        p = IMG_CACHE / f"{d['key']}.img"
        if not p.exists():
            continue
        try:
            batch_imgs.append(Image.open(p).convert("RGB"))
            batch_names.append(d["name"])
        except Exception:
            continue
        if len(batch_imgs) >= 16:
            flush()
            done += 16
            if done % 800 == 0:
                print(f"  embedded {done}/{len(targets)}", flush=True)
    flush()

    mat = np.vstack(vecs) if vecs else np.zeros((0, 768), np.float16)
    np.savez(PROTO_OUT, names=np.array(names), centroids=mat)
    size_mb = PROTO_OUT.stat().st_size / 1e6
    print(f"embed: {len(names)} single-image prototypes -> {PROTO_OUT.name} ({size_mb:.1f} MB)")


def run() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog-only", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    dishes = build_catalog()
    if args.catalog_only:
        return
    download(dishes, args.limit)
    embed(dishes, args.limit)


if __name__ == "__main__":
    run()
