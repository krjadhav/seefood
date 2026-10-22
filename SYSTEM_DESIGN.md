# SeeFood: System Design and the Reasoning Behind It

This document explains how SeeFood works and, more importantly, *why* it is built
the way it is. It is written for someone who wants to understand the decisions —
to learn from them or to write about them — not just to read a component list.

SeeFood began as the *Silicon Valley* joke: an app that says "hotdog" or "not
hotdog." It is now a real food recognizer. Paste or snap a photo and it names the
dish — across roughly seven thousand Indian and Western dishes — or tells you the
picture is not food.

We build up the system one decision at a time. Each decision starts from a
problem, weighs the options, and explains the choice, with attention to two
themes the rest of the document keeps returning to: **optimization** (doing the
same work for less time and money) and **system design** (drawing boundaries so
each part stays simple).

---

## Part 1 — Prerequisites

A handful of ideas carry the whole design. If these are familiar, skim them.

**Embeddings.** A model can turn a piece of content — a sentence, a photo — into
a list of numbers (a *vector*) that captures its meaning. Similar things land
near each other. "A dog" and "a puppy" sit close; "a dog" and "a tax form" sit
far apart.

**A shared multimodal space.** Most models embed only text. A *multimodal* model
embeds images and text into the **same** space, so you can measure how close a
photo is to a phrase. This single fact is what makes SeeFood possible: embed the
photo, embed the words "masala dosa," and see how close they are.

**Cosine similarity.** To compare two vectors, we measure the angle between them.
A cosine of 1.0 means identical direction; 0.0 means unrelated. Every comparison
in SeeFood is a cosine.

**Retrieval versus decision.** A recurring split. *Retrieval* narrows thousands
of candidates to a handful using fast, cheap math (cosine over precomputed
vectors). *Decision* then picks the single answer from that handful, where a
smarter, slower judgment is affordable because the list is short.

**Serverless and scale-to-zero.** A serverless platform runs your code only while
a request is in flight and bills by the hundred-milliseconds. When no one calls,
it scales to **zero** instances and costs nothing. The price is a *cold start*:
the first request after idle waits for a container to boot.

**The one-model-one-space invariant.** Vectors are only comparable if they come
from the **same model**. A photo embedded by model A cannot be compared to a
label embedded by model B — the numbers live in different spaces. This invariant
constrains every later decision about where embeddings come from.

---

## Part 2 — The decisions, in order

### Decision 0 — Is this even possible? Read the model card first.

The request assumed an embedding model could "identify the food." The first
instinct was doubt: the well-known version of this model is text-only. Ten
minutes reading the model's config settled it — the model carries a vision
encoder and maps images and text into one 768-dimension space.

That reading flipped the project from "needs a custom image classifier" to "needs
one embedding space and some arithmetic." **The cheapest optimization is the one
that deletes a subsystem before you build it.** Read the datasheet before you
design around a guess.

### Decision 1 — Where does the model run? Not in the browser.

The app is a static web page. The model is hundreds of millions of parameters —
far too large to ship to a phone. So inference has to run on a server, and the
page becomes a thin client that uploads a photo and renders the answer.

This draws the system's first boundary: a **stateless** backend that turns an
image into a verdict, and a **static** frontend that holds no secrets and no
model. That boundary pays off repeatedly — the frontend deploys to a free CDN,
and the backend can change completely (even swap models) without touching it.

### Decision 2 — Name the dish, not just "food." And the optimization that made it work.

Calling something "food" is easy; naming "masala dosa" is not. The approach:
build a **visual prototype** for each dish by averaging the embeddings of ~40
real photos into one representative vector, then match a new photo to the nearest
prototype.

This nearly failed. Photos of food on plates all cluster in a narrow cone of the
embedding space — every dish sits close to every other, so the nearest-prototype
scores were nearly tied and useless as confidence.

The fix is the design's signature optimization: **mean-centering.** Subtract the
average direction of all prototypes (the generic "food on a plate" component)
from both the photo and the prototypes before comparing. What remains is what
makes each dish *distinct*. Measured top-1 accuracy on held-out photos rose from
guessing to 95%, and — just as important — the scores spread out enough to be
interpretable. **The same data, re-centered, carried far more signal.** No new
model, no new data; just better arithmetic on the vectors we already had.

### Decision 3 — Who makes the final call? A model, not a pile of thresholds.

Prototypes name dishes they know. But a hotdog, with no hotdog prototype, got
forced to the nearest Indian dish. Hand-tuned thresholds to decide "trust the
prototype or not" turned into whack-a-mole: every new dataset broke the last
tuning. The scores of a *correct* in-set dish and a *wrong* out-of-set dish
overlapped, so no single number could separate them.

The durable answer separates **retrieval from decision**. The embedding retrieves
a shortlist — the top ~254 candidate dishes. A decision model, **TypeSafe Jev**,
then picks the right one (or "No food") from that short list *while seeing the
photo*. Jev is a "System One" model: it returns a typed choice with a calibrated
**confidence**, not an essay.

Two system-design points fall out of this. First, a 255-option limit matches the
problem exactly: 254 dishes plus "No food." Second, **confidence becomes a
control signal** — high confidence acts; low confidence defers. That single
number replaced a thicket of brittle thresholds.

### Decision 4 — Self-host the model, or rent it? Rent it — and seal the seam.

For ~10 trial users, running the model on an always-warm server is the wrong cost
shape: you pay by the hour whether or not anyone scans. Google's hosted
multimodal embedding model bills **per request** and idles for free.

The invariant from Part 1 makes this a careful move: switching the embedder means
**every stored vector must be regenerated in the new model's space**. To keep
that switch cheap and reversible, the code hides the embedder behind a seam — one
small module with two implementations (local and hosted), chosen by an
environment variable. The retrieval and decision code never changed; only the
embed call did. **A clean seam turned a model migration into a config flip.**

Reality corrected two assumptions here, which is worth recording: the model on
the pricing page was not the one actually available in the project, and it used a
different API shape and a different vector length (1408, not 768). The seam
absorbed all of it, and the vector-length mismatch became a free tripwire against
stale data.

### Decision 5 — The deployment topology, and why each piece is managed.

The guiding principle, straight from Google Cloud's Well-Architected Framework:
**prefer fully managed services and keep the architecture stateless.** The result:

- The **frontend** is a static build on a global CDN. No servers.
- The **backend** is a single serverless container that scales to zero.
- **Secrets** (the Jev and Turnstile keys) live in a managed secret store, mounted
  at runtime — never in code, never in the image.
- **Embeddings** come from the managed model API; the backend holds no model.
- **The decision** comes from a managed SaaS judgment model.

Every stateful or heavy concern is someone else's managed service. What we own is
small: ~16–70 MB of precomputed vectors and a few hundred lines of routing. That
is the whole point of the boundaries drawn in Decisions 1–4.

### Decision 6 — Make it fast and cheap: three optimizations that matter.

With the topology fixed, the work was shaving latency and cost.

**Bake the index; don't rebuild it.** The backend needs ~7,000 label vectors.
Computing them on every cold start would hammer the embedding API and make the
container slow to become ready. Instead we precompute them once and ship them
inside the container image. Cold start dropped to about five seconds with **zero**
embedding calls at boot. *Move repeated work out of the request path and into the
build.*

**Pace requests under the quota; don't crash into it.** Building that index the
first time crawled for hours. The cause: the builder fired requests in bursts,
blew past the API's 600-per-minute limit, got rate-limited, and then spent its
time backing off. A rate limiter that *paces* request starts just under the limit
replaced hours of thrashing with a steady 14-minute run. *Against a hard rate
limit, shape the traffic; reactive backoff is a safety net, not a plan.*

**Let the platform bill nothing when idle.** Scale-to-zero plus a static CDN means
the resting cost is essentially zero. The trade is cold starts, which the baked
index already shrank to a few seconds — acceptable for a small trial, and far
cheaper than keeping a server warm.

### Decision 7 — Security: layer the defenses, and be honest about each.

A browser-callable API can be replayed from the command line, so no single check
is a wall. The design layers defenses and labels each by what it actually stops:

- **CORS**, enforced by browsers, blocks other websites' pages.
- A server-side **origin allowlist** blocks casual scripts, but the header can be
  forged — a speed bump, not a lock.
- A **per-IP rate limit** slows a single abuser.
- A **global daily cap** is the money backstop: even a forged request cannot run
  the bill past a fixed number of paid calls per day.
- **Cloudflare Turnstile** is the real lock. The browser mints a single-use token
  that proves a human loaded *this* site; the backend verifies it with Cloudflare
  and rejects anything without one. Forging the origin stops helping.

Two lessons generalize. First, **a known-good test credential separates your bug
from their config** — Cloudflare's always-pass test key rendered fine, which
proved our code worked and pointed at a dashboard setting. Second, **an
anti-automation control cannot be tested by automation**; the final check belongs
to a real person, so enforcement ships behind a flag you can flip on in seconds
once a human confirms the happy path.

### Decision 8 — More coverage brings more noise: let confidence arbitrate.

Expanding from 80 dishes to ~7,000 widened coverage but crowded the shortlist
with look-alikes, and the decision model occasionally picked a fried look-alike
over a samosa — at low confidence. The fix is the thread running through the whole
project: **combine a precise-but-narrow signal with a broad-but-noisy one, and let
a calibrated score decide which to trust.** When the decision model is unsure and
disagrees with a confident prototype from the trusted 80-dish core, keep the
prototype; otherwise let the model own the long tail and the food/not-food call.

---

## Part 3 — The system, assembled

Boxes below are labeled with their Google Cloud product names (which map to the
official Google Cloud product icon set) and the external services.

```
                        ┌──────────────────────────────┐
                        │        A tester's phone        │
                        │  Installed PWA · no inference  │
                        └───────────────┬───────────────┘
            1. load app  │              │  3. POST /classify (photo + Turnstile token)
                         ▼              ▼
   ┌───────────────────────────┐   ┌───────────────────────────────────────────┐
   │   GitHub Pages (CDN)        │   │  2. Cloudflare Turnstile                   │
   │   static PWA, custom domain │   │     mints a single-use, site-bound token  │
   └───────────────────────────┘   └───────────────────────────────────────────┘
                                                  │
                                                  ▼
   ┌──────────────────────────── Google Cloud (us-central1) ───────────────────────────┐
   │                                                                                     │
   │   ┌─────────────────────────────────────────────────────────────────────────┐     │
   │   │  Cloud Run  — "seefood-api", scale-to-zero, 1 instance                    │     │
   │   │                                                                           │     │
   │   │   guard:  origin · rate limit · daily cap · Turnstile siteverify          │     │
   │   │   embed:  the photo ──────────────►  Vertex AI  (multimodal embeddings)   │     │
   │   │   retrieve: cosine vs baked prototypes + labels → 254-dish shortlist      │     │
   │   │   decide:  shortlist + photo ─────►  TypeSafe Jev  (Choice: dish | No food)│     │
   │   │   guard:  keep the khana prototype when Jev is unsure                      │     │
   │   └───────────────┬───────────────────────────────────┬───────────────────────┘     │
   │                   │ reads at boot                     │ reads at startup            │
   │        ┌──────────▼───────────┐            ┌──────────▼───────────┐                 │
   │        │ Baked index (in image)│            │  Secret Manager      │                 │
   │        │ prototypes + labels   │            │  Jev + Turnstile keys│                 │
   │        └──────────────────────┘            └──────────────────────┘                 │
   │                                                                                     │
   │   Build & release:  Cloud Build  ──►  Artifact Registry  ──►  Cloud Run             │
   │   Observability:     Cloud Logging                                                  │
   └─────────────────────────────────────────────────────────────────────────────────────┘

   Offline (laptop, never serving):  datasets ──► indexer ──► baked index (vectors)
```

**Request path, in words.** The phone loads the static app from the CDN. Before a
scan, Turnstile mints a token. The phone posts the photo and token to Cloud Run.
The guard verifies the token and the rate/daily limits, then Cloud Run asks Vertex
AI to embed the photo, cosine-ranks it against the baked index to get a 254-dish
shortlist, and hands that shortlist plus the photo to Jev, which returns the
dish or "No food." A final guard keeps the trusted prototype when Jev is unsure.
Keys come from Secret Manager; the index was baked in at build time by Cloud
Build and stored in Artifact Registry.

---

## Part 4 — How it maps to the Well-Architected Framework

Google Cloud's framework names six pillars. The design touches each.

| Pillar | What SeeFood does |
| --- | --- |
| **Operational excellence** | One-command deploys; a kill-switch env flag per risky feature (Jev, Turnstile); a health endpoint that reports live counts so "is the new code running?" is a one-line check. |
| **Security, privacy, and compliance** | Layered guards (CORS, origin, rate, daily cap, Turnstile); keys in Secret Manager, never in git; the photo leaves the device only to managed APIs and is never stored. |
| **Reliability** | Stateless container; fail-closed verification; an embedding fallback when the decision model times out; the daily cap as a blast-radius limit. |
| **Cost optimization** | Scale-to-zero plus a static CDN → ~zero idle cost; pay-per-request embeddings instead of an always-warm GPU; a baked index so cold starts don't re-pay for work. |
| **Performance optimization** | Mean-centering for signal; retrieval-then-decision so the expensive judgment runs over 254 items, not 7,000; a baked index for ~5-second cold start; request pacing to avoid rate-limit thrash. |
| **Sustainability** | Scale-to-zero and a right-sized container consume compute only while serving — the same lever as cost. |

The framework's core principles show up too: **use managed services** (every heavy
concern is someone else's service), **decouple** (frontend, backend, embedder,
decider all swap independently), and **stay stateless** (the only state is a small
in-memory counter and a read-only index).

---

## Part 5 — Trade-offs and what comes next

Honesty about the edges matters more than a clean story.

- **Coverage costs precision.** Seven thousand dishes bring look-alikes; the
  confidence guard recovers the core, but deep long-tail dishes can still land on
  a near-match. The confidence score is exposed so the UI can say "uncertain"
  rather than assert a shaky guess.
- **The daily cap resets on cold start.** In memory with one instance, it bounds
  spend well enough for a trial; a durable cap would move the counter to a managed
  datastore.
- **Preview features carry risk.** Hosted embeddings and Jev's image input are
  both preview-stage; each sits behind a kill-switch with a working fallback.

The through-line, if there is one to write about: **every new capability added
both coverage and noise, and the winning move was never to replace the old signal
but to layer the new one and let a calibrated score decide which to trust** —
mean-centering over raw cosine, curated labels over the catalog, the trusted core
over the long tail, a confident prototype over an unsure model. Good system design
here was less about any single clever part than about where the boundaries fell
and which number got to decide.
