# 00 — Overview: the prompt surface of aptkit

*One-page orientation. Where prompts live, what they touch, and which file owns
each concept.*

I've shipped enough LLM features to know the trap: people treat "the prompt" as
one string in one file. In a real system the prompt is a *surface* — it spans
the system text, the schema you hand the model, the user content you splice in,
the retry you fire when parsing fails, and the eval that tells you whether your
last edit helped or quietly broke something. aptkit is small enough to see the
whole surface at once, which is exactly why it's a good thing to study.

## Zoom out — the whole prompt surface in one map

Here's every place a prompt is assembled, sent, parsed, or judged in this repo.
This is the picture the rest of the guide zooms into.

```
  The aptkit prompt surface — assemble → send → parse → judge

  ┌─ Authoring layer (prompts as code) ───────────────────────────────┐
  │  packages/prompts/src/{query,diagnostic,recommendation,           │
  │     monitoring}.ts   — PromptPackage: system + vars + examples     │
  │  packages/context/src/profile-injector.ts  — injectProfile()      │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  render {vars}, inject profile
  ┌─ Assembly layer (per call) ───▼───────────────────────────────────┐
  │  run-agent-loop.ts  — system + tool schemas + forced synthesis    │
  │  structured-generation.ts — system + strictSuffix on retry        │
  │  gemma-provider.ts buildSystemText() — schemas rendered INTO text │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  HTTP → provider
  ┌─ Model layer ─────────────────▼───────────────────────────────────┐
  │  Anthropic / OpenAI (native tools)  ·  Gemma (emulated tools)      │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  raw text / tool_use blocks back
  ┌─ Parse layer (tolerant) ──────▼───────────────────────────────────┐
  │  json-output.ts parseAgentJson() — fence-strip + substring scan   │
  │  gemma-provider.ts parseToolCall() — JSON → {tool, arguments}     │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  validated output
  ┌─ Judge layer (evals gate changes) ─▼──────────────────────────────┐
  │  evals/rubric-judge.ts (Claude judges output)                     │
  │  evals/precision-at-k.ts (retrieval quality)                      │
  └────────────────────────────────────────────────────────────────────┘
```

## Zoom in — the five things worth internalizing

1. **Prompts here are code, not strings.** Each agent's prompt is a
   `PromptPackage` with an `id`, `version`, and `capabilityId`
   (`packages/prompts/src/types.ts:13`). That's the provenance that lets you
   answer "which prompt produced this output" six months from now.

2. **Structured output is a pipeline, not an instruction.** `generateStructured`
   (`packages/runtime/src/structured-generation.ts:54`) generates, extracts,
   validates, and retries with a stricter nudge. The prompt text saying "return
   JSON" is the *weakest* part of that pipeline.

3. **The Gemma provider is the deepest prompt-engineering artifact in the repo.**
   Gemma has no native tool-calling, so `buildSystemText`
   (`gemma-provider.ts:133`) renders the tool JSON schemas straight into the
   system prompt and demands a single JSON object back, with `RETRY_NUDGE`
   (`gemma-provider.ts:35`) as the corrective re-prompt. This is prompt
   engineering doing a job an API would otherwise do.

4. **The loop's last turn forces an answer.** `buildSynthesisInstruction`
   (`run-agent-loop.ts:72`) appends "You have NO more tool calls available… Do
   not say you need more queries." That single line stops the classic failure
   where the model keeps asking for tools it no longer has.

5. **Evals close the loop.** `rubric-judge.ts` is Claude judging another model's
   output against a rubric; `precision-at-k.ts` scores retrieval. Without these,
   every prompt edit is a vibe.

## What's `not yet exercised`

Being honest about the gaps is half of senior prompt work:

- **No few-shot example library.** Examples live as inline literals
  (`packages/prompts/src/query.ts:80`), not a curated, versioned set.
- **No prompt caching.** Grep the repo for `cache_control` — nothing. The static
  prefixes (schema, tool list) are re-sent every call.
- **No automated prompt optimization** (DSPy-style). Prompts are hand-authored.
- **No per-model eval matrix.** Prompt drift across model upgrades is a known
  risk (concept 03) but isn't tracked by a regression suite keyed on model id.
- **No self-critique / self-consistency** wired into any agent.

## Where to go next

Read in numeric order. The operational concepts (01–05) are the discipline; the
techniques (06–13) are the moves. Cross-link to `../study-ai-engineering/` for
the RAG and serving depth, and `../study-testing/` for the eval mechanics.
