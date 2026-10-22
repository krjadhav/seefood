# SeeFood: The Accuracy Journey

This is the story of making SeeFood recognize a dish — told as it actually
happened, discovery by discovery. It is not a tidy method; it is a sequence of
things that broke, what each break taught us, and the fix that followed. It ends
honestly, with two images the system still gets wrong and why.

The system never learns. There is no training, no fine-tuning. Every gain below
came from understanding the model we already had and doing better arithmetic on
its output. That constraint shaped everything, including the failures.

---

## Where it started: a joke that turned out to be possible

SeeFood began as "hotdog or not hotdog." The first question was whether an
embedding model could even see food at all — the familiar version of this model
is text-only. Reading its config settled it: this one has a vision encoder and
maps images and text into **one shared space**. That single fact is the whole
foundation. You can embed a photo, embed the words "masala dosa," and measure how
close they are. No custom image classifier required.

**Discovery:** the cheapest accuracy win is the subsystem you *don't* build.
Reading the datasheet replaced a whole vision model with one embedding space.

---

## First attempt: words are a weak picture

The obvious approach: embed the photo, embed `"a photo of {dish}"` for each
candidate, pick the nearest. "Not food" falls out by adding non-food phrases.

It worked — about **75%** of the time. Good enough to prove the idea, not good
enough to trust. The lesson was quiet but important: **a text description is a
weak stand-in for how a dish looks.** "Masala dosa" the phrase and masala dosa the
photo are only loosely aligned. To do better, we had to compare photos to photos.

---

## Prototypes, and the wall we hit: the cosine cone

So we built **visual prototypes**: for each of 80 core dishes, average ~40 real
photos into one representative vector, then match a new photo to the nearest one.

It nearly didn't work. When we measured the scores, every prototype sat at almost
the same distance from every photo — all bunched around 0.9. Food-on-a-plate
photos, it turned out, occupy a **narrow cone** of the embedding space. The
"nearest" prototype was barely nearer than the rest, and the scores were useless
as confidence.

**Discovery:** the model packs all food into a tight region. Raw distance inside
that region is almost no signal. An absolute threshold on it means nothing.

---

## The breakthrough: mean-centering

The fix is the one result worth remembering. Every prototype shares a common
direction — the generic "food on a plate" component. If you **subtract the
average direction of all prototypes** from both the photo and the prototypes
before comparing, what remains is what makes each dish *distinct*.

Held-out top-1 accuracy jumped from **0.75 to 0.95**. Just as important, the
scores finally spread out — a dosa photo now scored 0.22 for masala dosa, 0.20 for
rava dosa, 0.15 for neer dosa, instead of everything tied at 0.77. Same photos,
same model, same prototypes; we just removed the part they all had in common.

**Discovery:** when everything you compare shares a bias, subtract it. The signal
was always there, hidden under the average.

A smaller lesson rode along. An early calibration stat looked alarming — positive
matches seemed to overlap wrong-dish matches almost completely. But it measured
the *nearest other* dish, which is pessimistic when many dishes are near-twins
(masala / rava / neer / set dosa). The number that mattered — actual top-1 — was
0.95. **Trust the end-task measurement over a scary intermediate one.**

---

## The regression that taught us the real problem: hotdog → pizza

With prototypes naming every food photo, we fed it a hotdog. It said **pepperoni
pizza**. The text pool had quietly answered "hotdog" correctly, but the prototype
match — forced to pick *one* of the dishes it knew — grabbed the nearest and
overrode it.

We tried the obvious fix: a threshold to decide "is this really one of my known
dishes?" It became whack-a-mole. We measured why:

```
dosa   (known, correct)     score 0.220   margin 0.021
burger (unknown, wrong)     score 0.349   margin 0.024
```

The **correct known dish scored lower than a wrong unknown one**, with
indistinguishable margins. No single number could separate "I know this" from "I
don't." dosa's low score came from competing with its own cousins; burger's from
being genuinely unfamiliar.

**Discovery:** a threshold can't tell confidence from confusion. "Known vs
unknown" is not a line on the score axis. Something that actually *looks* at the
image has to make the call.

---

## More data, more trouble: thousands of single-image prototypes

To cover more than 80 dishes, we added ~6,500 prototypes from a recipe dataset —
but each was a **single** photo, not an average of forty. Noisy anchors.

They misbehaved in three distinct ways, and each was its own lesson:

- **Non-food detection collapsed.** With thousands of food descriptions in the
  pool, *some* food always out-scored the ~40 non-food phrases; a plain text
  document came back as a dessert. *Fix: decide food-vs-not using only the small,
  curated label set — never let the big catalog vote on that question.*
- **Single images stole known dishes.** A noisy one-photo "spring rolls" anchor
  beat the 40-photo samosa prototype. We tried bribing the good prototypes with a
  bonus; it was whack-a-mole again. *Fix: a hard tier — prefer a core multi-image
  prototype whenever it clears a floor; only fall to single-image anchors below
  it.*
- **Weak anchors gave confident-sounding wrong names.** An out-of-set food landed
  on a semantically close single-image anchor with a *low* score. *Fix: trust a
  single-image anchor only when its score is high; otherwise defer.*

**Discovery:** a "prototype" built from one image is really a retrieval anchor,
not a reliable centroid. More coverage is not free — it arrives wrapped in noise,
and every new source needs a guard.

---

## The real turn: stop deciding with thresholds, decide with a model

The threshold logic had grown into a thicket. The fix was structural: **separate
retrieval from decision.** The embedding is good at *narrowing* thousands of
dishes to a shortlist of ~254. A decision model — one that **sees the photo** —
is good at *picking* the right one from a short list.

We wired in TypeSafe Jev for the decision. The discovery reading its SDK was the
pleasant surprise: the public docs said text-only, but the installed code exposed
an image input. Jev can **see the photo**, choose from the 254 candidates plus
"No food," and return a **calibrated confidence**. On the core set it answered
every case correctly at 0.5–1.0 confidence in a few hundred milliseconds.

**Discovery:** don't force one tool to both narrow and decide. Cheap math narrows;
a model that sees the image decides. And confidence — a single honest number —
replaces a pile of hand-tuned thresholds.

---

## The last twist: coverage brings look-alikes

When we loaded the full ~7,000-dish catalog, the shortlist filled with
near-duplicates, and Jev — shown a fried samosa among hundreds of fried snacks —
picked "veg fried wontons" at **0.3** confidence. Correct answers stayed high
confidence; the wrong ones were visibly *un*confident.

That low number was the opening. Two guards closed it: **seed** the shortlist with
the visual prototypes' top matches (so the right dish is always on the menu), and
**when Jev is unsure and disagrees with a confident core prototype, keep the
prototype.** The reliable 80-dish core wins ties; Jev owns the long tail and the
food/not-food call. The sample sweep returned to 8/8 — samosa, biryani, and
margherita pizza recovered by the guard; the rest decided by Jev.

**Discovery — the whole journey in one line:** every new capability added both
coverage and noise, and the winning move was never to *replace* the old signal
but to *layer* the new one and let a calibrated score decide which to trust.
Mean-centering over raw cosine. Curated over catalog. Core over long tail.
A confident prototype over an unsure model.

---

## Why it is still not perfect

Two real misses show exactly where the approach runs out.

### Tatte idli → Neer dosa

A Tatte idli (thick, plate-steamed, pale, round) was called a Neer dosa (thin,
white, rice crepe). Two causes stack.

First, these dishes genuinely *look* alike: pale, white, soft, rice-based. In the
model's space, "pale round white rice dish" is a tight neighborhood. Nothing ever
taught the model the fine line between them, so it sees them as near-neighbors —
and they are.

Second, Tatte idli is **long tail**. It has no strong multi-image prototype — only
a text entry and a noisy single image. Our confidence guard can only protect a
dish that *has* a reliable anchor. Tatte idli doesn't, so there is nothing to
override the pull toward the nearest pale-white dish it *does* know.

**What this teaches:** the guard protects the core; the tail is only as good as
its weakest anchor. Fine-grained look-alikes in the long tail are exactly where
we have the least to stand on.

### A blurred lemon → besan ladoo

Photographed sharp, a lemon is obviously a lemon. Blurred, it became a besan
ladoo (a yellow round sweet). Blur is a low-pass filter — it erases
high-frequency detail (the lemon's pores, the ladoo's grainy surface) and leaves
only coarse structure: a **yellow sphere**. A besan ladoo *is* a yellow sphere.
Once the distinguishing texture is gone, the two collapse to the same coarse
description, and any decision is a coin-flip among look-alikes on the evidence
that survived.

Two edges make it worse. A lemon is a raw **ingredient**, not a prepared dish —
the fuzzy boundary of "is this even a dish?" And there is no lemon anchor, so
nothing high-precision pulls toward the right answer. Shown a blurry yellow blob,
the model picks the yellow round *food* it was offered.

**What this teaches:** garbage in, confident garbage out. We never check whether
the photo carries enough information to decide, so we answer anyway.

### The limits underneath, named plainly

- **Fine-grained similarity.** A frozen, untrained model can't resolve
  distinctions it never learned; the look-alikes are honestly close in its space.
- **A thin long tail.** Dishes outside the ~80-prototype core have weak anchors,
  so the confidence guard can't protect them.
- **Input quality.** Blur, bad light, odd angles, partial plates strip the detail
  that separates fine-grained classes — and we neither detect nor reject it.
- **One label per photo.** We name a single dish; a real thali holds many.
- **The dish/ingredient edge.** "Food" is fuzzy at the boundary — a raw lemon, an
  empty plate, a mixed platter have no clean single answer.

---

## What we'd do next

Roughly in order of expected return:

1. **Give the long tail real anchors.** Replace single-image prototypes with
   multi-image centroids — the exact method that took the core to 0.95 — for the
   dishes that matter, Tatte idli among them.
2. **Reject uninformative photos.** A blur / low-information check that asks for a
   better shot instead of guessing. This alone removes the lemon-blob class of
   error.
3. **Show uncertainty.** Jev already returns calibrated confidence; below a
   threshold, say "looks like X, but unsure" or offer the top three rather than
   assert a shaky single answer.
4. **Handle plates.** Detect regions, then classify each, so a thali returns
   several dishes instead of one.
5. **Ask "is this a dish at all?"** A separate presence check to handle
   ingredients, empty plates, and non-food cleanly.

The honest summary: SeeFood is a stack of signals arbitrated by confidence, built
on purpose *without* training. Its wins came from understanding the model's
quirks — the cosine cone, the shared bias, the difference between narrowing and
deciding. Its failures are the legible cost of that choice, and each one has a
known, affordable fix.
