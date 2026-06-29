# 05 — Evals & observability

> Anchor: LLM application engineering. · Curriculum: Phase 5 (no curriculum file
> in this repo; exercises cite real aptkit/buffr paths instead).

This is the strongest layer in aptkit, and the reason the whole repo holds
together. Everywhere else you've seen a model do something useful — emulate tool
calls, run an agent loop, retrieve and ground an answer. This layer is how you
*know* it kept working after you changed it. The connective tissue is one
pipeline, repeated for every capability:

```
  The replay backbone — the spine of every eval in aptkit

  live run  ──►  replay artifact  ──►  eval  ──►  promote  ──►  deterministic
  (real model)   (JSON snapshot)    (assert     (freeze as     replay
                 artifacts/         shape)      a fixture)     (FixtureModel
                 replays/*.json                 fixtures/      Provider, no
                                                promoted/      model at all)
```

Read it left to right and the whole section falls into place. A live run with a
real provider records a **replay artifact** — a JSON snapshot of the run with its
trace, its output, and an embedded eval. You **eval** that artifact's shape. When
it's good, you **promote** it into a timestamped **fixture**. From then on the
capability's tests **replay** that fixture deterministically — no Gemma, no
OpenAI, no network — so a regression shows up as a diff, not a flaky failure.

The signal here is that aptkit didn't bolt on an eval framework. The same
`ModelProvider` seam that lets it run on Gemma or Claude is what lets it swap in a
`FixtureModelProvider` that replays recorded responses. Evals fall out of the
provider abstraction for free. There's no Langfuse, no LangSmith, no jest — just
recorded JSON, Node's built-in test runner, and a local Studio dashboard.

## Files (self-contained per concept)

1. `01-eval-set-types.md` — golden / adversarial / regression; the promoted
   fixtures ARE the golden+regression set; adversarial is `not yet exercised`.
   Bridge: snapshot tests.
2. `02-eval-methods.md` — the cheap→expensive ladder mapped to aptkit's four real
   scorers: structural-diff, detection-scorer, precision@k, rubric-judge. Bridge:
   assertion strength in a test.
3. `03-llm-as-judge-bias.md` — `RubricJudge` and the three judge biases; the
   Claude-judges-Gemma anti-circular design; position/verbosity mitigations
   `not yet exercised`. Bridge: a biased code reviewer.
4. `04-llm-observability.md` — traces / spans / replay; the `CapabilityEvent`
   union; Studio's NDJSON stream; the usage ledger. Bridge: `console.log` →
   structured logs → distributed tracing.

The honest gaps, stated up front so you can defend them: adversarial eval sets
don't exist yet (no adversarial fixture dir), the `rubric-improvement` agent has
no `replay:promoted` wired into its test script the way the other four agents do,
and judge position/verbosity bias mitigations aren't implemented. Everywhere
those gaps appear in the files below they're marked `not yet exercised` — name
them in an interview before someone else does.
