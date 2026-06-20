# Personal-Agent Packages — aptkit scope (mirror)

> **This is a mirror, not the source of truth.**
> The **canonical** design doc lives in the buffr repo:
> `buffr/docs/superpowers/specs/2026-06-19-aptkit-packages-design.md`
> Edit the canonical doc there, not this file. This mirror exists so an aptkit
> contributor sees what these packages are for without the buffr/body context.
> It is scoped to *only* the aptkit-resident parts.

## Context (one paragraph)

These packages are the reusable, deployment-agnostic building blocks of a self-hosted personal
agent. They implement aptkit's existing contracts (`ModelProvider`, the tool registry, the
evals package) and sit next to what's already in `packages/`. The *running service* and
*apps* that assemble them into a product (Supabase, the phone app, sync, the gateway) are
**not** aptkit's job and live in other repos — see "Out of scope" below.

## The packages → where they land

| Capability | Package | aptkit contract it implements |
| --- | --- | --- |
| A — Gemma provider | `packages/providers/gemma/` | `ModelProvider` (`packages/runtime/src/model-provider.ts`) |
| B — RAG pipeline | `packages/retrieval/` | `EmbeddingProvider` + `VectorStore` (new contracts) + tool registry |
| C — profile injector | `packages/context/` (new file) | system-prompt assembly (pairs with `@aptkit/prompts`) |
| D — precision@k scorer | `packages/evals/` (new file) | matches `DetectionScoreResult` shape |
| E — capstone RAG agent | `packages/agents/rag-query/` (`@aptkit/agent-rag-query`) | composes A+B+C via `runAgentLoop` |

All follow aptkit package conventions (verified): `@aptkit/<name>`, `"type": "module"`,
`tsc` build, tests via `node --test dist/test/*.test.js` using `node:test` +
`node:assert/strict`, `tsconfig` extends `../../../tsconfig.base.json` and references
`../../runtime`. Built test-first; each ends in a hand-testable artifact.

## Per-package summary (detail is in the canonical doc)

**A — `@aptkit/provider-gemma`** · Ollama→Gemma `ModelProvider`; wrap in the
`ContextWindowGuardedProvider` pattern from `providers/local`. **The hard part:** Gemma2:9b
has no native tool-calling, so the provider must prompt for JSON tool calls and parse them
back into `ModelToolUseBlock` via `parseAgentJson` (`runtime/src/json-output.ts`).
Tool-call *decoding* is a different, harder failure surface than structured *output* — it's
where the loop stalls. Model stays swappable (compose under `provider-fallback`).
*Artifact:* a recorded-response fixture test where a messy blob parses to a clean
`tool_use`.

**B — `@aptkit/retrieval`** · the RAG pipeline, built from scratch, **not ported from
AdvntrCue** (which welded in OpenAI). Two swappable contracts:
`EmbeddingProvider { id, dimension, embed() }` and
`VectorStore { dimension, upsert(), search() }`. Ship `OllamaEmbeddingProvider` (nomic, 768)
and `InMemoryVectorStore` now; `PgVectorStore` is a later adapter. Paths: index
(`doc→chunk→embed→upsert`) and query (`query→embed→search→rank`); `search_knowledge_base`
tool wraps the query path. Embedding *dimension* is a one-way door on indexed data →
re-index is first-class. *Artifact:* embed→upsert→search returns the planted chunk on top;
dimension mismatch throws.

**C — `packages/context/profile-injector.ts`** · pure
`injectProfile(systemTemplate, profileText, opts?) → string`; prepends a profile doc into
the system prompt before `renderPromptTemplate`. Caller reads the file (no `fs` in the
package). *Artifact:* profile text lands in the assembled system string; rendering still
works.

**D — `packages/evals/precision-at-k.ts`** · `scorePrecisionAtK(retrievedIds, relevantIds,
k)` (+ `scoreRecallAtK`). Net-new — aptkit has no retrieval scorer today (`detection-scorer`
is categorical, not ranked). Faithfulness reuses the existing `RubricJudge` with **Claude as
the judge** (not Gemma — circular). *Artifact:* known ranking → known precision@k.

**E — `@aptkit/agent-rag-query`** · mirrors `packages/agents/query/`; wires A (model), B
(tool via `filterToolsForPolicy`), C (profile in system prompt), measured by D. Runs in the
terminal against the real `InMemoryVectorStore`. *Artifact:* asks a question, emits a
`tool_use`, answers grounded + profile-shaped.

## Build order

```
  A  provider-gemma   ████████████  riskiest (tool-call emulation)   ┐ independent,
  B  retrieval (RAG)  ██████████    from-scratch adaptable pipeline  ┘ parallel
  C  profile-injector ██   ┐ easy, parallel
  D  precision-at-k   ██   ┘ (D measures B)
                          ↓ once A + B done, C present
  E  capstone agent       ████  wires A+B+C, measured by D
```

## Out of scope (do NOT add to aptkit)

The service/app layer — keep it in the service/app repos, not in this toolkit:
`PgVectorStore` binding, Supabase `agents` schema + RLS, Edge Functions, the phone app
brain, laptop↔phone memory sync, the multi-platform gateway, trajectory→fine-tune. aptkit
stays provider-agnostic library code; the body is built elsewhere.
