# SeeFood recognition backend

A small FastAPI service that runs **EmbeddingGemma 2** (from
`../google_embeddinggemma_2`) for zero-shot food recognition.

## How it works

1. On startup it loads the model, pre-embeds food + non-food **text labels**
   (`labels.py`, including the 79 Indian dishes), and loads the **dish photo
   prototypes** from `prototypes.npz` if present.
2. `POST /api/classify` embeds the uploaded image into the same 768-d space.
3. The text pool (image-to-text cosine, well-calibrated) decides **food vs.
   Not Food**. If it's food, a confident **visual prototype** match
   (image-to-image cosine ≥ `PROTO_THRESHOLD`) refines the dish *name*;
   otherwise the text label name is used.
4. The response includes the prototype match, top label scores, and metadata
   (timing, embedding norm, device, dtype, image tokens, prototype count).

The model is multimodal, so images and text labels share one embedding space —
no separate vision classifier is needed.

## Dish catalog (CSV)

`dish_catalog.json` is built from `indian_food_dataset_2/indian_food.csv` and
adds ~255 dishes — many with no photos — as rich text labels
(`"Balu shahi: a sweet vegetarian dessert from East India made with…"`). It is
used two ways, without changing the prototype verdict:

- **Dish info:** facts (course, flavor, diet, region, ingredients) for the
  named dish.
- **Closest described dishes:** the image ranked against the CSV descriptions,
  surfacing the long tail (incl. dishes with no prototype).

Rebuild after editing the CSV:

```sh
python server/build_catalog.py
```

## Dish prototypes

`prototypes.npz` holds one averaged "visual centroid" per dish, built from the
`indian_food_dataset/` photos. The dataset (~6.7 GB) is not committed; the
derived `.npz` (79 × 768 floats) is. Rebuild it after changing the dish set:

```sh
python server/build_prototypes.py --k 40
```

It samples K photos per dish, embeds them, averages and re-normalizes, and
prints a suggested `PROTO_THRESHOLD` from a held-out split.

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
