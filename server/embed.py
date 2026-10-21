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
    """Hosted Gemini Embedding 2 (Unified Multimodal) on Vertex AI.

    Config via env:
      GOOGLE_CLOUD_PROJECT   - GCP project id
      GOOGLE_CLOUD_LOCATION  - region, e.g. us-central1 (default)
      SEEFOOD_VERTEX_MODEL   - model id for the unified multimodal embedding
      SEEFOOD_EMBED_DIM      - output dimension (e.g. 768) to match prototypes

    NOTE: the exact preview request shape must be validated against your project
    once access is available — the two `_embed_*` calls below are the ONLY spots
    to adjust. Everything else (normalization, batching, routing) is provider-
    agnostic. Auth uses Application Default Credentials (ADC).
    """

    name = "gemini-embedding-2 (vertex)"
    device = "vertex"
    dtype = "api"

    def __init__(self):
        self.project = os.environ["GOOGLE_CLOUD_PROJECT"]
        self.location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
        self.model = os.environ.get("SEEFOOD_VERTEX_MODEL", "gemini-embedding-2")
        self.dim = int(os.environ.get("SEEFOOD_EMBED_DIM", "768"))
        # Lazy import so the local path never needs the SDK installed.
        from google import genai

        self._client = genai.Client(
            vertexai=True, project=self.project, location=self.location
        )

    # --- the two calls to validate against the preview API ------------------
    def _embed_text(self, text: str) -> np.ndarray:
        from google.genai import types

        resp = self._client.models.embed_content(
            model=self.model,
            contents=text,
            config=types.EmbedContentConfig(output_dimensionality=self.dim),
        )
        return np.asarray(resp.embeddings[0].values, dtype=np.float32)

    def _embed_image_bytes(self, data: bytes, mime: str = "image/jpeg") -> np.ndarray:
        from google.genai import types

        resp = self._client.models.embed_content(
            model=self.model,
            contents=types.Part.from_bytes(data=data, mime_type=mime),
            config=types.EmbedContentConfig(output_dimensionality=self.dim),
        )
        return np.asarray(resp.embeddings[0].values, dtype=np.float32)

    # --- public, provider-agnostic surface ---------------------------------
    def embed_image(self, pil) -> np.ndarray:
        buf = io.BytesIO()
        pil.convert("RGB").save(buf, format="JPEG", quality=90)
        return _l2(self._embed_image_bytes(buf.getvalue()))

    def embed_images(self, pils: list) -> np.ndarray:
        return _l2(np.vstack([self.embed_image(p) for p in pils]))

    def embed_texts(self, texts: list[str]) -> np.ndarray:
        return _l2(np.vstack([self._embed_text(t) for t in texts]))


def get_embedder(model_dir: str) -> Embedder:
    provider = os.environ.get("SEEFOOD_EMBED_PROVIDER", "local").lower()
    if provider == "vertex":
        return VertexEmbedder()
    return LocalEmbedder(model_dir)
