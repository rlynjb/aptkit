# 05 — Evals and observability

This is the standout section of the guide. Most AI-engineering codebases ship a
demo and a prayer; AptKit ships a real eval layer — a `@aptkit/evals` package
with structural diffing, detection scoring, an LLM-as-judge, replay-artifact
assertions, and a promote-to-fixture pipeline that freezes live runs into a
regression baseline. Everything below is anchored to code that runs in CI, not
to a whiteboard.

**Reading note.** Read these in order. `01` frames *what you collect* (the eval
sets), `02` walks *how you score* (the method ladder), `03` is the deep cut on
*why your judge lies to you* and how AptKit's rubric contract defends against
it, and `04` is the observability spine (traces, usage, replay) that makes all
of it inspectable. `02` and `03` are the load-bearing pair — if you read two,
read those.

## Concept files

1. [01-eval-set-types.md](01-eval-set-types.md) — golden / adversarial /
   regression sets. AptKit reality: promoted fixtures are a frozen correctness
   baseline (a regression set); per-agent fixtures are golden-ish; there is no
   adversarial set yet (marked honestly, and Case A builds one).

2. [02-eval-methods.md](02-eval-methods.md) — the method ladder from exact match
   up to human review. AptKit exercises structural match
   (`structural-diff.ts`), detection scoring (`detection-scorer.ts`,
   precision/recall-style), and LLM-as-judge (`rubric-judge.ts`).

3. [03-llm-as-judge-bias.md](03-llm-as-judge-bias.md) — position, verbosity, and
   self-preference bias. How AptKit's `RubricJudge` contract — scale clamping,
   verdict allowlist, forced per-dimension justification, calibration anchors —
   defends against each, and where it still doesn't (no order randomization).

4. [04-llm-observability.md](04-llm-observability.md) — the three pillars:
   traces (`CapabilityEvent` NDJSON), usage/cost (`usage-ledger.ts`), and replay
   (the artifact → eval → promote pipeline). Includes the secret-scanning detail
   in `assertions.ts`.

## Where this sits in the family

- The agent loop that *produces* the traces and outputs these evals consume:
  [../04-agents-and-tool-use/03-react-pattern.md](../04-agents-and-tool-use/03-react-pattern.md).
- The token-cost foundation behind usage scoring:
  `../01-llm-foundations/06-token-economics.md` (forward reference — not yet
  generated).
- Eval-driven prompt iteration lives in the sibling guide:
  [../../study-prompt-engineering/05-eval-driven-iteration.md](../../study-prompt-engineering/05-eval-driven-iteration.md).
