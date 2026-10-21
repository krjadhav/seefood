# SeeFood recognition backend

A small FastAPI service that runs **EmbeddingGemma 2** (from
`../google_embeddinggemma_2`) for zero-shot food recognition.

## How it works

1. On startup it loads the model and pre-embeds a list of food and non-food
   labels (`labels.py`).
2. `POST /api/classify` embeds the uploaded image into the same 768-d space.
3. It cosine-ranks the labels against the image. If the top match is a food
   label, that food name is returned; otherwise the result is `Not Food`.
4. The response includes rich metadata (scores, timing, embedding norm, device,
   dtype, image tokens) that the frontend shows alongside the result.

The model is multimodal, so the image and the text labels share one embedding
space — no separate vision classifier is needed.

## Run

```sh
pip install -r server/requirements.txt
uvicorn main:app --app-dir server --port 8000
```

First request is slow (cold model); subsequent ones are faster. CPU works;
CUDA/MPS are used automatically when available.

Endpoints:

- `GET  /api/health` — readiness, device, label count.
- `POST /api/classify` — multipart `image` field, returns the verdict + metadata.
