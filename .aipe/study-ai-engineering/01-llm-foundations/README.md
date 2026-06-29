# 01 — LLM foundations

> Anchor: LLM application engineering (loopd-shaped) — aptkit's home territory.
> Curriculum: Phase 1.

What the model is, and how aptkit talks to it. This is the layer that turns
"call an LLM" into a provider-neutral, cost-aware, validated interface.

The crown jewel here is the **provider abstraction**
(`ModelProvider.complete()`) and the **emulated tool calling** on Gemma —
a local model with no native tool API.

## Files

- `01-what-an-llm-is.md` — the IO model; the model as a function, not a database.
- `02-tokenization.md` — tokens vs characters; how aptkit estimates them (char-ratio guard).
- `03-sampling-parameters.md` — temperature/top-p/top-k; where aptkit sets them.
- `04-structured-outputs.md` — `generateStructured` + validators; typed contracts at the LLM boundary.
- `05-streaming.md` — `not yet exercised` for LLM tokens; NDJSON streams events instead.
- `06-token-economics.md` — the `usage-ledger.ts` cost ledger (OpenAI-only pricing).
- `07-heuristic-before-llm.md` — the coverage gate as the heuristic filter before the model.
- `08-provider-abstraction.md` — `ModelProvider`, the factory, the fallback chain, the context guard.
- `09-user-override-locks.md` — the pattern, and why aptkit (a core lib) doesn't own this state yet.

Self-contained per concept; read `08-provider-abstraction.md` and
`04-structured-outputs.md` first if you only read two.
