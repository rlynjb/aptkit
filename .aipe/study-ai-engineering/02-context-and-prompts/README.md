# 02 — Context and prompts

The model's only input is the context window — a finite container of tokens. What
you put in it, in what order, and how you keep it from overflowing is the entire
craft of this section. AptKit's context handling is deliberately minimal and
honest: one explicit window guard, no summarization, prompts versioned as code.

## Files

- **[01-context-window.md](01-context-window.md)** — The finite container. The
  local context guard is AptKit's only explicit window management — it estimates
  system + messages + tool schemas and refuses the call if it exceeds the budget.
  Tool results are truncated to 16k. No history summarization. `compactSystem`
  exists as a shorter prompt variant.
- **[02-lost-in-the-middle.md](02-lost-in-the-middle.md)** — Position bias: models
  attend best to the start and end of long context, worst to the middle. AptKit
  doesn't directly mitigate it (no reranking, no retrieval ordering) — taught as a
  foundation. The `schemaSummary` is small enough that middle-loss isn't yet a live
  problem; mitigation is marked not-yet-exercised.
- **[03-prompt-chaining.md](03-prompt-chaining.md)** — Multi-step, each step one
  job. AptKit's monitor → diagnose → recommend pipeline *is* prompt chaining across
  agents — one agent's output feeds the next (recommendation takes a `Diagnosis` as
  input). `PromptPackage` versioning is prompts-as-code.

## Reading order

```
  Start → 01 (the container and its limits)
        → 02 (where attention drops inside the container)
        → 03 (chaining prompts so each stays small and focused)
```
