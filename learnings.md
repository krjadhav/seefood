# SeeFood — Build Learnings

Technical learnings from turning the SeeFood demo (Hotdog / Not Hotdog) into a
real food recognizer backed by Google's **EmbeddingGemma 2**, then layering on
two text catalogs and thousands of image prototypes. Focus: the non-obvious
stuff, the dead-ends, and what actually worked.

---

## 1. The model is multimodal — verify the premise first

The request assumed "gemma embedding can identify the food." EmbeddingGemma's
*v1* is text-only, so the instinct was to doubt it. Reading
`google_embeddinggemma_2/config.json` + `README.md` showed **EmbeddingGemma 2**
has `vision_config` + `audio_config` and maps text, images, audio, video into
one shared **768-d** space. So image→label matching in a single space is native
— no separate vision classifier needed.

**Lesson:** read the model card/config before architecting. A 10-minute check
flipped the whole approach from "impossible" to "one embedding space."

Concrete gotchas loading it:
- Needs `transformers>=5.18` and `sentence-transformers>=6.1.0`. Both were
  available by the time we built (5.20.x).
- **`torchvision` is required** for the image path; the error is opaque
  (`EmbeddingGemma2VideoProcessor requires the Torchvision library`).
- **Use `bfloat16` or `float32`, never `float16`.** The card is explicit: fp16
  silently returns NaN / degraded embeddings because the activation range
  exceeds fp16's. We run bf16 on MPS, fp32 on CPU.
- Image embedding on an M-series MPS: ~9 s cold, ~0.3–1.5 s warm.

---

## 2. Can't run 740M params in the browser → thin FastAPI backend

The app was a static Vite/React PWA. A 740M PyTorch model can't live in the
browser, so we added a FastAPI service that loads the model once, pre-embeds the
candidate labels, and exposes `POST /api/classify`. Vite dev proxies `/api` to
it. The frontend posts the pasted image; the backend returns the verdict + a
pile of metadata.

---

## 3. Zero-shot classification via embeddings, and the cosine-cone problem

Classification = embed the image, embed candidate label texts
(`"a photo of {name}"` with the `Classification` prompt), cosine-rank. "Not
Food" falls out by including non-food labels and taking the arg-max.

**The core difficulty:** cross-modal cosine scores sit in a **very narrow
band**. Any food plate scores ~0.6–0.7 against almost any food label, and even
non-food labels land ~0.56. Raw scores are nearly useless as absolute
confidence — only *relative* ranking carries signal. This shaped every later
decision (softmax with a low temperature ~0.05 just to make displayed
probabilities readable; never trust an absolute threshold on raw cosine).

---

## 4. Image prototypes, and why raw nearest-centroid fails

To name specific dishes (not just "food"), we built **visual prototypes**: for
each dish, embed ~40 real photos, average the normalized embeddings into one
centroid, re-normalize. Classify a new photo by nearest centroid.

**This nearly didn't work.** Food-plate photos cluster in a narrow high-cosine
cone, so every centroid sits close to every other. Held-out calibration:

```
positive (image vs its own dish)    p05=0.863  p15=0.898  median=0.929
hard-neg (image vs best OTHER dish) median=0.890  p85=0.922  p95=0.937
```

Positives and *wrong-dish* negatives overlap almost completely. An absolute
threshold is meaningless (everything ~0.9).

### What fixed it: mean-centering

Subtract the **shared mean direction** of all centroids from both the image
embedding and the centroids, then re-normalize and cosine-rank. This removes the
common "food-plate" component and amplifies what's distinctive per dish.

Measured top-1 accuracy on held-out dataset images:

```
text labels ("a photo of X")  = 0.75
raw prototypes (nearest)      = 0.95
mean-centered prototypes      = 0.95   ← much larger, interpretable margins
```

Both prototype methods hit 95%, but **mean-centering spreads the scores**
(e.g. a dosa image: masala dosa 0.22 vs rava dosa 0.20 vs neer dosa 0.15 …)
which makes margins usable. Raw cosine kept everything bunched at ~0.77.

### The calibration metric was a red herring

The "hard-neg" overlap above looked fatal, but it measures *best-other-centroid*
— pessimistic, because many dishes are near-duplicates (masala/rava/neer/set
dosa). The metric that mattered was **actual top-1 arg-max accuracy**, which was
95%. Don't let a scary-looking separation stat override a direct end-task
measurement.

---

## 5. The central tension: prototype authority vs out-of-set foods

Once prototypes named *every* food image, out-of-set foods broke badly. A
**hotdog → "Pepperoni Pizza"**: the text pool correctly said "Hotdog" (0.699),
but the prototype arg-max forced it to the nearest of the known dishes and
*always won*. The user flagged exactly this. "It worked earlier" was literally
true — the first version let text decide; adding prototype authority regressed
western/out-of-set foods.

### Why thresholds alone can't route

We wanted: "use the prototype only when the image really is one of the known
dishes." No clean threshold exists. Measured (mean-centered top score / margin):

```
dosa  (in-set, correct)   score 0.220   margin 0.021
burger (out-of-set)       score 0.349   margin 0.024
```

The **correct in-set** dish (dosa) scores *lower* than a **wrong out-of-set**
match (burger), and their margins are indistinguishable. dosa's low margin comes
from many legit dosa variants competing; burger's from being genuinely
unknown. One number can't separate them.

### Dead-end: let text override the prototype

Natural idea: if the text pool strongly prefers a different dish, use text.
**It regressed in-set dishes** (biryani → "Vegetable jalfrezi", dosa → "dim
sum"). Image→text ranking over hundreds/thousands of dish descriptions is too
noisy (~0.75); the correct dish's own text label rarely tops the list. Text
can't be trusted to overrule a visual match.

### What worked: curated-label override

Split labels into **curated** (hand-picked western foods + the photo dishes,
high-signal `"a photo of X"`) and the **noisy catalog** (thousands of
descriptions). Only a **curated** label may override the prototype, and only
when it beats the prototype dish's *own text score*. This catches hotdog (a
curated western label at 0.699) without letting the catalog hijack dosa/biryani.
Comparing within the same text modality (curated-label-sim vs
prototype-dish-label-sim) keeps it apples-to-apples.

---

## 6. Scaling to a second catalog + thousands of single-image prototypes

Adding the Tarla dataset (~6969 recipes, each with a photo URL) meant two new
things: ~7k text labels and ~6464 **single-image** visual prototypes. This
surfaced three fresh regressions, each with a targeted fix.

### 6a. Non-food detection collapsed

With ~7k food descriptions in the arg-max pool, *some* food label always
outscored the ~40 non-food labels. A plain text document classified as a dessert
("Lapsi"). **Fix:** decide food-vs-Not-Food using the **curated labels only**;
the big catalog is for naming/retrieval, never for the food gate. A document
then matches "a document" (non-food) and returns Not Food.

### 6b. Single-image anchors steal in-set dishes

A single-image Tarla centroid (noisy) could beat a 40-image khana centroid.
**samosa → "Spring Rolls"**, salmon → "Asparagus Bruschetta". A per-prototype
bonus to khana was the first attempt and **failed as whack-a-mole**
(0.03 → 0.08 → 0.12 still lost: khana samosa raw ≈ 0.47 vs spring-rolls 0.62).

**Fix — two-tier, not a bonus:** prefer the best **khana** prototype whenever it
clears a floor (`KHANA_FLOOR ≈ 0.44`); only fall to Tarla anchors below that.
Khana dishes (the 80 curated, multi-image) win whenever they're a plausible
match; Tarla fills the long tail. A hard tier beat a soft bias.

### 6c. Low-confidence Tarla anchors give plausible-but-wrong names

Out-of-dataset foods landed on semantically-close Tarla anchors with *low*
visual scores (hotdog → "vegetarian hot dog" @0.47, salmon → "Asparagus
Bruschetta" @0.44), and their descriptions corroborated enough to block the
curated override. **Fix:** a Tarla anchor is only trusted to name a dish when
its visual score clears `TARLA_TRUST ≈ 0.55`; below that, defer to the curated
text name. Genuine Tarla dishes match their own photo highly, so coverage holds.

### Final layered routing (order matters)

```
1. Not Food?        -> arg-max over CURATED labels only (gate)
2. Khana prototype  -> if best khana score >= KHANA_FLOOR, name it that
3. Tarla prototype  -> else nearest overall, but only trusted if score >= TARLA_TRUST
4. Curated override -> a curated western label beats the prototype's own text
                       score (large gap for khana, ~0 for weak Tarla)
5. else             -> top curated food label
```

Result: all six showcase dishes correct, hotdog → hotdog, salmon → grilled
salmon, documents/landscapes → Not Food. burger → "fried chicken" remains
(out-of-dataset; embeddings genuinely confuse them) — acceptable via text.

**Meta-lesson:** more data is not free. The Tarla *text* was pure win
(coverage, descriptions, the ranked JSON). The Tarla *single-image prototypes*
measurably hurt and needed three guardrails to neutralize. Single-image
"prototypes" are really image-retrieval anchors — noisier than averaged
centroids, and they must not be allowed to outrank curated, multi-image
signals.

---

## 7. Name normalization

Tarla titles are pipe-and-comma stuffed SEO strings:
`"upma recipe | rava upma | sooji upma | ..."`,
`"Spring Rolls, Chinese Veg Spring Roll , Veg Spring Rolls recipe"`.
Collapse to the first clean segment: split on `|` then `,`, strip a trailing
`recipe`. `upma recipe | ...` → `upma`. Done at load so display, dedup, and
prototype↔catalog key matching all stay consistent (keys are
`[^a-z0-9]`-stripped lowercase).

---

## 8. Engineering / ops learnings

- **Deployment gotcha that bit us repeatedly:** `uvicorn` has no `--reload`, so
  code changes don't take effect until restart. The user twice saw "still
  classifies wrong" because the running process was stale. Always restart (and
  check `/api/health` counts) before concluding a fix failed. A visible health
  payload (`labels`, `catalog`, `prototypes`, `khanaPrototypes`) made "is the
  new code live?" a one-line check.
- **Startup embedding cache.** Embedding ~7k text labels every boot is slow
  (~40 s). Cache `label_emb` keyed by a SHA1 of the exact label texts; rebuild
  only when the label set changes. Re-tuning thresholds then costs a ~10 s
  restart, not 40 s.
- **Keep derived data small and committed; keep raw data local.** `.numbers`
  (8 MB) and the 6.7 GB image dirs are git-ignored; the derived
  `tarla_catalog.json` (3.9 MB) and `tarla_prototypes.npz` (float16, 12.5 MB)
  are committed so the server runs without the raw datasets. float16 halves the
  prototype matrix with no measurable quality loss here.
- **`.numbers` parsing:** use `numbers-parser` (`Document(path).sheets[0]
  .tables[0].rows(values_only=True)`); the file is a zipped protobuf bundle, not
  readable as a spreadsheet directly.
- **Batched image embedding** at `batch_size=16` ran ~0.3 s/img warm; downloads
  parallelized with a 16-thread pool, resumable via an on-disk cache keyed by
  dish, so a long build can be re-run cheaply.

---

## 9. Frontend / testing learnings

- **"Evaluating" state must survive an instant backend.** With a mocked API the
  loading state flashed too fast for Playwright to catch; add a small artificial
  delay in the route mock so the transient UI is observable.
- **Strict-mode double matches.** The dish name renders in *both* the result
  banner and the readout panel, so `getByRole('heading', {name})` matched two
  elements and failed strict mode. Scope to `.result-banner h2`.
- **Clipboard tests + the Chrome channel use the real system clipboard**, so two
  clipboard tests running in parallel raced and flaked (a different test failed
  each run). Stub `navigator.clipboard.writeText` in `addInitScript` to capture
  the copied text instead of touching the OS clipboard.
- **Headless `fullPage` screenshots can composite a ghost** of a prior paint
  (old text bled through). Verifying DOM node *counts* (`.readout` = 1,
  `.result-banner` = 1) proved the overlap was a screenshot artifact, not real
  markup. Prefer element screenshots + assertions over eyeballing fullPage.
- **Mock the backend in tests** with `page.route('**/api/classify', ...)` so the
  suite stays fast and model-free; `/api/dishes` is a GET and doesn't disturb
  the "posts exactly one request" assertion.

---

## 10. The "feel fast" animation

The evaluation animation doubles as a latency mask for the upcoming Jev step.
Learnings on making it *feel* instant:
- Show the **actual retrieved dishes** (the ranked 254), not a generic list —
  it reads as "it already found all this."
- **Density + speed sell it:** three columns scrolling at different speeds
  (one reversed), ~11px, brighter than a faint watermark, beat a single slow
  faint column.
- A **rapid count-up** ("N / 254 dishes scanned", ~600 ms via
  `requestAnimationFrame`) conveys throughput better than a static number.
- Honor `prefers-reduced-motion` (the global reset already freezes the scroll).

---

## 11. Thresholds, for reference (empirically tuned, not universal)

```
SOFTMAX_TEMPERATURE = 0.05   # display probabilities only
KHANA_FLOOR         = 0.44   # prefer multi-image khana prototype above this
TARLA_TRUST         = 0.55   # trust a single-image Tarla anchor above this
KHANA_OVERRIDE_GAP  = 0.05   # curated label must beat a khana prototype by this
TARLA_OVERRIDE_GAP  = 0.0    # weak Tarla anchors yield to curated labels easily
```

These are specific to this model, this (Indian-centric) data, and
mean-centered image-vs-centroid scores. Re-measure if any of those change.

---

## 12. We never trained anything — "accuracy" is in small derived tables

Worth stating plainly because it drives deployment: **the EmbeddingGemma 2
weights are frozen.** We did not fine-tune, and there is no "upload the datasets
to train" step. Everything we built is *precomputed embeddings + routing logic*
around an off-the-shelf model.

The runtime needs only these committed artifacts in `server/` (~16 MB total):

| artifact | size | what |
| --- | --- | --- |
| `prototypes.npz` | 246 KB | 80 khana centroids (avg of ~40 photos each) — the key accuracy artifact |
| `tarla_prototypes.npz` | 12 MB | 6464 single-image anchors (float16) |
| `dish_catalog.json` | 90 KB | CSV dishes: text + facts |
| `tarla_catalog.json` | 3.7 MB | Tarla dishes: text + ingredients + photo URL |
| `label_emb_cache.npz` | 21 MB | derived, **gitignored**, rebuilt on boot |

The 6.7 GB images and the 1.4 GB model are **build-time only**. Nothing
dataset-sized is ever uploaded to deploy. The novel retrieval improvement
(mean-centered prototypes + layered routing) is model-agnostic math on vectors.

## 13. Hosted embedding (Vertex "Gemini Embedding 2") — the provider seam

For a tiny invited trial (~10 users), self-hosting the 740M model on an
always-warm box is the wrong cost shape. The hosted **Gemini Embedding 2
(Unified Multimodal)** is the cloud sibling of local EmbeddingGemma 2 — same
unified text+image space — and bills per request.

**The hard rule (again):** every stored table lives in one model's vector space.
You cannot embed the query image with the hosted model and compare it to
prototypes built by the local model. Switching providers means **regenerating
every artifact** (`prototypes.npz`, `tarla_prototypes.npz`,
`label_emb_cache.npz`) with that provider. Don't assume even "the same" model
transfers across self-hosted vs hosted — serving/quantization differ. Regenerate,
then re-run the sample sweep.

**How we made it switchable:** `server/embed.py` defines an `Embedder` seam with
`LocalEmbedder` and `VertexEmbedder`; `SEEFOOD_EMBED_PROVIDER=local|vertex`
selects one. `main.py` and both build scripts call `embed_image` /
`embed_images` / `embed_texts` only — never the model directly. So the retrieval
and routing code is identical across providers; only the embed function changes.
The label-embedding cache signature now includes the provider name, so a
provider switch forces a safe rebuild instead of silently reusing wrong vectors.

**Architecture shift:** hosted means the service no longer loads the model. It
becomes a stateless function holding ~16 MB of tables: `image → Vertex → vector
→ our cosine + mean-center + routing → verdict`. Removes the 1.4 GB image, the
GPU/MPS box, and cold-start-from-weight-load entirely.

**Cost (280 tok/image assumption, batch build / online serve):**
- One-time artifact rebuild: ~9.6k images + ~7k labels ≈ **$0.62**, once.
- Per live classification: 280 tok × $0.45/1M ≈ **$0.00013** (~7,900 per $1).
- vs self-host: a VM is a fixed monthly cost whether used or not. At spiky
  low traffic, hosted wins on both cost and ops.

**Caveats:** it's a *preview* model (shape/limits/pricing can change — keep the
local provider as the fallback the seam already gives you); verify the real
token-per-image (the cost driver); the pasted image now leaves the device
(privacy copy must say so) and adds a network round-trip. Google's text-only
`gemini-embedding-*` can NOT replace this — we need the image+text unified model.

**Open validation item:** the exact preview request shape in
`VertexEmbedder._embed_text` / `_embed_image_bytes` must be confirmed against a
real project — those two methods are the only provider-specific code. Everything
else is verified provider-agnostic (local path still passes the full sweep).
