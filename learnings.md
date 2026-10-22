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

**Open validation item (RESOLVED — see §14):** the preview request shape was
confirmed against a real project. The outcome was not what the pricing page
implied: the "Gemini Embedding 2 (Unified Multimodal)" id 404'd in-project; the
model that actually serves is `multimodalembedding@001` at **1408 dims**, via a
different SDK. Details, API shape, and the knock-on artifact rebuild are in §14.

---

## 14. Vertex multimodal embedding — what the preview actually was

The §13 seam was built blind against the pricing-page name. Validating it in a
real GCP project corrected several assumptions:

- **The model id was wrong.** `gemini-embedding-2` / "Gemini Embedding 2
  (Unified Multimodal)" returned 404 in-project. The unified image+text model
  that is actually callable is **`multimodalembedding@001`**. Lesson: a model on
  the pricing/marketing page is not proof it's enabled for your project — probe
  `publishers/google/models/*` before coding to a name.
- **The SDK was wrong.** `google-genai` (`genai.Client(vertexai=True)
  .models.embed_content`) is the Gemini-API surface; `multimodalembedding@001`
  is a classic Vertex *prediction* model. Call it with
  `google-cloud-aiplatform` → `aiplatform_v1.PredictionServiceClient.predict`
  against `projects/{p}/locations/{l}/publishers/google/models/
  multimodalembedding@001`. Instances are `{"image": {"bytesBase64Encoded": …}}`
  or `{"text": …}`; params `{"dimension": D}`; response fields `imageEmbedding`
  / `textEmbedding`. Requirements change: drop `google-genai`, add
  `google-cloud-aiplatform>=1.40.0`.
- **The dimension was wrong (1408, not 768).** Default output is **1408-d**
  (configurable 512/256/128), unrelated to local EmbeddingGemma 2's 768-d space.
  So the §13 "regenerate every artifact" rule bit twice over: different provider
  *and* different dimensionality. `prototypes.npz` was rebuilt at `(80, 1408)`.
  A vector-length mismatch is the cheap tripwire that catches a stale artifact.
- **No batch endpoint; quota is low.** Online prediction takes one instance per
  request, so bulk artifact builds must fan out — a `ThreadPoolExecutor`
  (`SEEFOOD_VERTEX_WORKERS`, default 8) over per-image calls. The online quota is
  small, so wrap `predict` in exponential backoff on `ResourceExhausted` (429) /
  `ServiceUnavailable` (503). Without the backoff a bulk build dies partway.
- **Model name is now self-describing at runtime.** `self.name =
  f"{model} d{dim} (vertex)"` surfaces the provider+dim in the health/metadata
  payload, so "which space are these artifacts in?" is answerable without
  reading code.

The provider seam itself held up: only `embed.py` changed; `main.py` and the
build scripts were untouched. The abstraction paid off exactly where §13
predicted it would.

---

## 15. Stripping the demo instrumentation — and the test coupling it exposed

The build accreted dev/demo scaffolding (the "feel fast" animation from §10, a
model-metadata readout, the ranked-JSON panel). Taking the app toward a clean
end-user surface meant removing most of it, which taught a testing lesson.

- **The artificial latency mask became latency, not a mask.** The 3 s
  `RETRIEVED_HOLD_MS` hold (and its "N / 254 dishes scanned" count-up) existed to
  cover a *future* Jev step that isn't wired yet. With nothing behind it, it was
  pure dead wait — reveal the verdict as soon as `/api/classify` returns. Don't
  ship a latency mask for latency that doesn't exist yet; add it back with the
  step it's masking.
- **E2E tests must assert the user contract, not dev instrumentation.** Several
  Playwright tests asserted deep into the debug readout — exact model id
  (`google/embeddinggemma-2`), `80 khana`, `12 ms`, the `Copy JSON` button,
  `.readout-tag`. Hiding those panels broke ~6 assertions across multiple tests
  and forced edits in lockstep with a cosmetic change. Assertions belong on the
  durable surface (`.result-banner h2`, the samples row, the Evaluating
  heading); let internal/dev panels stay untested so UI cleanup stays cheap.
- **Removing a rendered branch resolved an earlier "learning."** §9's
  strict-mode double-match (dish name in *both* banner and readout) is now moot —
  the readout is gone, so the name renders once. A workaround that only existed
  to cope with dev UI disappeared with the dev UI.
- **Dead helpers fall out with the branch.** Deleting the readout orphaned
  `copyRanked`, the `copied` state, and the `Copy` import. The build is
  `tsc -b` with no `noUnusedLocals`, so unused code would *not* fail the
  build or deploy — worth removing by hand for hygiene, but don't count on the
  compiler to flag it here.

---

## 16. Background imagery ≠ sample buttons (a small UI taxonomy)

The welcome screen has two unrelated image sets that are easy to conflate when a
request says "change the first image":

- the **welcome-screen background** (`.food-background`, two full-bleed photos
  behind the hero copy — e.g. salmon over pasta), and
- the **sample buttons** (`samples[]`, the tappable "Try a sample" row that runs
  a real classification).

A request to swap "the first image" was initially mis-applied to the background
when it meant the first *sample*. Lesson: these live in different code (`<img>`
in the hero vs the `samples` array) and serve different roles — confirm which
set before editing. The sample buttons are functional (they call the
classifier); the background is pure decoration.

### Make the primary action look like a button

The mobile entry point was a text prompt ("Scan food to get started") plus a
secondary "Upload image" button — the real action (open camera) read as a label,
not a control. Replacing it with a single prominent circular camera button (red
fill, white border, large tap target) and a caption below made the primary
action obviously tappable. Keep the hidden `capture="environment"` file input
and the `aria-label` intact so the native camera still fires and the existing
`getByRole('button', { name: 'Scan food' })` test keeps passing — restyle the
affordance without renaming its accessible contract.

---

## 17. Deploying it — Pages custom domain + thin Cloud Run on Vertex

Shipping the hosted-embedding build (PWA on GitHub Pages, API on Cloud Run
calling Vertex) surfaced a pile of deploy-specific gotchas, most of them the kind
you only hit once.

### Frontend / GitHub Pages

- **Relative `/api` silently breaks on a static host.** In dev the Vite proxy
  makes `fetch('/api/classify')` work; on Pages it resolves to
  `https://<domain>/api/...` which 404s. The deployed PWA must call an
  **absolute** backend URL. Added `API_BASE` from a build-time
  `VITE_API_BASE_URL` (empty in dev so the proxy still applies), injected via the
  Pages workflow's `env:`. The API URL is config, not a secret.
- **The `CNAME` file alone did not register the custom domain.** Deploying via
  the Actions artifact with a `public/CNAME` left the Pages `cname` field `None`.
  Had to set it with `gh api -X PUT repos/<r>/pages -f cname=<domain>`. Keep both
  (the file *and* the API setting).
- **Can't enforce HTTPS before the cert exists.** `-F https_enforced=true`
  returns `404 "The certificate does not exist yet"`. Sequence is: set `cname`
  → GitHub provisions the TLS cert async (`authorization_pending` →
  `approved`, minutes) → *then* `https_enforced=true`. The site serves over
  HTTP the whole time, so don't block on it.
- **Mixed content runs the right way here.** HTTP page → HTTPS Cloud Run API is
  allowed; only HTTPS→HTTP is blocked. So testing worked even before the Pages
  cert landed.

### Backend / Cloud Run + Vertex

- **Billing must be enabled before *any* Vertex call.** Every embed 403'd with
  `"This API method requires billing to be enabled"` until the project was linked
  to an open billing account (`gcloud billing projects link`). "API enabled" ≠
  "billing enabled" — both are required, and the error names the wrong-looking
  cause (permission) for a billing problem.
- **The thin image can't import the model stack.** The Vertex service runs on
  `requirements-vertex.txt` (no torch/transformers). `main.py` still had
  top-level `import torch` / `from sentence_transformers import …` left over from
  the local path — they crash the thin container at import. Move all heavy
  imports *inside* the provider classes (`LocalEmbedder.__init__`) so the thin
  build never touches them; the only top-level casualty was a `torch.__version__`
  metadata field, swapped for a provider-agnostic `backend` string.
- **Bake the label cache; don't rebuild it on cold start.** Boot rebuilds
  `label_emb_cache.npz` by embedding every label — on Vertex that's thousands of
  API calls *per cold start*, which trips the low online quota (§14) and makes
  cold starts minutes long and flaky. Precompute the cache, ship it in the image,
  and the container boots in ~4.4 s doing zero Vertex calls (only the per-request
  image embed hits the API). Cold start with no model weights is seconds, not the
  minutes a self-hosted model would cost.
- **`.gcloudignore` overrides `.gitignore` for the upload — use it to *include*
  a gitignored artifact.** `gcloud run deploy --source` falls back to
  `.gitignore`, which excludes the (intentionally untracked) label cache. Without
  a `.gcloudignore` the cache never reaches the build context and the bake above
  silently doesn't happen. Add a `.gcloudignore` that drops the heavy dirs but
  keeps `server/label_emb_cache.npz`. (Separately, `.dockerignore` controls what
  `COPY` sees — both must agree.)
- **Partial deploys via ignore files.** To ship the validated khana-only bundle
  while the full Tarla parity was still embedding in the background, the
  `.dockerignore`/`.gcloudignore` simply exclude `tarla_*`. The container then
  loads 80 prototypes + the CSV catalog; its label set matches the baked cache's
  signature, so no rebuild. Re-including Tarla is an ignore-file edit + redeploy.
- **Runtime auth needs no key.** Grant the Cloud Run **runtime service account**
  (`<projectNumber>-compute@…`) `roles/aiplatform.user`; the
  `google-cloud-aiplatform` client picks up ADC from the metadata server. No
  service-account JSON to mount or leak.
- **`--source` deploy is one command, no local Docker.** `gcloud run deploy
  seefood-api --source .` runs Cloud Build (upload → build → push → deploy),
  auto-creates the Artifact Registry repo, and prints the service URL. Fine for a
  solo deploy; the CI path would push to Artifact Registry explicitly.

### Security posture (flagged, not yet fixed)

The service is `--allow-unauthenticated` with CORS `*` — anyone with the URL can
call it and bill the project's Vertex. Acceptable for a short invited test with
`max-instances` capping blast radius, but **token auth + CORS pinned to the
domain are the gate before wider sharing** (the deployment plan's Phase 3). Don't
post the Cloud Run URL publicly.

### Artifact hygiene across a provider migration

Juggling local-space vs Vertex-space artifacts (backing up the local `.npz` to a
`_local_space/` dir, overwriting `prototypes.npz` in place, a second person
committing in parallel) made it genuinely hard to answer "which space is the
committed artifact in?" The durable guards: the **vector-length tripwire**
(768 vs 1408 fails loudly) and the **provider-tagged cache signature** (§13–14).
The softer lesson — name migrated artifacts by space (`prototypes.vertex1408.npz`)
and let the running deploy read from the build context, not from whatever git
state happens to be checked out.

---

## 18. TypeSafe Jev as the decision stage — and reading an SDK over its docs

The hand-tuned threshold routing (§5–6, §11) was always brittle: every new
dataset forced a re-tune. Jev (TypeSafe's System One model) replaces it. The
embedding does **retrieval** (ranks the catalog into a shortlist); Jev makes the
**decision**.

- **The docs lagged the SDK; the SDK was the source of truth.** The public docs
  said state is text-only and showed no image path. The installed `typesafe-sdk`
  exposed `system_one(..., assets={name: Image})` and `Image.from_pil`. Reading
  the package (`inspect.signature`, the `response_types`/`assets` modules)
  revealed the real contract: Jev **can take the image as an asset** and is a
  genuine multimodal decider, not a text-only reranker. When docs and installed
  code disagree, trust the code — but gate it (below).
- **Image input is experimental, behind a header.** The first call failed with
  `400 Images are experimental. Send TypeSafe-Danger-Zone-Images: true`. Preview
  features are often one header away and one release from changing — so they sit
  behind a kill-switch and an embedding fallback.
- **Choice fits the problem exactly.** A Choice question takes **up to 255
  options**; the retrieved **254 dishes + "No food"** is exactly 255. The
  response gives `.choice`, `.confidence`, `.probabilities`. On the sample sweep
  Jev nailed every case at 0.5–1.0 confidence in ~330–750 ms — it *sees* the
  dosa, picks `masala dosa`, and answers `No food` for a document.
- **Confidence is the control signal.** TypeSafe's guidance: ≥0.9 act, 0.5–0.9
  proceed with care, <0.5 don't act alone. We don't trust Jev blindly — low
  confidence routes back to the reliable prototype (§20).
- **The decision never sees the thresholds.** With Jev deciding, the embedding's
  `KHANA_FLOOR`/`TARLA_TRUST` constants matter far less: they only shape the
  fallback and the shortlist, not the headline verdict. The brittle part shrank.

---

## 19. The "only my site" lock — why origin checks aren't enough

Opening a browser-callable API means anyone can replay the request from `curl`.
The security work was layering defenses by what each one actually stops, and
being honest about the gap at each layer.

- **CORS and Origin checks are a speed bump, not a lock.** CORS is enforced by
  *browsers*, so it blocks other websites' JavaScript but does nothing to
  `curl`. A server-side `Origin`/`Referer` allowlist blocks casual `curl`, but
  the header is trivially spoofable (`curl -H "Origin: …"`). Proven live: the
  spoofed-origin request that we *expected* to pass, passed.
- **The daily cap is the money backstop.** A global counter that only increments
  on paid Vertex calls, returning 429 past N/day. Even a spoofer who forges the
  origin cannot run the bill past the cap. This is the one layer that *guarantees*
  no runaway spend. In-memory with `max-instances=1` keeps a single authoritative
  counter (a durable cap would use Firestore).
- **Cloudflare Turnstile is the actual lock.** The browser mints a short-lived,
  single-use token (bound to the domain via a challenge); the backend verifies
  it with Cloudflare `siteverify` (secret in Secret Manager) and checks
  `success` + `action` + `hostname`. A `curl` can't forge one. Spoofing the
  origin no longer helps — no token, 403. Verified live: curl with no token and
  curl with a fake token both 403; the real site still classifies.
- **A test key isolated a config bug from a code bug.** The widget wouldn't
  render on the domain (no iframe, silent). Rendering Cloudflare's always-pass
  **test key** (`1x0000…AA`) on the same page *did* mint a token — proving the
  wiring worked and the real key's **hostname allowlist** was the problem
  (dashboard-side, invisible to code). A known-good credential is the fastest way
  to split "my code" from "their config".
- **Automation can't test an anti-automation control.** Turnstile Managed mode
  silently declines a Playwright browser — exactly its job — so the happy path is
  only verifiable on a real human device. Build the control, then hand the final
  check to a person.
- **Fail closed, but don't fail the whole app.** `siteverify` unreachable → 503
  (don't spend a Vertex call on an unverifiable request). But a misconfigured
  widget would 403 *every* real user, so enforcement is an env flag: ship it
  **off**, confirm the happy path on a real device, then flip it **on** with a
  15-second `gcloud run services update` — no rebuild.

Defense in depth, each layer labeled by what it stops:

```
CORS pinned        → other websites' browsers
Origin allowlist   → casual curl                (spoofable)
Per-IP rate limit  → rapid bursts
Daily cap (500)    → total spend / bankruptcy   ← the money backstop
Turnstile token    → scripted abuse, spoofed origin  ← the real lock
```

---

## 20. Full long-tail coverage — the quota wall and the confidence guard

Loading all ~7k Tarla dishes (catalog text + single-image prototypes) in the
Vertex space hit two walls, each with a general lesson.

### The quota wall: pace under the limit, don't crash into it

Building the ~7k-label embedding cache crawled for *hours*. Root cause: the
embedder fanned out with a thread pool and **burst past the 600/min online
quota**, which triggered `429 ResourceExhausted`; the exponential backoff then
dominated, so throughput collapsed far below the limit. The fix was a **rate
limiter that paces request *starts*** to ~480/min (a safe margin under 600) so
429s essentially never fire. A steady 14-minute build replaced an open-ended
crawl. The lesson generalizes: with a hard rate quota, **shape traffic to stay
under it**; reactive backoff is a safety net, not a throughput strategy.

Corollary — **bake, don't rebuild.** Embedding 7k labels on every cold start
would hammer the quota and make the container slow to become ready. Precomputing
the cache and shipping it in the image drops cold start to ~5 s and zero
startup Vertex calls. The `.gcloudignore` deliberately *includes* the gitignored
cache so the build context carries it.

### The accuracy wall: more candidates, more look-alikes

With 7k dishes, the retrieved shortlist fills with near-duplicates, and Jev —
seeing a fried samosa — picked "veg fried wontons" at 0.3 confidence. Two fixes:

1. **Seed the shortlist with the visual prototypes.** The 254-candidate list is
   the prototype's top matches (accurate, visual) *then* the catalog text
   ranking (noisy), deduped. The right dish is always selectable.
2. **The khana-reliability guard.** When Jev is **low-confidence (<0.5) and
   disagrees with a confident khana prototype**, keep the prototype. The 80
   curated, multi-image dishes are the trustworthy core; Jev overrides them only
   when it is sure, and otherwise owns the long tail and the food/not-food call.

Result: 8/8 on the sweep — samosa, biryani, and margherita pizza recovered by the
guard; dosa, gulab jamun, momo, hotdog by Jev; non-food by Jev. The broader point:
**combine a high-precision narrow signal (khana prototypes) with a
high-coverage noisy one (Jev over 7k) by letting confidence arbitrate**, rather
than forcing one to win everywhere.

**Meta-lesson across the whole build:** every capability added coverage *and*
noise. The durable pattern was never "replace the old signal" but "layer the new
one and let a calibrated score decide which to trust" — mean-centering over raw
cosine, curated over catalog, khana over Tarla, prototype over an unsure Jev.
