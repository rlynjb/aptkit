# 01 — LLM foundations

> Anchor: LLM application engineering. · Curriculum: Phase 1 (no curriculum file
> in this repo; exercises cite real aptkit/buffr paths instead).

The interface, not the architecture. What an LLM is as a function, how text
becomes tokens, what the sampling knobs do, and the four engineering patterns
aptkit uses to put a model into production: structured outputs, provider
abstraction, heuristic-before-LLM routing, and override locks.

These move fast — you've shipped AdvntrCue, so the shapes are familiar. The slow
part is where aptkit's choices differ from a cloud-first app: the default model
is **local Gemma with no native tool-calling**, which forces emulation and
shapes nearly everything downstream.

## Files (self-contained per concept)

1. `01-what-an-llm-is.md` — the IO model; why `ModelProvider.complete()` is the right shape
2. `02-tokenization.md` — tokens as the unit; the char-per-token estimator in the context guard
3. `03-sampling-parameters.md` — temperature/top-p/top-k; why classifiers run deterministic
4. `04-structured-outputs.md` — `generateStructured` + validators; JSON or it errors
5. `05-streaming.md` — NDJSON trace streaming (the repo streams traces, not tokens — `not yet exercised` for token streaming)
6. `06-token-economics.md` — the usage ledger; OpenAI-only pricing, Gemma free
7. `07-heuristic-before-llm.md` — `parseIntent` keyword shortcut before the LLM
8. `08-provider-abstraction.md` — the load-bearing seam; how buffr swaps the store
9. `09-user-override-locks.md` — `not yet exercised` in aptkit; the pattern and where it would live
