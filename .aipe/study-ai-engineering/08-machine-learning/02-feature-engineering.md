# Feature engineering

**Subtitle:** raw input → fixed-width numeric vector · *Language-agnostic*

## Zoom out, then zoom in

This is the same generic supervised pipeline from file 01, but now the starred
box is the *feature layer* — the one between the raw rows and the split. Every
later box only ever sees what this box produces.

```
  Zoom out — the supervised pipeline, feature layer starred

  ┌─ Data layer ───────────────────────────────────────────────────┐
  │  raw rows + LABELS  (query, document, was-it-relevant?)        │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ feature engineering ← THIS FILE
  ┌─ Feature layer ───────────▼─────────────────────────────────────┐
  │  ★ featurize(raw) → fixed-width numeric vector X ★              │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ split (file 03)
  ┌─ Split layer ─────────────▼─────────────────────────────────────┐
  │  train · val · test                                            │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ fit
  ┌─ Model layer ─────────────▼─────────────────────────────────────┐
  │  f(X) → ŷ                                                       │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ ship
  ┌─ Serving layer ───────────▼─────────────────────────────────────┐
  │  SAME featurize() at inference                                 │
  └──────────────────────────────────────────────────────────────────┘
```

Now zoom in. A model cannot read a `(query, document)` pair, a date, or the word
"monitoring". It can only multiply numbers. Feature engineering is the code that
turns whatever you have — strings, timestamps, nested objects — into one
fixed-length row of floats. It is unglamorous and it is where 60–80% of the work
and almost all of the production bugs live. The algorithm choice is a footnote
next to this.

## Structure pass

**Layers.** Raw input → transforms (scale, encode, embed, derive) → assembled
numeric vector. Each transform is a small pure-ish function; the feature layer is
the *composition* of them into one wide row of known width.

**Axis — where does error originate?** Trace a wrong prediction back into this
layer. Was a feature uninformative (the model never had the signal)? Was it
computed differently at serve time than at train time (skew)? Did a feature
secretly contain the answer (leakage)? Each of those is a feature-layer failure
that no model can fix, because the model only ever sees `X`.

**Seam.** The load-bearing boundary is **`featurize(raw) → number[]`** — the
single function that maps one raw unit to one fixed-width vector. It must be
*one* function with *two* callers: a batch loop at training time and a single
live call at serving time. The moment those two paths compute features
differently, every metric you measured becomes a lie.

## How it works

### Move 1 — the mental model

You already know `precision@k` from this repo. `scorePrecisionAtK`
(`packages/evals/src/precision-at-k.ts`) grades a *ranked list of ids* — it never
touches features. Feature engineering is the step that produces the numbers a
model uses to *build* that ranked list in the first place. Think of it like a
frontend serializer: a React form holds rich objects, but the wire only accepts a
flat JSON body, so you write one `serialize(formState)` function and run it on
every submit. `featurize` is that serializer — except the wire is a model, the
body is `number[]`, and the width is fixed forever once you train.

```
  Pattern — featurize is a serializer to fixed-width floats

  rich raw input              featurize()            fixed-width vector
  ┌────────────────────┐   ┌──────────────┐       ┌──────────────────────┐
  │ query: "deploy err"│   │ scale        │       │ [0.81, 0.30, 1.0,    │
  │ doc:   {len, text} │──►│ encode       │ ─────►│  0.12, 0.0]          │
  │ ts:    2026-06-01  │   │ embed/derive │       │  (always 5 wide)     │
  └────────────────────┘   └──────────────┘       └──────────────────────┘
   any shape, any types        pure-ish              floats only, same N
```

The hard rule hiding in that diagram: the output is *always the same width, in
the same order, with the same meaning per slot*. Slot 2 is "cosine similarity"
on every row, forever. A model has no column names — position is the only
identity a feature has.

### Move 2 — the transforms, one at a time

Take the running domain: a **learned reranker** over aptkit retrieval. buffr's
`PgVectorStore.search(vector, k)`
(`/Users/rein/Public/buffr/src/pg-vector-store.ts`) already returns
`{ id, score, meta }[]` sorted by cosine similarity. A reranker would re-order
those hits using a model, and that model needs each `(query, hit)` pair turned
into a numeric row. Here is how each raw field becomes a slot.

**Numeric scaling.** Raw numbers come on wildly different ranges: a cosine score
is `[0,1]`, a document length might be `0..5000`. Many models let large-magnitude
features dominate purely because they are large. Scale each numeric feature to a
comparable range so the model weighs them on merit, not on units.

```
  Scaling — put every numeric feature on the same footing

  raw                         scaled (min-max → [0,1])
  cosine_sim  0.81 ─────────► 0.81     (already small)
  doc_length  4200 ─────────► 0.84     (4200 / 5000 cap)
  recency_days  3  ─────────► 0.03     (3 / 90 cap)
```

```text
# pseudocode — fit scaler on TRAIN ONLY, reuse the learned bounds at serve
scaler.fit(X_train)            # learns min/max (or mean/std) per column
X_train = scaler.transform(X_train)
X_serve = scaler.transform(x)  # SAME bounds — never re-fit on serving data
```

The trap is fitting the scaler on the whole dataset: the min/max then carry
information from the test set into training. Fit on train, freeze, reuse.

**Categorical encoding (one-hot).** A model cannot take the string `"monitoring"`.
A categorical field with no order becomes one binary slot per possible value —
"one-hot". Three intents become three columns; exactly one is `1`.

```
  One-hot — one column per category, exactly one is hot

  intent = "diagnostic"
                       is_monitoring  is_diagnostic  is_recommendation
                       ┌────────────┬──────────────┬──────────────────┐
                       │     0      │      1       │        0         │
                       └────────────┴──────────────┴──────────────────┘
```

```text
# pseudocode — categories are FROZEN at train time
CATEGORIES = ["monitoring", "diagnostic", "recommendation"]   # fixed vocabulary
def encode_intent(value):
    return [1.0 if value == c else 0.0 for c in CATEGORIES]    # width = 3, always
    # an unseen category at serve time → all zeros (never widen the vector)
```

Never integer-encode an unordered category as `0,1,2` — that tells the model
`recommendation > monitoring`, an ordering you did not mean.

**Text → counts or embeddings.** Free text needs its own bridge. The cheap route
is counts (how many query terms appear in the doc — `query_term_overlap`). The
rich route is an embedding: a pre-trained model maps text to a fixed-width dense
vector. buffr already embeds with `nomic-embed-text` at 768 dims; the *cosine
score* it produces is itself a feature.

```
  Text → numeric, two routes

  "deploy error" ┌─ counts ──► query_term_overlap = 2   (cheap, 1 slot)
                 │
                 └─ embed ───► [0.02, -0.11, ...]        (rich, 768 slots,
                                                          pre-trained, frozen)
```

```text
# pseudocode — overlap is a derived count; embeddings come pre-trained
def query_term_overlap(query, doc_text):
    q = set(tokenize(query.lower()))
    d = set(tokenize(doc_text.lower()))
    return float(len(q & d))           # one numeric slot
```

**Ratios and derived features.** Often the *relationship* between two raw fields
carries more signal than either alone. `recency_days` derived from a timestamp,
or `overlap / query_length` as a normalized match rate, gives the model the thing
you would have eyeballed yourself.

```
  Derived — encode the relationship, not just the raw fields

  now=2026-06-28, doc_ts=2026-06-25  ──► recency_days = 3
  overlap=2, query_len=3             ──► match_rate   = 0.67
```

**Handling missing values.** Real rows have holes — a doc with no timestamp, a
query with no detected intent. You cannot hand a model `null`. Pick an explicit
policy (impute a sentinel, or impute the train-set median) *and* add a binary
"was-missing" flag so the model can learn that absence itself is signal.

```
  Missing values — impute + flag, never pass null

  recency_days = null
        │ impute median (e.g. 30)        plus a flag column
        ▼
  recency_days = 30.0      recency_was_missing = 1.0
```

```text
# pseudocode — assemble the full reranker feature row
def featurize(query, hit, now):
    overlap = query_term_overlap(query, hit.meta["text"])
    ts = hit.meta.get("ts")
    recency = (now - ts).days if ts else MEDIAN_RECENCY   # impute
    return [
        hit.score,                       # 0: cosine_sim (from PgVectorStore)
        scale_len(len(hit.meta["text"])),# 1: doc_length, scaled
        overlap,                         # 2: query_term_overlap
        recency,                         # 3: recency_days (imputed if null)
        1.0 if ts is None else 0.0,      # 4: recency_was_missing flag
    ]                                    # fixed width 5, fixed order, forever
```

**Move 2.5 — the aptkit reality.** Not yet exercised in aptkit — aptkit runs
pre-trained LLMs, not trained models. The pattern is taught here as study ground.
The closest real artifacts are the *score* that `PgVectorStore.search()` already
emits (a feature in waiting) and the keyword heuristic in
`packages/agents/query/src/intent.ts` — a hand-written `parseIntent` that a
trained classifier would replace, with the same string-to-numeric featurization
described above.

### Move 3 — the principle

A feature is a *contract slot*: fixed position, fixed meaning, computed by one
function that runs identically at train and serve time. Spend your effort here,
not on the algorithm — informative, leak-free, skew-free features beat a fancier
model on the same data almost every time. The feature function is the seam where
"works in the notebook" turns into "fails in prod," so treat it as production
code, not notebook scratch.

## Primary diagram

```
  Feature engineering — one function, two callers, fixed width

  TRAINING (batch)                         SERVING (one request)
  ┌──────────────┐                         ┌──────────────┐
  │ labeled rows │                         │ one (q, hit) │
  │ (q, hit, y)  │                         │ live pair    │
  └──────┬───────┘                         └──────┬───────┘
         │            ★ same featurize() ★        │
         ▼   ┌──────────────────────────────┐  ◄─┘
             │ scale · one-hot · embed ·     │
         ▼   │ derive · impute+flag          │   ← THE SEAM
             └──────────────┬────────────────┘
                            ▼
            ┌──────────────────────────────────────┐
            │ X = [cosine, doc_len, overlap, ...]   │  fixed width, fixed order
            └──────────────┬────────────────────────┘
                           ▼
                    f(X) → ŷ  ──►  ranked ids  ──►  scorePrecisionAtK(...)
```

The arrow on the far right is the whole bridge: feature engineering feeds the
model, the model emits ranked ids, and `scorePrecisionAtK` grades *those ids* —
it never sees `X`. Features are graded only indirectly, through the output.

## Elaborate

Two failure modes dominate this layer, and both are invisible in a notebook.
First, **train/serve skew**: the notebook lowercases the query, the serving path
forgets to, so slot 2 (`query_term_overlap`) silently shifts and accuracy craters
in prod with green tests. The fix is structural — *one* `featurize` module
imported by both callers, never two copies. Second, **leakage from a feature**:
you accidentally include a column that encodes the label. For the reranker, the
sin is feeding in the position the *current* retrieval already assigned, or any
field derived from the known-relevant set — the model scores 0.99 offline and
random in prod because that column does not exist at serve time. A leaked feature
and a skewed feature look identical from the metric alone; you find them by
asking, for every slot, "is this computable from a single live request, the same
way, before the answer is known?" If not, cut it. This is why files 02 and 03 are
longer than file 04: the model is easy; honest features are not.

## Project exercises

### Build the reranker feature function

- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a pure `featurize(query, hit, now)` module returning a
  fixed-width `number[]` — `[cosine_sim, doc_length_scaled, query_term_overlap,
  recency_days, recency_was_missing]` — consuming the `{id, score, meta}` shape
  that `PgVectorStore.search()` returns, plus a unit test asserting every output
  is the same length regardless of input.
- **Why it earns its place:** the feature function is the seam the entire section
  depends on; building it as one importable module is what prevents train/serve
  skew before any model exists.
- **Files to touch:** new `/Users/rein/Public/buffr/eval/featurize-rerank.ts`
  (reading the hit shape from `/Users/rein/Public/buffr/src/pg-vector-store.ts`)
  and new `/Users/rein/Public/buffr/eval/featurize-rerank.test.ts`.
- **Done when:** the test passes asserting fixed width across varied inputs,
  including a hit with a missing timestamp (imputed value + flag set).
- **Estimated effort:** `1–4hr`

### Audit a candidate feature for leakage

- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a short written checklist applied to each proposed reranker
  feature, answering "is this computable from one live request, the same way, before
  the label is known?" — and flagging at least one leaking feature (e.g. a column
  derived from the known-relevant set in `/Users/rein/Public/buffr/eval/queries.json`).
- **Why it earns its place:** naming leakage and skew before training is the
  senior move; a leaked feature is the single most common reason offline metrics
  beat production.
- **Files to touch:** new `/Users/rein/Public/buffr/docs/rerank-feature-audit.md`.
- **Done when:** the note classifies each slot as safe or leaking, with a
  one-line justification per slot tied to serve-time availability.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "Why does a model need fixed-width numeric features at all?"**
Because a model is matrix math — it multiplies a weight vector by an input vector,
and that only works if every input is the same length, in the same order, all
numeric. There are no column names; slot position *is* the feature's identity.
`featurize` is the function that guarantees that shape on every row.

```
  raw (any shape) ──► featurize ──► [f0, f1, f2, f3, f4]  (always N, always floats)
                                     position = meaning
```
*Anchor: a model has no column names — slot position is the only identity a feature has.*

**Q: "Offline precision@k is 0.95, production is near random. First suspect?"**
The feature layer, not the model. Either train/serve skew (a feature computed
differently in the two paths) or leakage (a feature that encoded the label and
does not exist at serve time). Both are invisible to the metric and both are
fixed in `featurize`, not in the algorithm.

```
  great offline, bad prod ─► skew? ─► leakage? ─► (only then) model?
   both live in featurize(), not the algorithm
```
*Anchor: one featurize() with two callers; every slot must be serve-time-computable before the answer is known.*

## See also

- `01-supervised-pipeline.md` — the arc this feature layer sits inside
- `03-train-val-test.md` — why the scaler is fit on train only
- `05-evals-and-observability/` — `scorePrecisionAtK` grades the output these features feed
