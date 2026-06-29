# 05 — Evals and observability (LLM side)

> Anchor: LLM application engineering (loopd-shaped) — Phase 3.
> The eval/replay harness is aptkit's distinctive strength.

This is where aptkit stands out from most candidate codebases. It has a
real eval ladder: structural-diff, detection-scorer, precision@k/recall@k,
and an LLM-as-judge (`rubric-judge`) — plus a replay/fixture golden-master
loop (`FixtureModelProvider`, promoted fixtures). The anti-circular move —
**Claude judging Gemma** (different model family as judge) — is exactly the
self-preference-bias defense the spec calls for.

## Files

- `01-eval-set-types.md` — golden (promoted fixtures), regression, adversarial; what aptkit has.
- `02-eval-methods.md` — the cheap-to-expensive ladder: structural-diff → detection-scorer → precision@k → rubric-judge.
- `03-llm-as-judge-bias.md` — position/verbosity/self-preference bias; aptkit's anti-circular Claude-judges-Gemma design.
- `04-llm-observability.md` — `CapabilityEvent` traces, replay artifacts, the replay-as-verification loop.

Read `02-eval-methods.md` and `03-llm-as-judge-bias.md` first.
