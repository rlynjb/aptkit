# Transfer learning

**Subtitle:** pretrain on the general, fine-tune on the specific · *Language-agnostic*

## Zoom out, then zoom in

aptkit trains no models, so the stack below is the *generic* supervised pipeline
with one box re-labeled. Transfer learning does not add a new arc — it changes
where the starred model box *comes from*. Instead of fitting `f` from scratch on
your small dataset, you start from a model that already learned general
representations on a huge dataset, and adapt only its top.

```
  Zoom out — the pipeline, with the model box arriving pre-built

  ┌─ Data layer ───────────────────────────────────────────────────┐
  │  your SMALL labeled dataset (thousands of rows, not millions)   │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ featurize
  ┌─ Feature layer ───────────▼─────────────────────────────────────┐
  │  raw input → numeric X   (or: a pretrained encoder produces X)  │
  └───────────────────────────┬─────────────────────────────────────┘
                              │
  ┌─ Model layer ─────────────▼─────────────────────────────────────┐
  │  ★ PRETRAINED BACKBONE ★  learned on a huge general corpus      │
  │  ─────────────────────────────────────────────                  │
  │  + small HEAD you fit on YOUR data                              │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ ship
  ┌─ Serving layer ───────────▼─────────────────────────────────────┐
  │  backbone + head; same feature/encoder code at inference        │
  └──────────────────────────────────────────────────────────────────┘
```

Now zoom in. The intuition: someone already paid the enormous cost of teaching a
model what text (or images, or audio) *looks like* in general. That knowledge
lives as learned representations inside the model. You inherit those for free and
spend your tiny labeled budget only on the last mile — mapping those
representations to *your* labels. You do not relearn language to classify intent;
you stand on a model that already learned language.

## Structure pass

**Layers.** General pretraining (someone else's, on a huge dataset) → inherited
representations → your small head fitted on your task. The bottom two layers are
*given*; only the top is yours.

**Axis — what is learned vs what is inherited.** Trace any weight in the final
model and ask "who paid for this?" The backbone weights were paid for by the
pretraining run — millions of examples, GPU-months. The head weights were paid
for by your few thousand labeled rows. Transfer learning is the discipline of
keeping that ratio sane: inherit the expensive part, learn only the cheap,
task-specific part.

**Seam.** The load-bearing boundary is the **frozen-vs-trained line** — the layer
where you stop updating inherited weights and start updating your own. Above the
line: weights you fit. Below it: weights you keep. Where you draw that line is the
single biggest decision in transfer learning, and the next section is built
around it.

## How it works

### Move 1 — the mental model

You already use the ultimate transferred model every day: the LLM. A pretrained
LLM is exactly this pattern at its extreme — pretrained on an enormous general
corpus, then (by its vendor) lightly fine-tuned to follow instructions. When you
call `complete()` in aptkit you are *consuming* transfer learning's output: a
backbone someone else trained, adapted with a small head someone else fit. aptkit
stops there — it uses the transferred model but never fine-tunes it. That is the
whole relationship: aptkit is a *user* of transfer learning, not a *doer* of it.

```
  Pattern — pretrain once (expensive), adapt many times (cheap)

   huge general dataset          your small task dataset
   ┌──────────────────┐          ┌──────────────────┐
   │ web-scale text /  │          │ a few thousand   │
   │ a giant corpus    │          │ labeled rows     │
   └────────┬──────────┘          └────────┬─────────┘
            │ pretrain (GPU-months,         │ fine-tune (minutes/hours,
            │ done ONCE by someone else)    │ done by YOU)
            ▼                               ▼
   ┌──────────────────┐   reuse    ┌──────────────────┐
   │ BACKBONE          │ ─────────►│ backbone + small  │ ──► your predictions
   │ (representations) │  frozen    │ HEAD (yours)      │
   └──────────────────┘            └──────────────────┘
```

The same backbone seeds many tasks. You pay the head cost once per task; the
backbone cost is amortized across everyone who ever reuses it.

### Move 2 — feature-extraction vs full fine-tune

The seam (frozen-vs-trained line) has two canonical positions. Both are transfer
learning; they trade data-hunger against accuracy ceiling.

**Feature extraction — freeze the backbone, train only a head.** Run your inputs
through the frozen pretrained model, take its output vector as fixed features,
and fit a small classifier on top. The backbone never changes; you only learn the
head. This is the move when your dataset is small.

```
  Feature extraction — backbone frozen (║ = no gradient updates)

   input ─► ┌───────────────────┐ ║ embedding ─► ┌──────────┐ ─► ŷ
            │ PRETRAINED BACKBONE│ ║  (frozen     │ small    │
            │   ║ FROZEN ║       │ ║   vector)    │ HEAD     │
            └───────────────────┘ ║              └──────────┘
                 not trained                      ▲ the only
                                                    weights you fit
```

```text
# PSEUDOCODE — feature extraction for a learned reranker.
# The pretrained encoder is nomic-embed-text:v1.5 (768-dim), the SAME model
# buffr already uses for retrieval (PgVectorStore, dim 768). It is our backbone.

backbone = load_pretrained_encoder("nomic-embed-text:v1.5")  # frozen; no updates
backbone.freeze()                                            # the SEAM: below = frozen

def featurize(query, doc):
    qv = backbone.embed(query)        # 768-dim, inherited representation
    dv = backbone.embed(doc)          # 768-dim, inherited representation
    return concat(qv, dv, [cosine(qv, dv)])   # frozen features feeding the head

head = LogisticRegression()           # the ONLY thing we train; ~hundreds of weights
X = [featurize(q, d) for (q, d) in labeled_pairs]   # small dataset
head.fit(X, labels)                   # minutes, not GPU-months

# serve: rerank candidates from PgVectorStore.search(vector, k) by head.predict_proba
```

**Full fine-tune — unfreeze (some of) the backbone too.** Continue training the
backbone's weights on your data, usually at a tiny learning rate, so the inherited
representations bend slightly toward your task. Higher ceiling, but needs more
data or it overfits and *forgets* what it knew.

```
  Full fine-tune — seam pushed DOWN; upper backbone now trainable

   input ─► ┌───────────────────┐  embedding ─► ┌──────────┐ ─► ŷ
            │ lower backbone     │ ║             │ HEAD     │
            │   ║ FROZEN ║       │ ║             │ (trained)│
            ├───────────────────┤ ◄── seam      └──────────┘
            │ upper backbone     │      moved
            │   (trained, tiny lr)│      here
            └───────────────────┘
```

```text
# PSEUDOCODE — full fine-tune. Same backbone, but gradients now flow into it.
backbone = load_pretrained_encoder("nomic-embed-text:v1.5")
freeze(backbone.layers[:N])           # keep the bottom; SEAM is at layer N
unfreeze(backbone.layers[N:])         # adapt the top — these weights change
head = MLP()

optimizer = Adam(lr=1e-5)             # TINY lr: nudge, don't overwrite, the backbone
for epoch in range(few):              # few epochs — more invites forgetting
    for (q, d, label) in labeled_pairs:
        z = backbone(q, d); pred = head(z)
        loss = bce(pred, label)
        loss.backward(); optimizer.step()   # updates head AND upper backbone
# Risk if data is small: catastrophic forgetting — the backbone loses generality.
```

The decision rule: **little data → feature extraction; more data + the accuracy
matters → full fine-tune.** Start frozen; only unfreeze when a frozen head has
clearly plateaued.

**Move 2.5 — the aptkit reality.** Not yet exercised in aptkit — aptkit runs
pre-trained LLMs, not trained models. The pattern is taught here as study ground.

### Move 3 — the principle

Spend your scarce resource — labeled data — only on the part no one else could
have learned for you. The general structure of language or images is a sunk cost
someone already paid; inherit it. Draw the frozen-vs-trained seam as high as your
data budget allows, and lower it only when the evidence (a plateaued frozen head)
demands it. Transfer learning is leverage: a small head on a giant backbone beats
a giant model trained from scratch on a small dataset, almost every time.

## Primary diagram

For tabular/retrieval work there is no giant pretrained backbone for your *rows* —
but there is one for your *text*. buffr already runs it. The reranker design falls
straight out of treating that embedding model as the frozen feature extractor.

```
  Transfer learning in buffr's world — the embedding model IS the backbone

  PRETRAINED (someone else, web-scale)        YOURS (small, on your data)
  ┌─────────────────────────────────┐        ┌──────────────────────────┐
  │ nomic-embed-text:v1.5            │ ║      │ learned reranker HEAD     │
  │ frozen feature extractor, 768-d  │ ║ ────►│ f(qv,dv) → relevance ŷ    │
  │ (buffr already consumes this in  │ ║      │ fit on (query,doc,label)  │
  │  PgVectorStore for retrieval)    │ ║      └──────────────────────────┘
  └─────────────────────────────────┘ ║                 │
        ▲ inherited representations    ║ THE SEAM        ▼
        no gradients flow below here ──╜          rerank PgVectorStore.search()
                                                   → {id,score,meta}[] by ŷ
   score with scorePrecisionAtK / scoreRecallAtK (packages/evals) — same metric
```

## Elaborate

The hard-won lesson: from-scratch training is almost never the right first move
when a relevant pretrained model exists. A reranker trained from scratch on a few
thousand labeled pairs will lose to a logistic-regression head sitting on frozen
768-dim embeddings, because those embeddings already encode semantic similarity —
the thing the reranker most needs. The embeddings are *general* knowledge bought
at web scale; your head supplies the *specific* knowledge of what "relevant" means
for your corpus. Two failure modes bracket the practice: freeze too much and the
head can't express your task; unfreeze too much on too little data and the
backbone forgets its generality (catastrophic forgetting). The frozen-vs-trained
seam is where you tune between them, and "start frozen, unfreeze only on evidence"
is the safe default. Note buffr is already *halfway* here — it consumes the
pretrained embedding as a frozen feature extractor for *retrieval*; adding a
learned head on top of those same vectors is the textbook second step.

## Project exercises

### Build a feature-extraction reranker head on frozen buffr embeddings
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a script that, for each query in
  `/Users/rein/Public/buffr/eval/queries.json`, retrieves candidates via the
  existing vector store, builds features from the *frozen* `nomic-embed-text:v1.5`
  embeddings (`[query_vec, doc_vec, cosine]`), and fits a small logistic-regression
  head to predict relevance. The embedding model stays frozen — you train only the
  head.
- **Why it earns its place:** it is transfer learning in its purest, smallest form
  — frozen backbone, trained head — on a backbone the repo already runs, so you
  feel the leverage directly.
- **Files to touch:** new `/Users/rein/Public/buffr/eval/rerank-head.ts`, reading
  `/Users/rein/Public/buffr/eval/queries.json` and
  `/Users/rein/Public/buffr/src/pg-vector-store.ts`.
- **Done when:** the trained head re-sorts candidates and `scorePrecisionAtK`
  (`packages/evals/src/precision-at-k.ts`) over the reranked order is reported next
  to the raw-retrieval baseline, frozen-vs-trained boundary stated in a comment.
- **Estimated effort:** `1–4hr`

### Write the frozen-vs-trained decision note for a learned intent classifier
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a design note for a learned replacement of
  `packages/agents/query/src/intent.ts` that decides where to draw the
  frozen-vs-trained seam: feature extraction (frozen embedding → small head) vs
  full fine-tune, justified by the available labeled-data volume, with the
  catastrophic-forgetting risk named.
- **Why it earns its place:** the seam placement is the central transfer-learning
  judgment; making it *before* code, tied to a data budget, is the senior move.
- **Files to touch:** new
  `/Users/rein/Public/buffr/docs/intent-transfer-learning.md`.
- **Done when:** the note picks feature-extraction-first, states the data
  threshold at which it would unfreeze, and names which encoder serves as the
  frozen backbone.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "What is transfer learning, and why not just train from scratch?"**
You start from a model pretrained on a huge general dataset and adapt only the
top to your small task, inheriting expensive learned representations instead of
relearning them. From-scratch loses because your labeled budget is tiny relative
to what the backbone already absorbed — a small head on a giant frozen backbone
beats a giant model fit on a small dataset.

```
  huge general data ─► BACKBONE (inherit) ─╥─► small HEAD (you fit) ─► ŷ
                          frozen, free       ║   your few labels go here
```
*Anchor: spend labeled data only on what no one else could have learned for you.*

**Q: "Feature extraction or full fine-tune — how do you choose?"**
By data volume. Little data: freeze the backbone, train only a head — fewest
trainable weights, least overfit. More data and accuracy matters: unfreeze the
upper backbone at a tiny learning rate to bend representations toward the task,
accepting catastrophic-forgetting risk. Default: start frozen, unfreeze only when
a frozen head has plateaued.

```
  small data ─► FREEZE backbone, train head      (seam high)
  more  data ─► unfreeze upper backbone, tiny lr  (seam pushed down)
                 ▲ risk: forgetting if you go too far
```
*Anchor: the frozen-vs-trained seam moves with your data budget, not your ambition.*

## See also

- `01-supervised-pipeline.md` — the arc whose model box this section pre-builds
- `02-feature-engineering.md` — what a frozen encoder replaces (or feeds)
- `01-llm-foundations/01-what-an-llm-is.md` — the transferred model aptkit consumes
