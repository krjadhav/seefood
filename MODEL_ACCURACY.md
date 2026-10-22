# SeeFood: Accuracy — Methods, Challenges, and Limits

This document is an honest account of how SeeFood recognizes a dish: what we did
to make it more accurate, what fought back, and why it still gets some images
wrong. It is written for a reader who wants the reasoning, not a score table.

Two real failures anchor the discussion, because the interesting part of any
recognizer is where it breaks:

- A **Tatte idli** (a thick, plate-steamed idli from Karnataka) was called
  **Neer dosa** (a thin white rice crepe).
- A **lemon**, photographed **blurred**, was called **besan ladoo** (a yellow
  round sweet).

Neither is a random error. Each points at a specific, understandable limit.

---

## 1. The problem, framed

Google Research's **FoodLens** names the difficulty of Indian food recognition
well: datasets under-represent Indian dishes, a single plate often holds
**multiple** dishes, and the cuisine has enormous **fine-grained regional
variety**. Their answer was a supervised, fine-tuned model (**CHAMP**) trained on
~30K hand-annotated images across ~140 dishes, using a hierarchy of food
categories and multi-label annotations.

SeeFood attacks the same problem from the opposite direction. We do **not** train
or fine-tune anything. We take a frozen, general-purpose multimodal embedding
model and build accuracy out of *arithmetic on its vectors* plus a decision
model. That choice buys breadth (thousands of dishes, extend by adding data, no
labeling campaign) and costs fine-grained precision (no model ever learned what
separates a Tatte idli from a Neer dosa). The failures below are the bill for
that trade.

Three properties of the problem matter throughout:

- **Low inter-class variance.** Many Indian dishes look alike — pale, round,
  soft, fried, or saucy. The *visual* distance between a Tatte idli and a Neer
  dosa is genuinely small.
- **High intra-class variance.** The *same* dish varies wildly by region, cook,
  plating, and lighting.
- **A long tail.** A handful of dishes are common; thousands are rare, and the
  rare ones have little visual data.

---

## 2. What we did to improve accuracy

Accuracy came from a sequence of changes, each measured against the last. The
theme: **layer a new signal and let a calibrated number decide when to trust
it**, rather than replace the old signal.

### 2.1 Zero-shot text labels — the baseline (~0.75 top-1)

Embed the photo; embed `"a photo of {dish}"` for each candidate; pick the nearest.
"Not food" falls out by including non-food phrases. Simple, but only ~75%
accurate on held-out dish photos — text descriptions are a weak proxy for how a
dish *looks*.

### 2.2 Visual prototypes — compare photos to photos

For each of 80 core dishes we averaged ~40 real photos into one **prototype**
vector and matched new photos to the nearest prototype. Comparing images to
images beats comparing images to words.

### 2.3 Mean-centering — the single biggest gain (0.75 → 0.95)

This nearly failed first. Every food-on-a-plate photo sits in a narrow cone of
the embedding space, so all prototypes were near-tied and the scores were
meaningless as confidence. The fix: subtract the **shared mean direction** of all
prototypes — the generic "food on a plate" component — from both the photo and
the prototypes before comparing. What remains is what makes each dish *distinct*.
Held-out top-1 rose from 0.75 to **0.95**, and the scores finally spread apart
enough to act on. Same data, re-centered; far more signal.

### 2.4 Curated vs. catalog, and a routing rule

Adding thousands of text descriptions collapsed "Not food" detection — some food
phrase always beat the ~40 non-food phrases. We split labels into a small
**curated** set (hand-picked foods + non-food, used for the food/not-food gate)
and a large **catalog** (used only for naming and retrieval). The gate decides
*food or not*; the catalog decides *which dish*.

### 2.5 Prototype tiering — trust multi-image over single-image

We later added ~6,500 **single-image** prototypes from a recipe dataset for
coverage. Single images are noisy, and they began stealing answers from the
reliable 80-dish core (a samosa matched "spring rolls"). The fix is a tier:
prefer a **core (multi-image) prototype** whenever its score clears a floor; only
fall to the noisy single-image anchors below that.

### 2.6 Jev — retrieval then decision

Hand-tuned thresholds were brittle; every new dataset broke them. So we split
**retrieval** from **decision**. The embedding retrieves a 254-dish shortlist;
**TypeSafe Jev**, a decision model that *sees the photo*, picks the dish (or "No
food") from that short list and returns a **calibrated confidence**. The brittle
threshold logic shrank to a fallback.

### 2.7 Shortlist seeding + the confidence guard

With thousands of candidates, the shortlist fills with look-alikes and Jev
occasionally picks wrong at *low* confidence. Two guards: **seed** the shortlist
with the visual prototypes' top matches (so the right dish is always selectable),
and when **Jev is unsure (<0.5) and disagrees with a confident core prototype,
keep the prototype**. The confident, high-precision core wins ties; Jev owns the
long tail and the food/not-food call. On the core sample set this reaches 8/8.

---

## 3. Challenges along the way

- **The cosine cone.** Cross-modal similarity scores live in a narrow band
  (~0.6–0.7 for almost any food-label pair). Absolute thresholds on raw cosine
  are meaningless; only relative ranking and *mean-centered* scores carry signal.
- **A misleading calibration metric.** An early "positives overlap hard
  negatives" statistic looked fatal but measured the wrong thing (nearest
  *other* centroid, pessimistic because many dishes are near-duplicates). The
  metric that mattered — actual top-1 — was 0.95. Trust the end-task measurement
  over a scary intermediate stat.
- **No single threshold can route.** A *correct* in-set dish scored *lower* than
  a *wrong* out-of-set match, with indistinguishable margins. One number cannot
  separate "known dish" from "unknown food" — which is exactly why the decision
  moved to a model that sees the image.
- **More data, more noise.** Every expansion added coverage *and* look-alikes.
  The durable pattern was never "replace" but "layer and let confidence arbitrate."
- **Frozen model, by choice.** We never fine-tuned, so no component ever *learned*
  the fine-grained boundaries FoodLens's CHAMP learned. Breadth and speed-to-extend
  in exchange for fine-grained precision.

---

## 4. Why it is still not perfect — two failures, read closely

### 4.1 Tatte idli → Neer dosa: fine-grained similarity + a missing prototype

Two things compound here.

**Low inter-class variance.** A Tatte idli and a Neer dosa are both pale, white,
soft, round, rice-based South Indian items. In a general embedding space, "pale
round white steamed/rice dish" is a tight neighborhood — the honest visual
distance between them is small. A model never trained to separate them will put
them close.

**A long-tail gap.** Tatte idli is not one of the 80 core dishes with a strong
multi-image prototype; it lives only in the text catalog and the noisy
single-image set. So there is **no high-precision visual anchor** for it. The
confidence guard (§2.7) can only protect dishes that *have* a core prototype —
Tatte idli doesn't, so the system falls to the nearest thing it does know well,
and Neer dosa is a close pale-white neighbor.

This is precisely FoodLens's "fine-grained regional variety" + "under-represented
data" problem. Their fix was labeled training data and a hierarchy; we chose not
to train, so we inherit the gap.

### 4.2 Blurred lemon → besan ladoo: degraded input collapses distinct objects

Blur is a low-pass filter: it removes high-frequency detail (the lemon's pores,
the ladoo's grainy surface) and leaves only low-frequency structure — a **yellow
sphere**. A besan ladoo *is* a yellow sphere. Once the distinguishing texture is
gone, the two objects map to nearly the same coarse descriptor, and any
recognizer — ours or a trained one — is choosing between look-alikes on the
evidence that survives.

Two smaller issues stack on top. A lemon is a **raw ingredient**, not a prepared
dish, so it sits at the blurry edge of "is this even a dish?" And there is **no
lemon prototype**, so nothing high-precision anchors the correct answer. The
decision model, shown a blurry yellow blob, reasonably picks the yellow round
*food* it was offered.

### 4.3 The structural limits underneath

- **Fine-grained visual similarity.** A frozen general embedding cannot resolve
  distinctions it never learned; the look-alikes are genuinely close in its space.
- **The long tail without training.** Dishes outside the ~80-prototype core have
  no strong visual anchor; coverage came from noisy single images and text.
- **Input quality.** Blur, bad lighting, odd angles, and partial plates strip the
  very detail that separates fine-grained classes. We do not yet reject or flag
  low-quality input.
- **Single-label output.** We name one dish; a real thali holds many. FoodLens
  treats this as **multi-label** by design; we do not, yet.
- **The dish/ingredient boundary.** "Food" is fuzzy at the edges — a raw lemon, an
  empty plate, a mixed platter. A crisp dish classifier has no clean answer there.

---

## 5. SeeFood vs. FoodLens — the trade, stated plainly

| | FoodLens (CHAMP) | SeeFood |
| --- | --- | --- |
| Approach | Supervised, **fine-tuned** CNN with a food hierarchy | **Frozen** multimodal embedding + retrieval + a decision model |
| Training data | ~30K hand-annotated images, ~140 dishes | None — no fine-tuning; ~80 dishes with photo prototypes, ~7K by text |
| Labels | **Multi-label**, hierarchical | Single top dish + "No food" |
| Strength | Fine-grained accuracy on its trained classes | Breadth; extend by adding data, no labeling |
| Weakness | Bounded to its trained classes and labeling effort | Weaker fine-grained separation; long tail is thin |

Neither is strictly better; they optimize different things. FoodLens buys
fine-grained precision with a labeling campaign and training. SeeFood buys breadth
and speed-to-extend by refusing to train — and pays for it exactly where §4 shows.

---

## 6. What would close the gap

Honest next steps, roughly in order of expected return:

1. **Give the long tail real visual anchors.** Replace single-image prototypes
   with *multi-image* centroids (the method that got the core to 0.95) for the
   dishes that matter — including Tatte idli.
2. **Light fine-tuning / an adapter.** A small trained head on top of the frozen
   embedding, on dish photos, would teach the fine-grained boundaries we currently
   lack — the FoodLens lesson, at a fraction of its cost.
3. **An input-quality gate.** Detect blur / low information and ask for a better
   photo instead of guessing — this alone kills the lemon→ladoo class of error.
4. **Surface uncertainty.** Jev already returns calibrated confidence; show "looks
   like X, but unsure" (or the top three) below a threshold instead of asserting a
   shaky single answer.
5. **Multi-label plates.** Detect-then-classify per region so a thali returns
   several dishes, as FoodLens does.
6. **A presence check.** A separate "is this a prepared dish at all?" judgment to
   handle ingredients, empty plates, and non-food cleanly.

The through-line, again: the system is a stack of signals arbitrated by
confidence, built deliberately *without* training. Its failures are the honest,
legible cost of that choice — and each one has a known, affordable fix.

---

## Sources

- [FoodLens: Fine-Grained and Multi-label Classification of Indian Food Images — Google Research](https://research.google/pubs/foodlens-fine-grained-and-multi-label-classification-ofindian-food-images/)
- [FoodLens — Springer](https://link.springer.com/chapter/10.1007/978-3-032-01169-5_16)
- [Single-item training for multi-dish recognition: a class-agnostic framework for Indian food platters](https://www.researchgate.net/publication/401755093_Single-item_training_for_multi-dish_recognition_a_class-agnostic_framework_for_Indian_food_platters)
