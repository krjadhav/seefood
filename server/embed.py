"""Embedding provider seam.

The whole system — prototypes, catalog vectors, mean-centering, routing — is
pure math on L2-normalized vectors. It does not care *who* produced them, only
that the query image and every stored table come from the SAME model/space.

Two providers:
  - LocalEmbedder:  self-hosted EmbeddingGemma 2 via sentence-transformers.
  - VertexEmbedder: hosted "Gemini Embedding 2 (Unified Multimodal)" on Vertex.

Select with the env var SEEFOOD_EMBED_PROVIDER = local | vertex (default local).

CRITICAL: if you switch providers you MUST regenerate every artifact
(prototypes.npz, tarla_prototypes.npz, label_emb_cache.npz) with the SAME
provider — vectors from different models are not comparable. The build scripts
take --provider for exactly this.
"""
from __future__ import annotations

import io
import os
from typing import Protocol

import numpy as np


def _l2(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32)
    if v.ndim == 1:
        return v / (np.linalg.norm(v) + 1e-9)
    return v / (np.linalg.norm(v, axis=1, keepdims=True) + 1e-9)


class Embedder(Protocol):
    name: str
    device: str
    dtype: str

    def embed_image(self, pil) -> np.ndarray: ...
    def embed_texts(self, texts: list[str]) -> np.ndarray: ...


class LocalEmbedder:
    """Self-hosted EmbeddingGemma 2. Reference implementation."""

    name = "google/embeddinggemma-2 (local)"

    def __init__(self, model_dir: str):
        import torch
        from sentence_transformers import SentenceTransformer

        self.device = (
            "cuda"
            if torch.cuda.is_available()
            else "mps"
            if torch.backends.mps.is_available()
            else "cpu"
        )
        tdtype = torch.float32 if self.device == "cpu" else torch.bfloat16
        self.dtype = str(tdtype).replace("torch.", "")
        self.model = SentenceTransformer(
            model_dir, device=self.device, model_kwargs={"torch_dtype": tdtype}
        )

    def embed_image(self, pil) -> np.ndarray:
        return _l2(
            self.model.encode(
                {"image": pil}, normalize_embeddings=True, convert_to_numpy=True
            )
        )

    def embed_images(self, pils: list) -> np.ndarray:
        return _l2(
            self.model.encode(
                [{"image": p} for p in pils],
                batch_size=16,
                normalize_embeddings=True,
                convert_to_numpy=True,
            )
        )

    def embed_texts(self, texts: list[str]) -> np.ndarray:
        return _l2(
            self.model.encode(
                texts,
                prompt_name="Classification",
                normalize_embeddings=True,
                convert_to_numpy=True,
                batch_size=64,
            )
        )


class VertexEmbedder:
    """Hosted multimodal embeddings on Vertex AI.

    Uses `multimodalembedding@001` (the unified image+text model actually
    available in-project; the pricing-page "Gemini Embedding 2" was 404 here).
    Text and image embed into ONE shared space via the predict API. Dimension
    is configurable (1408 default, or 512/256/128).

    Config via env:
      GOOGLE_CLOUD_PROJECT   - GCP project id (required)
      GOOGLE_CLOUD_LOCATION  - region, default us-central1
      SEEFOOD_VERTEX_MODEL   - publisher model, default multimodalembedding@001
      SEEFOOD_EMBED_DIM      - output dim (1408 | 512 | 256 | 128), default 1408

    Auth: Application Default Credentials (ADC). All artifacts must be rebuilt
    with this provider — its space is unrelated to local EmbeddingGemma 2.
    """

    device = "vertex"
    dtype = "api"

    def __init__(self):
        from google.cloud import aiplatform_v1 as aiv1

        self.project = os.environ["GOOGLE_CLOUD_PROJECT"]
        self.location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
        self.model = os.environ.get("SEEFOOD_VERTEX_MODEL", "multimodalembedding@001")
        self.dim = int(os.environ.get("SEEFOOD_EMBED_DIM", "1408"))
        self.workers = int(os.environ.get("SEEFOOD_VERTEX_WORKERS", "8"))
        self.name = f"{self.model} d{self.dim} (vertex)"
        self._client = aiv1.PredictionServiceClient(
            client_options={"api_endpoint": f"{self.location}-aiplatform.googleapis.com"}
        )
        self._endpoint = (
            f"projects/{self.project}/locations/{self.location}"
            f"/publishers/google/models/{self.model}"
        )

    def _predict(self, instance: dict) -> dict:
        import random
        import time

        from google.api_core.exceptions import ResourceExhausted, ServiceUnavailable
        from google.protobuf import struct_pb2
        from google.protobuf.json_format import ParseDict

        inst = ParseDict(instance, struct_pb2.Value())
        params = ParseDict({"dimension": self.dim}, struct_pb2.Value())
        # Vertex online-prediction quota is low; back off on 429/503.
        delay = 1.0
        for attempt in range(8):
            try:
                resp = self._client.predict(
                    endpoint=self._endpoint, instances=[inst], parameters=params
                )
                return dict(resp.predictions[0])
            except (ResourceExhausted, ServiceUnavailable):
                if attempt == 7:
                    raise
                time.sleep(delay + random.random())
                delay = min(delay * 2, 30)
        raise RuntimeError("unreachable")

    def _jpeg_b64(self, pil) -> str:
        import base64

        buf = io.BytesIO()
        pil.convert("RGB").save(buf, format="JPEG", quality=90)
        return base64.b64encode(buf.getvalue()).decode()

    def embed_image(self, pil) -> np.ndarray:
        pred = self._predict({"image": {"bytesBase64Encoded": self._jpeg_b64(pil)}})
        return _l2(np.asarray(pred["imageEmbedding"], dtype=np.float32))

    def _embed_text_one(self, text: str) -> np.ndarray:
        pred = self._predict({"text": text[:1024]})
        return np.asarray(pred["textEmbedding"], dtype=np.float32)

    def embed_images(self, pils: list) -> np.ndarray:
        # One instance per request; parallelize to make bulk builds tractable.
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            vecs = list(pool.map(self.embed_image, pils))
        return _l2(np.vstack(vecs))

    def embed_texts(self, texts: list[str]) -> np.ndarray:
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            vecs = list(pool.map(self._embed_text_one, texts))
        return _l2(np.vstack(vecs))


def get_embedder(model_dir: str) -> Embedder:
    provider = os.environ.get("SEEFOOD_EMBED_PROVIDER", "local").lower()
    if provider == "vertex":
        return VertexEmbedder()
    return LocalEmbedder(model_dir)
