# Study — Testing & Correctness (aptkit)

**The question this guide answers: how do you KNOW the code works — and will
keep working after the next change?** A good suite tells you what a change
broke before your users do. A suite that doesn't is decoration. This guide
audits aptkit's suite against that bar.

## The through-line

aptkit is an AI-agent toolkit. The hard part of testing it is that the core is
non-deterministic — a model decides what to say, which tool to call, whether to
emit valid JSON. You can't assert `equals` against a coin flip. aptkit's answer,
repeated in every package, is one move:

> **Put the model behind a port (`ModelProvider`), inject a fake at the port,
> and the whole assembly above it becomes deterministic.**

Everything testable in this repo traces back to that one inversion. The agents
don't call a vendor SDK; they call `ModelProvider.complete()`. Tests feed that
port recorded responses (`FixtureModelProvider`) and assert exact outputs. Same
shape one layer down (the Gemma provider's injected `chat` transport) and one
layer over (the `EmbeddingProvider`/`VectorStore` retrieval contracts).

## The seam that splits this guide from study-ai-engineering

```
  Determinism — the line between a test and an eval

  ┌─ TEST (here, study-testing) ─────────────────────────────┐
  │  assertion = "equals the expected value"                 │
  │  prompt assembly · tool dispatch · output parsing ·      │
  │  fixture replay · scorer math · contract behavior        │
  └────────────────────────────┬─────────────────────────────┘
                               │  same module, different half
  ┌─ EVAL (study-ai-engineering) ────────────────────────────▼┐
  │  assertion = "is the model output good / did it regress?" │
  │  rubric-judge scoring · promoted-fixture golden masters   │
  └────────────────────────────────────────────────────────────┘
```

If the assertion is "equals," it's here. If it's "good enough / didn't
regress," it's study-ai-engineering. They MEET constantly in aptkit — a
deterministic harness wrapping a probabilistic core. Each pattern file states
which half it's on.

## Reading order

1. **`00-overview.md`** — one-page orientation: the suite at a glance, the
   numbers, the one move that makes it all testable.
2. **`audit.md`** — the 7-lens audit (Pass 1). The risk map, the pyramid, the
   error-path coverage, the AI-feature seam, and the consolidated red-flag
   checklist with the three ranked fixes. Read this for the verdict.
3. **The pattern files (Pass 2)** — the testing techniques aptkit actually
   exercises deliberately, each worth recognizing by name:
   - **`01-injected-model-port.md`** — the dependency-injection seam: a fake at
     the `ModelProvider` port replays recorded responses; the whole agent above
     it runs unchanged and deterministic.
   - **`02-injected-transport.md`** — the seam one level deeper: the Gemma
     provider's own decode/retry tested with recorded Ollama replies, no
     `:11434`.
   - **`03-promoted-fixture-golden-master.md`** — recorded `ModelResponse[]`
     promoted to a timestamped baseline, replayed to catch regression on a
     non-deterministic core.
   - **`04-deterministic-fake-embedder.md`** — keyword-presence embedders that
     make cosine ranking exact, so retrieval/memory tests can't flake.
   - **`05-bug-to-regression-test.md`** — the hallucinated-filter bug turned
     into a permanent guard (`search-knowledge-base-tool.test.ts`).

## Cross-links

- **study-ai-engineering** — the eval half of the determinism seam: rubric-judge
  scoring, precision@k as a retrieval *metric* (vs the scorer's *math*, tested
  here), regression evaluation of model output.
- **study-software-design** — "hard to test" as a design smell. aptkit shows the
  inverse: the suite is easy because the seams (dependency inversion on every
  external boundary) were drawn right. The deep-modules / dependency-inversion
  findings live there.
- **study-debugging-observability** — the trace-event stream (`CapabilityEvent`,
  NDJSON) that the agent tests assert against is also the production evidence
  channel.
