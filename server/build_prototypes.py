"""Precompute per-dish visual centroids from the Indian food dataset.

For each dish it embeds a sample of real photos, averages the (normalized)
embeddings into one prototype vector, and caches all prototypes to
`prototypes.npz`. The committed .npz is tiny (79 x 768 floats), so the running
server never needs the multi-GB image dataset.

Usage:
    python server/build_prototypes.py [--k 40]
"""
from __future__ import annotations

import argparse
import os
import random
from pathlib import Path

import numpy as np
from PIL import Image

from embed import get_embedder

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = str(ROOT / "google_embeddinggemma_2")
DATASET = ROOT / "datasets" / "indian_food_dataset"
OUT = Path(__file__).resolve().parent / "prototypes.npz"
HOLDOUT = 5  # images per dish reserved for threshold calibration


def embed_images(embedder, paths, batch_size):
    out = []
    for start in range(0, len(paths), batch_size):
        chunk = paths[start : start + batch_size]
        imgs = []
        for p in chunk:
            try:
                imgs.append(Image.open(p).convert("RGB"))
            except Exception:
                continue
        if not imgs:
            continue
        out.append(embedder.embed_images(imgs))
    if not out:
        return np.zeros((0, 768), dtype=np.float32)
    return np.vstack(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--k", type=int, default=40, help="images per dish")
    ap.add_argument("--batch", type=int, default=16)
    args = ap.parse_args()
    random.seed(1234)

    embedder = get_embedder(MODEL_DIR)
    dishes = [
        line.strip()
        for line in (DATASET / "labels.txt").read_text().splitlines()
        if line.strip()
    ]
    print(f"{len(dishes)} dishes, k={args.k}, provider={embedder.name}")

    names, centroids = [], []
    pos_sims, neg_pool = [], []  # calibration
    holdout_vecs = {}

    for i, dish in enumerate(dishes):
        folder = DATASET / "khana" / dish
        files = [folder / f for f in os.listdir(folder)]
        random.shuffle(files)
        train = files[: args.k]
        held = files[args.k : args.k + HOLDOUT]
        emb = embed_images(embedder, train, args.batch)
        if len(emb) == 0:
            print(f"  !! {dish}: no usable images, skipping")
            continue
        centroid = emb.mean(axis=0)
        centroid /= np.linalg.norm(centroid) + 1e-9
        names.append(dish)
        centroids.append(centroid.astype(np.float32))
        if held:
            hv = embed_images(embedder, held, args.batch)
            if len(hv):
                holdout_vecs[dish] = hv
        print(f"  [{i + 1}/{len(dishes)}] {dish}: {len(emb)} imgs")

    centroids = np.vstack(centroids)
    np.savez(OUT, names=np.array(names), centroids=centroids)
    print(f"saved {OUT} with {len(names)} prototypes, shape {centroids.shape}")

    # Calibration: held-out image vs its own centroid (positive) and its best
    # *other* centroid (hard negative), to suggest a prototype threshold.
    idx = {n: j for j, n in enumerate(names)}
    for dish, hv in holdout_vecs.items():
        j = idx[dish]
        sims = hv @ centroids.T  # (held, dishes)
        pos_sims.extend(sims[:, j].tolist())
        other = sims.copy()
        other[:, j] = -1
        neg_pool.extend(other.max(axis=1).tolist())
    if pos_sims:
        p = np.array(pos_sims)
        n = np.array(neg_pool)
        print("\n--- calibration (held-out) ---")
        print(
            "positive (own dish)  p05=%.3f p15=%.3f median=%.3f"
            % (np.percentile(p, 5), np.percentile(p, 15), np.median(p))
        )
        print(
            "hard-neg (other dish) median=%.3f p85=%.3f p95=%.3f"
            % (np.median(n), np.percentile(n, 85), np.percentile(n, 95))
        )
        print("suggested PROTO_THRESHOLD ~= %.3f" % float(np.percentile(p, 15)))


if __name__ == "__main__":
    main()
