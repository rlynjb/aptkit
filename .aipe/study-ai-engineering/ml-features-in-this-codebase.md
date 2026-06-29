# How aptkit uses ML specifically

Short, honest answer: **aptkit does not train, deploy, or run any classical
machine-learning model.** There is no supervised pipeline, no feature
engineering, no train/val/test split, no on-device classifier, no
recommender model. Everything aptkit calls "intelligence" is a pre-trained
LLM behind the `ModelProvider` contract or a from-scratch RAG pipeline —
both AI engineering, not classical ML.

The classical-ML concepts in `08-machine-learning/` and
`09-ml-system-design-templates/` are covered as **study material and
buildable exercises**, not as descriptions of shipped code. This codebase
is the LLM-application-engineering shape (loopd-shaped), not the
classical-ML shape (contrl-mo-shaped). The reader's contrl project is the
place that lived ML; aptkit is not.

## The one genuine bridge

There is exactly one place where aptkit touches classical-ML vocabulary
for real: the **ranked-retrieval scorer**.

```
  ML features table — what's actually here

  ┌──────────────────────┬────────────────┬────────────────────────────┐
  │ Feature              │ "Model" type   │ Status                     │
  ├──────────────────────┼────────────────┼────────────────────────────┤
  │ precision@k /        │ none — it's a  │ SHIPPED. Scores ranked     │
  │ recall@k scorer      │ metric, not a  │ retrieval, the same metric │
  │                      │ trained model  │ a recommender/search ranker│
  │                      │                │ is evaluated with.         │
  ├──────────────────────┼────────────────┼────────────────────────────┤
  │ Form classifier      │ —              │ not yet exercised          │
  │ Progression rec.     │ —              │ not yet exercised          │
  │ On-device inference  │ —              │ not yet exercised          │
  │ Drift detection      │ —              │ not yet exercised          │
  └──────────────────────┴────────────────┴────────────────────────────┘
```

`scorePrecisionAtK` / `scoreRecallAtK`
(`packages/evals/src/precision-at-k.ts`) compute the exact metrics used to
evaluate any ranking system — a search ranker, a recommender's candidate
generation, a retrieval pipeline. aptkit uses them to score RAG retrieval
(in Studio's `runRagQueryFixtureReplay`), but the metric is identical to
what you'd use to evaluate a learned ranker. That makes it the one honest
foothold for the ML-evals concepts. See
`08-machine-learning/README.md` for how the rest of the section is taught
as new ground.

## Why this is the right call, not a deficiency

aptkit's job is to be the deployment-agnostic *core* of an agent system.
Classical ML — training loops, feature stores, model registries — is
product- and domain-specific, exactly the thing the monorepo exists to
keep out of the core. The absence is deliberate. The ML concepts still
earn study time because they're the rarest interview signal (most
candidates have only *consumed* pre-trained models), and because the
reader has one real ML project (contrl) to anchor the concepts against
when the curriculum exercises call for it.
