"""SeeFood recognition backend.

Loads EmbeddingGemma 2 once, pre-embeds the candidate food / non-food labels,
and exposes POST /api/classify. For a posted image it returns the top food
name (or "Not Food"), plus a pile of metadata the frontend renders on the side.
"""
from __future__ import annotations

import io
import math
import platform
import time
from pathlib import Path

import numpy as np
import torch
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from sentence_transformers import SentenceTransformer

from labels import ALL_LABELS

MODEL_DIR = str(Path(__file__).resolve().parent.parent / "google_embeddinggemma_2")
PROTO_PATH = Path(__file__).resolve().parent / "prototypes.npz"
MODEL_NAME = "google/embeddinggemma-2"
# Cross-modal cosine scores sit in a narrow band, so sharpen with a low
# temperature before softmax to make the displayed confidences readable.
SOFTMAX_TEMPERATURE = 0.05
TOP_K = 8

app = FastAPI(title="SeeFood recognition")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_state: dict = {}


@app.on_event("startup")
def load_model() -> None:
    device = (
        "cuda"
        if torch.cuda.is_available()
        else "mps"
        if torch.backends.mps.is_available()
        else "cpu"
    )
    dtype = torch.float32 if device == "cpu" else torch.bfloat16
    t0 = time.time()
    model = SentenceTransformer(
        MODEL_DIR, device=device, model_kwargs={"torch_dtype": dtype}
    )
    label_names = [name for name, _ in ALL_LABELS]
    label_is_food = [is_food for _, is_food in ALL_LABELS]
    label_emb = model.encode(
        [f"a photo of {name}" for name in label_names],
        prompt_name="Classification",
        normalize_embeddings=True,
        convert_to_numpy=True,
    )
    # Food-plate photos cluster in a narrow high-cosine cone, so raw
    # nearest-centroid barely separates dishes. Subtracting the shared mean
    # direction (mean-centering) amplifies the distinctive part of each
    # prototype and sharply improves dish discrimination.
    proto_names, proto_cent, proto_mean = [], None, None
    if PROTO_PATH.exists():
        data = np.load(PROTO_PATH, allow_pickle=True)
        proto_names = [str(n) for n in data["names"]]
        raw = data["centroids"].astype(np.float32)
        proto_mean = raw.mean(axis=0)
        proto_mean /= np.linalg.norm(proto_mean) + 1e-9
        centered = raw - raw.mean(axis=0, keepdims=True)
        centered /= np.linalg.norm(centered, axis=1, keepdims=True) + 1e-9
        proto_cent = centered
    _state.update(
        model=model,
        device=device,
        dtype=str(dtype).replace("torch.", ""),
        label_names=label_names,
        label_is_food=label_is_food,
        label_emb=label_emb,
        proto_names=proto_names,
        proto_cent=proto_cent,
        proto_mean=proto_mean,
        load_ms=round((time.time() - t0) * 1000),
    )


@app.get("/api/health")
def health() -> dict:
    return {
        "ready": "model" in _state,
        "model": MODEL_NAME,
        "device": _state.get("device"),
        "labels": len(_state.get("label_names", [])),
        "prototypes": len(_state.get("proto_names", [])),
        "load_ms": _state.get("load_ms"),
    }


@app.post("/api/classify")
async def classify(image: UploadFile = File(...)) -> dict:
    if "model" not in _state:
        raise HTTPException(503, "Model is still loading, try again in a moment.")
    raw = await image.read()
    try:
        pil = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        raise HTTPException(400, "Could not decode that image.")

    model: SentenceTransformer = _state["model"]
    t0 = time.time()
    img_emb = model.encode(
        {"image": pil}, normalize_embeddings=True, convert_to_numpy=True
    )
    infer_ms = round((time.time() - t0) * 1000)

    label_emb: np.ndarray = _state["label_emb"]
    names: list[str] = _state["label_names"]
    is_food: list[bool] = _state["label_is_food"]

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
    prototype = None
    if proto_cent is not None and len(proto_cent):
        vc = img_emb - proto_mean
        vc = vc / (np.linalg.norm(vc) + 1e-9)
        psims = proto_cent @ vc
        porder = np.argsort(-psims)
        pj = int(porder[0])
        margin = float(psims[porder[0]] - psims[porder[1]]) if len(porder) > 1 else 0.0
        prototype = {
            "dish": proto_names[pj],
            "similarity": round(float(psims[pj]), 4),
            "margin": round(margin, 4),
            "used": False,
            "top": [
                {"dish": proto_names[k], "similarity": round(float(psims[k]), 4)}
                for k in porder[:TOP_K]
            ],
        }

    # The text pool (image-to-text, well-calibrated) decides food vs. Not Food.
    # For food, the visual prototype names the specific dish.
    if not text_is_food:
        is_food_final = False
        display = "Not Food"
        source = "text"
    elif prototype is not None:
        is_food_final = True
        display = prototype["dish"]
        prototype["used"] = True
        source = "prototype"
    else:
        is_food_final = True
        display = text_name
        source = "text"

    return {
        "isFood": is_food_final,
        "name": display,
        "source": source,
        "topLabel": text_name,
        "foodProbability": round(food_prob, 4),
        "topSimilarity": round(float(sims[best]), 4),
        "top": top,
        "prototype": prototype,
        "metadata": {
            "model": MODEL_NAME,
            "architecture": "EmbeddingGemma2Model",
            "device": _state["device"],
            "dtype": _state["dtype"],
            "embeddingDim": int(img_emb.shape[0]),
            "embeddingNorm": round(float(np.linalg.norm(img_emb)), 4),
            "imageTokens": 280,
            "candidateLabels": len(names),
            "dishPrototypes": len(proto_names),
            "protoScoring": "mean-centered cosine",
            "softmaxTemperature": SOFTMAX_TEMPERATURE,
            "inferenceMs": infer_ms,
            "imageSize": {"width": pil.width, "height": pil.height},
            "uploadBytes": len(raw),
            "torch": torch.__version__,
            "host": platform.platform(),
        },
    }
