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
    _state.update(
        model=model,
        device=device,
        dtype=str(dtype).replace("torch.", ""),
        label_names=label_names,
        label_is_food=label_is_food,
        label_emb=label_emb,
        load_ms=round((time.time() - t0) * 1000),
    )


@app.get("/api/health")
def health() -> dict:
    return {
        "ready": "model" in _state,
        "model": MODEL_NAME,
        "device": _state.get("device"),
        "labels": len(_state.get("label_names", [])),
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
    winner_is_food = bool(is_food[best])
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

    name = names[best]
    display = name if winner_is_food else "Not Food"

    return {
        "isFood": winner_is_food,
        "name": display,
        "topLabel": name,
        "foodProbability": round(food_prob, 4),
        "topSimilarity": round(float(sims[best]), 4),
        "top": top,
        "metadata": {
            "model": MODEL_NAME,
            "architecture": "EmbeddingGemma2Model",
            "device": _state["device"],
            "dtype": _state["dtype"],
            "embeddingDim": int(img_emb.shape[0]),
            "embeddingNorm": round(float(np.linalg.norm(img_emb)), 4),
            "imageTokens": 280,
            "candidateLabels": len(names),
            "softmaxTemperature": SOFTMAX_TEMPERATURE,
            "inferenceMs": infer_ms,
            "imageSize": {"width": pil.width, "height": pil.height},
            "uploadBytes": len(raw),
            "torch": torch.__version__,
            "host": platform.platform(),
        },
    }
