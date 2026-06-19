# 01 — LLM foundations

The model is a function: tokens in, tokens out. Everything else in AptKit is
wrapping around that one call. This section teaches the foundations *underneath*
the LLM-application shape — and AptKit is the application shape. The agent loop,
the eval layer, the cost ledger, the provider abstraction: those are all things
AptKit builds *on top of* a `model.complete(request)` call that, at its core, is
the function this section is about.

Read this section to understand what AptKit assumes about the LLM so the rest of
the guide can build on it. The recurring discipline here is **honesty about
scope**: AptKit exercises some of these foundations hard (structured outputs,
provider abstraction, the cost ledger, heuristic-before-LLM routing) and
deliberately does not exercise others (a real tokenizer, token streaming, the
user-override-lock pattern). Each file marks which it is and teaches the
not-yet-exercised ones as foundations, with a concrete build that would make
them real in this repo.

## Reading order

```
01-what-an-llm-is.md          ← the model as a function; AptKit's view IS the
                                ModelProvider contract — two methods wide
02-tokenization.md            ← text → tokens; AptKit estimates, never tokenizes
03-sampling-parameters.md     ← temperature/top-p/top-k; only temperature is plumbed
04-structured-outputs.md      ← THE key file: typed contract at the LLM boundary
05-streaming.md               ← CRITICAL: trace events stream, tokens do NOT
06-token-economics.md         ← the cost ledger; honest gap on Anthropic pricing
07-heuristic-before-llm.md    ← cheap deterministic check before paying the LLM
08-provider-abstraction.md    ← factory/adapter over multiple vendors (flagship)
09-user-override-locks.md     ← _overridden_at; NOT exercised — taught as foundation
```

If you read only one file here, read `04-structured-outputs.md`. The typed
contract at the LLM boundary is what makes everything downstream — the agent
loop's `parseResult`, the eval layer's rubric judge — testable instead of
hopeful.

## What this section exercises vs. doesn't

| Exercised in AptKit | Not yet exercised (taught as foundations) |
| --- | --- |
| `ModelProvider.complete()` contract (`model-provider.ts`) | A real tokenizer (only a char/3 estimate) |
| Structured output + parse + retry (`structured-generation.ts`) | Token streaming from the provider |
| `temperature` plumbed through both adapters | `top_p` / `top_k` sampling surface |
| Cost ledger for OpenAI gpt-4.1 (`usage-ledger.ts`) | Cost for Anthropic (pricing returns `undefined`) |
| Heuristic intent routing before the LLM (`intent.ts`) | User-override locks (`_overridden_at`) |
| Provider adapters: Anthropic, OpenAI, Fixture, local guard | — |

## Cross-links

- **Prompt engineering** is its own discipline — the prompt packages, template
  rendering, and eval-driven prompt iteration. When a file here hits a prompt
  seam it links to `.aipe/study-prompt-engineering/` rather than duplicating it.
  *(Not yet generated — run `/aipe:study-prompt-engineering`.)*
- The bounded agent loop that consumes `model.complete()` lives in
  `../04-agents-and-tool-use/03-react-pattern.md`.
- The eval layer that validates structured outputs lives in
  `../05-evals-and-observability/`.

## Provenance note

No `aieng-curriculum.md` exists in this repo, so Project Exercises cite a
Phase 1 (`C1.x`) convention rather than exact Build-item IDs. The exercises
always target AptKit's own files.
