# SeeFood production deployment plan — v3

Prepared 21 October 2026. Supersedes v2. **Key change: embeddings move from a self-hosted
EmbeddingGemma 2 container to the hosted Vertex "Gemini Embedding 2 (Unified Multimodal)"
API.** For a ~10-user invited trial, pay-per-request embeddings are cheaper and far less ops
than an always-warm model box, and they remove the 1.4 GB model, the GPU/CPU sizing decision,
and the weight-load cold start. The retrieval/routing layer we built is model-agnostic math on
vectors and is unchanged. The PWA is a thin client; GitHub Pages at a **custom domain**; the
**TypeSafe Jev** decision stage follows retrieval. No vector database, no Kubernetes, no queue,
no on-device inference — each has a listed trigger later, none is triggered today.

**The one hard rule:** every stored table (prototypes, label vectors, the mean vector) lives in
one model's vector space. The query image and all tables MUST come from the same embedder. So
adopting Vertex requires regenerating all artifacts with Vertex (one offline build, ~$0.62) and
re-validating accuracy — see Phase 1b. The self-hosted path stays available behind the provider
seam (`SEEFOOD_EMBED_PROVIDER`) as the fallback.

Scope and success criteria are unchanged: 2–5 invited testers, mostly phone photos, one-week
trial, ≤500 accepted classifications/day, $25/month budget target. The trial answers two
questions — does recognition work, and does the service work. Targets: warm end-to-end p95
under 8s for one active user, usable result within 60s after a cold start, no crashes under
five simultaneous uploads, clear rejection/retry when busy. Cloud numbers below are estimates
until Phase 2 measures them; local numbers are measurements.

## 1. Locked decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Frontend host | GitHub Pages at custom domain `https://seefood.verygoodproduct.company/` (root path) | Static build already emits root-relative URLs; no base-path work needed |
| API host | One Cloud Run service, `asia-south1` (Mumbai), scale-to-zero, min 0 / max 1 instance | Near testers; request-based billing; managed TLS/rollback |
| Compute | CPU 1 vCPU / 512 MiB — no model in-process; the service only does cosine + routing | Embedding runs in Vertex; this box holds ~16 MB of tables and is tiny/fast to start |
| Embeddings | **Hosted Vertex Gemini Embedding 2 (Unified Multimodal)**, image+text in one space; provider seam keeps self-hosted EmbeddingGemma 2 as fallback | Pay-per-request fits ~10 users far better than an always-warm 740M box; no GPU decision |
| Retrieval | Precomputed vectors in container memory (text labels + visual prototypes), **regenerated in the Vertex space** | ~16 MB bundle; cosine over ≤7k vectors is microseconds; math is identical across providers |
| Decision stage | TypeSafe Jev after retrieval, 3s timeout, fallback to embedding winner | Structured rerank + free "is this food?" signal; never receives the photo |
| Access | Per-tester bearer tokens (hashes in Secret Manager), Firestore daily quotas | Revocable, per-tester rate/daily limits, durable across restarts |
| Budget controls | Alerts at $5/$15/$25; max instances; daily quotas; shutdown runbook | Alerts notify, they do not cap — operational controls are the cap |

### Setup access needed (what the human provides)

The agent cannot reach GCP from the dev sandbox. To execute Phases 1b–2 you provide:

1. **A GCP project** with billing enabled, and **Vertex AI API** enabled.
2. **Confirm Gemini Embedding 2 (Unified Multimodal) access** in that project/region (it is
   Preview — may be allow-listed); note the exact **model id** and **image output dimension(s)**.
3. **ADC for local build/validate:** run `gcloud auth application-default login` (or a service
   account key) so `build_*.py --provider vertex` can call the API from the laptop.
4. Set env: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `SEEFOOD_VERTEX_MODEL`,
   `SEEFOOD_EMBED_DIM` (match the prototype dim), `SEEFOOD_EMBED_PROVIDER=vertex`.
5. For Cloud Run later: a **runtime service account** with `roles/aiplatform.user`.

## 2. Measured baseline (local, 21 Oct 2026)

M-series Mac, 4 threads (cloud-shaped), float32 CPU — the same code path the server runs:

| Step | Full model | Audio tower stripped |
| --- | --- | --- |
| Import torch + sentence-transformers | ~3.5s | ~2.7s |
| Weight load | 3.0s | 1.7s |
| First image encode (1600×1200) | 2.5s | 2.2s |
| Warm image encode | 2.1s | 2.0s |
| Text batch of 64 (label embedding) | 0.4s | 0.5s |
| Peak RAM | ~3.9 GB | ~3.0 GB |

Implications: the model is smaller than the 1.39 GB file suggests (that file includes an unused
audio tower — stripping it is verified working via `config_kwargs={"audio_config": None}` and
saves ~1 GB RAM plus ~45% load time). Loading is I/O, not compute. Cloud Run cold-start
estimate: **15–30s on a warm node** (imports + load + cache), plus **30–90s image pull** only
when Google schedules a node without the image (mostly right after a deploy — absorb it with a
post-deploy warmup request). Warm encode on shared 4 vCPUs is estimated 3–8s — the number Phase
2 must confirm. `transformers==5.20.x` (released) loads this architecture fine locally, which
resolves the earlier "development build" reproducibility concern.

## 3. Architecture

```text
                     ┌────────────────────────── TESTER PHONE ──────────────────────────┐
                     │ PWA installed from seefood.verygoodproduct.company               │
                     │ capture → downsize 1600px → session token · NO INFERENCE HERE    │
                     └──────────────┬──────────────────────────────────────────────────┘
                                    │ HTTPS POST /api/classify (+ Authorization: Bearer)
                                    ▼
 GitHub Pages                        ┌──────────── GCP asia-south1 (Mumbai) ────────────────┐
 custom domain, static build,       │                                                      │
 global CDN, CNAME + Enforce HTTPS  │  Cloud Run "seefood-api" — one container, scale-to-0 │
 ── deploy via GitHub Actions ──►   │  FastAPI · 1 vCPU/512 MiB · concurrency 8 · no model │
                                    │   1 auth        token hash + revocation (pre-parse)  │
                                    │   2 validate    10 MiB streamed cap · 25 MP decode   │
                                    │   3 quota       Firestore reservation, fail-closed   │
                                    │   4 embed   ──► Vertex Gemini Embedding 2 (image)    │
                                    │   5 retrieve    labels + prototypes → top-k + scores │
                                    │   6 decide  ──► TypeSafe Jev (text state, 3s timeout)│
                                    │        fallback: step-5 winner, source=embedding     │
                                    │   7 respond     verdict | uncertain + request ID     │
                                    │  ┌────────────┬───────────────┬───────────────────┐ │
                                    │  │Secret Mgr  │ Firestore     │ Cloud Logging     │ │
                                    │  │token hashes│ daily quotas  │ 7d, metadata only │ │
                                    │  │Jev API key │ (only mutable │ (no photos/EXIF/  │ │
                                    │  │            │  state)       │  tokens/embeds)   │ │
                                    │  └────────────┴───────────────┴───────────────────┘ │
                                    └──────────┬─────────────────────────────────────────┘
                                               │ POST api.typesafe.ai/v1/systemone
                                               │ (candidate names + scores only, never the photo)
                                               ▼
                                    ┌─────────────────────┐
                                    │ TypeSafe Jev (SaaS) │
                                    └─────────────────────┘

OFFLINE (laptop/CI, never serving):  datasets ──► indexer ──► artifacts + release manifest
  (prototypes.npz, label cache, catalogs, hashes, counts, model revision)

CI/CD (GitHub Actions, OIDC — no long-lived keys):
  npm ci → build → upload dist → deploy Pages  ···  docker build → push Artifact Registry → deploy Cloud Run
```

Data lifecycles: model/vectors/catalogs are immutable release artifacts baked into the image;
Firestore holds only small mutable quota records; photos are transient request data and are
never stored. The raw 6.7 GB dataset never leaves the laptop — see §8.

## 4. Implementation to-do (phases with acceptance tests)

### Phase 0 — Custom domain + static deploy (no backend yet)

- [ ] DNS: `CNAME seefood → <user>.github.io` at the `verygoodproduct.company` provider; confirm with `dig seefood.verygoodproduct.company`
- [ ] Repo → Settings → Pages: custom domain `seefood.verygoodproduct.company`, **Enforce HTTPS**, wait for the certificate
- [ ] Add a Pages workflow: `npm ci` → `npm run build` → upload `dist/` → deploy (OIDC). Backend/model files stay out of `dist/`
- [ ] **Test:** `curl -I https://seefood.verygoodproduct.company/` → 200, valid cert; all assets, `/manifest.webmanifest`, `/sw.js` load at root
- [ ] **Test:** install as PWA on iPhone Safari and Android Chrome; offline shell reload works
- **Done when:** the current app is installable at the custom domain and shows its graceful backend-outage error on scan

### Phase 1 — Provider seam (done) + reference baseline

- [x] `server/embed.py` provider seam: `LocalEmbedder` / `VertexEmbedder`, selected by `SEEFOOD_EMBED_PROVIDER`. `main.py` and both build scripts call `embed_image/embed_images/embed_texts` only — never the model directly.
- [x] Local path re-validated through the seam (dosa → masala dosa, hotdog → hotdog, doc → Not Food) — the reference the Vertex build must match.
- [x] Label cache signature includes the provider name, so a provider switch forces a rebuild instead of reusing wrong-space vectors.
- [ ] Freeze a small **parity set** (~20 fixed images incl. the sample sweep) with their local verdicts — this is the oracle Phase 1b diffs against.
- **Done when:** the seam is in place (it is) and the parity set + its local verdicts are recorded.

### Phase 1b — Adopt hosted Vertex embeddings (the pivot)

- [ ] Human provides GCP access (see §1 "Setup access needed"); confirm the Gemini Embedding 2 model id + image output dim; `pip install -r server/requirements-vertex.txt`.
- [ ] Validate the preview request shape — the only provider-specific code is `VertexEmbedder._embed_text` / `_embed_image_bytes`. Confirm image + text both embed and return the expected dim; adjust those two methods if the preview API differs.
- [ ] **Regenerate ALL artifacts in the Vertex space** (batch where possible): `SEEFOOD_EMBED_PROVIDER=vertex python server/build_prototypes.py` and `... build_tarla.py`; delete the stale `label_emb_cache.npz` so it rebuilds on first boot. Commit the new `*.npz` (they replace the local-space ones for the Vertex deployment — or keep per-provider bundles, see note).
- [ ] **Re-tune / re-measure the thresholds** (`KHANA_FLOOR`, `TARLA_TRUST`, the override gaps). They were fit to local mean-centered scores; the Vertex space will have different magnitudes. Run the calibration + sample sweep; adjust constants; version them.
- [ ] **Test (parity-ish, not identical):** run the Phase 1 parity set through the Vertex build. Scores WILL differ (different model); the *verdicts* should match on the sample sweep (6 dishes correct, hotdog → hotdog, doc/landscape → Not Food). Record any divergence before adopting.
- [ ] Decide artifact strategy: either the deployment ships Vertex-space artifacts only, or keep both bundles keyed by provider in the manifest. For a single hosted deploy, Vertex-only is simplest.
- **Done when:** with `SEEFOOD_EMBED_PROVIDER=vertex` the local service classifies the sample sweep correctly, and the one-time build cost is recorded (~$0.62 expected).

### Phase 1c — Reproducible release (thin, no model in image)

- [ ] `server/requirements-vertex.txt` is the runtime dep set (no torch/transformers). Verify a clean `python:3.11-slim` install.
- [ ] Write the **release manifest**: embedder provider + model id + output dim, sha256 of every artifact, expected counts (labels / prototypes / catalog), scoring constants, app commit.
- [ ] `Dockerfile`: slim base, non-root, `.dockerignore` (datasets, caches, secrets, the local `google_embeddinggemma_2/`), Uvicorn on `0.0.0.0:$PORT`. No model weights enter the image — only the ~16 MB tables.
- [ ] Startup validates counts/hashes against the manifest and **fails loudly** on mismatch; also assert the manifest's provider matches `SEEFOOD_EMBED_PROVIDER` (never serve local-space tables under the Vertex provider or vice versa).
- [ ] **Test:** container vs laptop parity under `vertex` — identical verdicts on the sample sweep; measure cold start (expected seconds, not model-load minutes).
- **Done when:** `docker run` answers `/api/health` ready (model = vertex) and returns the sample-sweep verdicts; image is < ~300 MB.

> Fallback (self-host) if Vertex access is blocked or the preview is unreliable: pin torch CPU + `transformers==5.20.x` in `requirements.txt`, strip the audio tower (`config_kwargs={"audio_config": None}`, −1 GB RAM / −45% load, verified), bake the gitignored weights into a private image, keep the local-space artifacts. The seam makes this a config flip, not a rewrite.

### Phase 2 — Cloud latency benchmark (hosted-embedding path)

With embeddings in Vertex, there is no model-load cold start and no GPU/CPU sizing gate. The
dominant latency is now the **Vertex round-trip + our microsecond cosine**. Measure that instead.

- [ ] Push the thin image to Artifact Registry (`asia-south1`); deploy **staging**: min 0, max 1, 1 vCPU/512 MiB, concurrency 8, 30s timeout, runtime SA with `roles/aiplatform.user`.
- [ ] Measure on staging: container cold start (should be seconds — no weights); end-to-end p50/p95 over ~20 mixed phone photos (dominated by the Vertex call + upload); Vertex call latency alone; error/timeout behavior when Vertex is slow.
- [ ] **Confirm region pairing:** Cloud Run `asia-south1` ↔ the Vertex embedding region. If the model isn't served in-region, measure the cross-region hop and decide whether to co-locate the service with the model region instead of the testers.
- [ ] **Test:** 1 → 2 → 5 concurrent uploads → bounded concurrency, `429` + `Retry-After` when over the inference slot/Vertex rate, health responsive, no leaks.
- **Done when:** end-to-end warm p95 < 8s and cold-to-result < ~20s (no weight load), or the tradeoff is written down.

### Phase 3 — API hardening + Jev decision stage

- [ ] Token middleware **before** multipart parsing: hash comparison, revocation list, per-token expiry; hashes in Secret Manager; tokens never in URLs, logs, or `VITE_*` vars
- [ ] CORS: exactly `https://seefood.verygoodproduct.company`, allow `Authorization`, preflight without token; CORS is not authentication
- [ ] Upload limits: 10 MiB streamed byte cap + slightly larger multipart cap + 25-megapixel decode cap; content sniffing (not MIME/filename); EXIF orientation; RGB; first-frame only for animations; bounded parts/headers; temp cleanup on every path
- [ ] Firestore quotas: 10 req/min per token, 100 accepted/day per tester, 500/day global; atomic reservation with server time; **fail closed** if quota accounting is down; bound rate-limit bookkeeping
- [ ] Inference slot: one active classification per instance, bounded executor off the event loop, `429` when busy; platform concurrency 4; slot held until work finishes even on client disconnect; process recovery for a stuck worker
- [ ] Health: liveness + readiness gates (model loaded, artifacts validated) with a startup probe covering measured init
- [ ] Jev: state = top-k candidate names + scores (+ catalog facts); questions = choice("which dish is shown?") + noul("is this really food?"); 3s timeout, at most one retry on transport error only; **on any failure return the step-5 winner flagged `source=embedding`**; record jevLatency and jevAgree (does Jev match the embedding pick?) — the trial's evidence for whether Jev earns its place
- [ ] Kill-switch config flag to disable Jev without redeploying code; verify the service passes tests with Jev off
- [ ] Responses: structured errors + request ID + release version; no stack traces/host details; the 254-dish ranking becomes opt-in debug
- [ ] **Test (abuse matrix):** missing/revoked token, direct curl bypass, forged MIME, corrupt bytes, oversized + chunked upload, decompression bomb, 5 concurrent + click-spam, quota exhaustion across restart, missing/corrupt artifact, Jev outage (fallback path), Jev slow (timeout path)
- **Done when:** every abuse-matrix row passes and Jev-disabled mode passes

### Phase 4 — Recognition quality

- [ ] Fix the README ("uploads never leave the browser") and the `PROTO_THRESHOLD` mismatch (implement or delete)
- [ ] Freeze an evaluation set: ~100 known dishes, 50 unfamiliar, 50 non-food; split by source/near-duplicate group; keep calibration and final-eval separate
- [ ] Add **"Looks like food; dish uncertain"**: thresholds fit on calibration data (never a guessed universal cosine); Jev's noul disagreement also routes here
- [ ] Audit the mean-centering asymmetry (prototypes subtract the raw centroid mean, queries subtract its unit-normalized version); reproduce the baseline, test consistent centering, version any scoring change with its calibration; test `KHANA_BONUS` impact
- [ ] Feedback: Correct / Wrong / Not-sure + optional expected dish; testers export a JSON record (request ID, predicted/expected, release, timing) and share manually; photos shared only by explicit opt-in
- [ ] **Test:** report per-category results (top-1/top-3, false-food, unknown-rejection, accuracy among named results) against the frozen baseline
- **Done when:** recognition behavior is measured and versioned; failures are observable

### Phase 5 — Frontend production wiring

- [ ] `VITE_API_BASE_URL=https://<service>-<hash>-as.a.run.app` at build time (configuration, not a secret); keep the local dev proxy
- [ ] Token entry screen held in session memory; states for expired/revoked token
- [ ] Status states: access expired, invalid image, **service starting (cold)**, busy (429 + Retry-After), timed out, offline; abort replaced requests; no automatic POST retries
- [ ] Privacy copy: photo sent to the hosted service and processed transiently, not retained; Jev receives candidate names/scores as text only; logs keep request metadata only
- [ ] **Test:** production build against the real deployed API on iPhone Safari and Android Chrome; airplane mode; API outage mid-upload
- **Done when:** full scan → verdict works on both platforms against production

### Phase 6 — Production cutover

- [ ] Promote the **tested image digest** (no rebuild) from staging to the trial service; a custom API domain is deferred — the `run.app` URL is fine behind CORS
- [ ] Logging: request ID, tester ID, release version, status, upload bytes, decode/infer/total, Jev latency/agreement, cold-start flag; 7-day retention; no photos, EXIF, tokens, or embeddings
- [ ] Budget alerts at $5/$15/$25 (notify-only); document that max-instances, daily quotas, and the shutdown runbook are the real spend controls
- [ ] Post-deploy warmup request (absorbs the image-pull cold start before testers do); rehearse rollback to the previous revision; rehearse emergency shutdown (revoke tokens → remove public ingress)
- [ ] **Test:** real-model smoke classification; measured cold start; rollback; shutdown
- **Done when:** the launch gate below passes

### Phase 7 — Invited trial

- [ ] Mint one expiring token per friend; write the one-page test brief (what to try, what to capture, feedback export steps)
- [ ] Two testers complete the device checklist (camera/upload, token, errors, install, offline); collect feedback exports keyed by request ID
- [ ] Mid-week: review Jev agreement rate, cold starts, failures, bill
- **Done when:** the week completes and the decision review happens — fix coverage/calibration if names are wrong, upgrade compute only if inference dominates latency, warm capacity only if cold starts dominate the experience, add replicas/queue only if measured demand requires

## 5. "Try to break it" matrix (run at cutover, within quota)

| Test | Expected |
| --- | --- |
| Covered dish, new photo, similar dishes | Top-3 recorded; correction captured vs baseline |
| Food outside catalog, mixed plate, empty plate, toy food | Uncertainty possible; no confident nonsense names |
| Person, pet, document, landscape, noise | Measured false-food rate (model error ≠ service outage) |
| Rotated phone image, huge dims, GIF/AVIF, HEIC | Correct orientation or actionable rejection |
| Forged MIME, corrupt bytes, oversized/chunked, zip bomb | Bounded resources, controlled 4xx |
| Missing/revoked token, direct non-UI requests | Auth and quotas apply; zero inference for bad credentials |
| 1 → 2 → 5 concurrent uploads, click-spam | Bounded inference, 429s, responsive health, no OOM |
| Quota exhaustion, restart, revision overlap | Daily quota survives and stays global |
| First request after idle; corrupt artifact | Cold-start target met or controlled failure — never silent partial coverage |
| Airplane mode, slow network, outage, navigate mid-upload | Cached shell works; clear connectivity state; no retry storm |
| iPhone installed PWA + Android installed PWA | Camera, token, CORS, errors, results all work |
| Old installed PWA vs new frontend/API | Compatible API, predictable update, working rollback |
| Jev down / Jev slow | Verdict still returned, flagged `source=embedding`; no hard failure |

Load test order: 1, 2, 5 clients, then one short bounded burst. Never an unrestricted stress test on a paid endpoint.

## 6. Costs (hosted-embedding model, rates checked 21 Oct 2026)

The model-box cost (the old CPU/GPU-hours table) is **gone** — no model runs in-process. Two
cost lines now: a tiny Cloud Run service (cosine + routing only) and the Vertex embedding calls.

**Vertex Gemini Embedding 2** (per the pricing page): image online $0.45 / 1M tokens, image batch
$0.225 / 1M; text online $0.20 / 1M, batch $0.10 / 1M. Assuming ~280 tokens/image (verify on the
real model — the cost driver):

| Item | Work | Subtotal |
| --- | --- | --- |
| **One-time** artifact rebuild (batch) | ~9.6k images + ~7k labels | **~$0.62**, once |
| Per live classification (online image) | 280 tok × $0.45/1M | **~$0.00013** (~7,900 per $1) |
| Light trial embeddings | 1,000 classifications | **~$0.13 /mo** |
| Full allowance embeddings | 15,000 classifications | **~$1.90 /mo** |
| Growing beta embeddings | 100,000 classifications | **~$12.60 /mo** |

**Cloud Run (thin service, 1 vCPU/512 MiB, request-based):** at ~1–2s active per request (mostly
waiting on Vertex) the compute is pennies/mo at trial volume; no weight-load cold start to pay for.
Scale-to-zero idle = $0.

Supporting services: Artifact Registry ~$0.45/mo (tiny image now, ~300 MB), Firestore within free
allowance at trial volume, logs/secrets/CI reserve $1–3/mo, GitHub Pages $0, custom domain DNS only.
**Jev: ~$0.04–0.06 per 1M input tokens, output free — pennies.** Total trial spend is dominated by
nothing — reserve **$5–10/month** and the alerts will never fire at ~10 users. Measure **cost per
successful classification**; here it's ~$0.0001 + negligible compute.

> Self-host fallback retains the old economics (an always-warm box is a fixed monthly cost); only
> revisit it if Vertex is unavailable or sustained volume makes per-request fees exceed a saturated
> instance (~>200k classifications/mo as a rough crossover).

## 7. Cold-start mitigation ladder (main risk)

Scale-to-zero means the first scan after ~15 idle minutes pays a startup. Order of levers:

1. Bake model + caches into the image — zero runtime downloads (biggest lever)
2. Strip the audio tower (−1 GB RAM, −45% load time, verified)
3. CPU-only torch wheels + slim base (−~1–2 GB image → faster pulls)
4. Precomputed label cache (never embed labels at startup)
5. One warmup request right after each deploy (absorbs the image-pull case yourself)
6. Optional, trial week only: a Cloud Scheduler ping every ~10 min during expected evening
   usage keeps the instance warm in active windows (~$9/week). Do **not** use min-instances=1
   (~$231/mo) for a friends trial.

Expected result: ~20–40s on the first scan of a session (show "service starting"), ~3–9s warm
after that. If Phase 2 shows the platform queueing requests past the browser's patience, raise
the browser timeout and the "starting" UX before raising spend.

## 8. Data & retrieval growth (no re-architecture for adding dishes)

The runtime never touches the raw dataset — retrieval runs on derived vectors only
(79 prototypes ≈ 251 KB, ~500 label embeddings ≈ 1.5 MB today; full Tarla ≈ ~60 MB total).
Adding data is an offline indexing run that produces a new versioned artifact bundle + manifest:

- **Stage 1 (now):** vectors baked into the image — good to ~50 MB (thousands of dishes)
- **Stage 2:** vectors in a versioned GCS bucket, container fetches the pinned bundle at startup —
  trigger: data-only releases get painful as the image grows; rollback = repoint at the old bundle
- **Stage 3:** vector index service (Firestore vector search or Vertex AI Vector Search) — trigger:
  online updates without redeploying, ~1M+ vectors, or multiple services sharing one index

Invariants that keep growth boring: the index is immutable and versioned; index and model move
together (new embedding space ⇒ rebuild everything); startup validates counts and fails loudly;
Jev stays downstream of a fixed top-k so index growth never changes the decision stage.
Feedback photos, if ever collected, go to GCS with short lifecycle + consent flags and feed the
indexer — never the runtime.

## 9. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Cold start frustrates first scan | Ladder in §7; "service starting" UX; warmup after deploy |
| CPU inference too slow | Phase 2 gate → tune → L4 branch (verify regional quota first) |
| Jev outage/slowness | 3s timeout, embedding fallback, kill-switch flag, agreement-rate logging to justify keeping it |
| Abuse / unexpected spend | Tokens + revocation, Firestore quotas, max instances 1, remove public ingress as emergency stop |
| Budget overrun | Alerts at $5/$15/$25; remember alerts notify — quotas and shutdown are the cap |
| Gated model license | Weights stay out of git, image lives in a private registry; re-check Gemma terms before any monetization |
| Pages commercial-use limits | Fine for an invited trial; move the static build to commercial hosting before monetizing (backend unaffected) |
| Broken release | Cloud Run revision rollback with the previous image digest + manifest; Pages redeploy of prior `dist/` |

## 10. Rollback / recovery runbook

1. **Abuse or cost spike:** disable inference flag → revoke affected tokens → remove public invocation if traffic continues → inspect redacted logs before reopening
2. **Bad backend release:** route 100% to the previous revision (same digest, model, vectors, scoring) → run a real classification smoke test
3. **Bad frontend release:** redeploy the previous `dist/` → test a fresh browser and an installed PWA with the older service worker → keep API compatibility across current and previous frontend
4. **End of trial:** revoke tokens → remove public access → delete unneeded images/revisions → apply log/artifact retention → re-check billing after reporting delay

## 11. Launch gate

Share the URL only when all are verified: token auth + revocation · CORS pinned to the custom
domain · upload limits enforced server-side · durable quotas surviving restarts · real-model
inference in the container · bounded concurrency with 429s · health probes · Jev timeout +
fallback + kill-switch · uncertainty result present · privacy copy accurate · feedback export
works · budget alerts set · rollback and shutdown rehearsed · cold start measured and the
"starting" state shown. Accuracy may be imperfect — that is what the trial measures; failures
must be observable and resource use controlled.
