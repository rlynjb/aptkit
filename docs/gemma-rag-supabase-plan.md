# Gemma + RAG + Supabase Agent System — Plan

A plan for building a self-hosted agent system on top of AptKit using Gemma (open-source LLM), Supabase (centralized data + vector store), and RAG (retrieval over a domain corpus). Borrows selected patterns from [Hermes Agent](https://hermes-agent.org/) (Nous Research, Feb 2026).

This document is the **plan** — it makes architectural decisions and sequences the work. It does not contain implementation code.

---

## TL;DR

- **Build incrementally.** Off-the-shelf Gemma → RAG → centralize on Supabase → measure → only then consider fine-tuning. Do not pre-train your own model.
- **AptKit is 70% of what you need.** Provider-agnostic agent loop, structured generation, tool registry, evals — all already there. Add a Gemma provider, a retrieval package, and a Supabase-backed storage layer.
- **Supabase is the centralization seam.** One project, multiple schemas: existing `app_<name>` schemas stay untouched; new `agents` schema holds the RAG corpus, conversations, and tool-run cache. Apps reach the agent layer through Edge Function endpoints, never raw SQL.
- **Capture trajectories from day 1.** Every agent run gets logged to `agents.messages`. This is the dataset you'd need if fine-tuning ever becomes the right move — Hermes Agent's MLOps-loop framing applies here.
- **Don't rewrite in Python.** Hermes is Python; aptkit is TypeScript. Borrow Hermes' *patterns* (skill auto-generation, sub-agent isolation, trajectory export), not its stack.

---

## What's being built

A self-hosted agent system that:

1. Runs Gemma 2 locally via Ollama as the primary model (with cloud fallback to Anthropic/OpenAI for hard queries).
2. Retrieves from a centralized knowledge base in Supabase (pgvector + HNSW).
3. Persists every conversation and tool result to Supabase, scoped per-app via RLS.
4. Exposes a stable HTTP API (Supabase Edge Functions) that any of the user's existing apps (`blooming_insights`, `buffr`, `contrl`, etc.) can hit.
5. Uses AptKit's bounded agent loop, tool registry, structured-generation, and eval harness as the runtime — no rewrites.

---

## Architecture

```
  ┌─────────────────────────────────────────────────────────────┐
  │  Apps (blooming_insights, buffr, contrl, etc.)              │
  │  - call agent endpoints via HTTP                            │
  │  - never touch agents.* tables directly                     │
  └────────────────────────┬────────────────────────────────────┘
                           │ HTTPS (app key in JWT)
                           ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  Supabase Edge Functions (the agent API)                    │
  │  - POST /agents/search         (vector retrieval)           │
  │  - POST /agents/conversations  (start session)              │
  │  - POST /agents/conversations/:id/messages (append turn)    │
  │  - POST /agents/documents      (write + chunk + embed)      │
  │  - GET  /agents/conversations/:id (read history)            │
  └─────────────┬─────────────────────────────────┬─────────────┘
                │                                 │
                ▼                                 ▼
  ┌─────────────────────────────┐   ┌─────────────────────────────┐
  │  Supabase Postgres          │   │  AptKit runtime (Node)      │
  │  schemas:                   │   │  - bounded-agent-loop       │
  │  - public  (Supabase auth)  │◀──│  - tool-registry            │
  │  - app_*   (existing apps,  │   │  - structured-generation    │
  │             untouched)      │   │  - providers/gemma  (NEW)   │
  │  - agents  (NEW; pgvector)  │   │  - retrieval tool   (NEW)   │
  │    .documents               │   └────────┬────────────────────┘
  │    .chunks (HNSW index)     │            │
  │    .conversations           │            ▼
  │    .messages                │   ┌─────────────────────────────┐
  │    .tool_runs (cache)       │   │  Ollama (local box)         │
  └─────────────────────────────┘   │  - gemma-2-9b   (generation)│
                                    │  - nomic-embed-text         │
                                    │    (embeddings, 768-dim)    │
                                    └─────────────────────────────┘
```

### Component responsibilities

| Component | Owns | Doesn't touch |
| --- | --- | --- |
| Supabase Postgres (`agents` schema) | corpus, chunks+embeddings, conversation history, tool cache | app-specific data, agent runtime logic |
| Supabase Edge Functions | HTTP contract, RLS enforcement, embedding pipeline calls | model inference, retrieval ranking logic |
| AptKit runtime | agent loop, structured output, retries, fallback chain | persistence, retrieval implementation (delegated via tool) |
| `packages/providers/gemma` (NEW) | Ollama HTTP client conforming to `ModelProvider` contract | embeddings (separate concern) |
| `packages/retrieval` (NEW) | retrieval tool registered with `tool-registry`; wraps `/agents/search` | direct DB access |
| Ollama | local Gemma inference + nomic embedding inference | nothing else |

---

## Supabase schema (`agents`)

Five tables. Detail kept short here; full column definitions live in the per-phase work.

| Table | Purpose | Key fields |
| --- | --- | --- |
| `agents.documents` | source-of-truth corpus | `id, app_id, source_type, source_path, content, metadata` |
| `agents.chunks` | retrieval unit + embedding | `id, document_id, app_id, chunk_index, content, embedding vector(768), embedding_model` |
| `agents.conversations` | agent session | `id, app_id, user_id, agent_name` |
| `agents.messages` | turn-by-turn history (trajectories) | `id, conversation_id, role, content, tool_calls, tool_results, model, tokens_used` |
| `agents.tool_runs` | cache for expensive tool calls | `id, app_id, tool_name, args_hash, result, expires_at` |

Two non-obvious cuts:

- **`app_id` is denormalized into `agents.chunks`** so vector search filters by app *before* the HNSW lookup. Without this, every search scans across all apps.
- **`embedding_model` column on `agents.chunks`** lets you switch embedding models without rebuilding from scratch. Add the new vectors alongside old, migrate in the background, drop the old column when done.

### RLS + auth

- One API key (or JWT with `app_id` claim) per app.
- Every `agents.*` table has an RLS policy: `USING (app_id = current_setting('request.jwt.claim.app_id'))`.
- Edge Functions use the service role for admin tasks (reindex, cross-app stats); apps never see the service role key.
- `app_id` is **always** derived from the authenticated token. Never accept it from the request body.

---

## Phase plan

Sized to ~4 weeks of focused work. Each phase ends in a hand-testable artifact.

### Phase 1 — Provider + storage foundation (Week 1)

Goal: Gemma running locally and reachable through aptkit's existing agent loop.

- [ ] Install Ollama on the dev box. Pull `gemma2:9b` and `nomic-embed-text:v1.5`.
- [ ] Create `packages/providers/gemma` in aptkit. Implement `ModelProvider` contract; HTTP client to Ollama's `/api/generate` and `/api/chat`. Model the local context-window guard after `packages/providers/local`.
- [ ] Verify the bounded agent loop runs against Gemma using existing fixture tools. Confirm `structured-generation` handles Gemma's worse-than-Claude JSON output (this is the riskiest piece — local models often need 1-2 retries to produce clean JSON).
- [ ] Add an entry to `packages/providers/gemma` in Studio (`apps/studio`) so the fixture and Gemma modes both work in the preview UI.
- [ ] Set up a fresh Supabase project (or new schema in the existing one). Create the `agents` schema. Define the 5 tables. Add HNSW index on `agents.chunks.embedding` (cosine ops). Add RLS policies.

**Phase 1 done when:** the Studio's Query Agent page can run end-to-end against local Gemma in fixture mode with no errors, and `agents` schema is queryable from Supabase SQL editor.

### Phase 2 — Centralized API (Week 2)

Goal: the agent endpoints exist and apps can hit them.

- [ ] Edge Function: `POST /agents/documents` — accepts `{ app_id, source_type, source_path, content, metadata? }`, chunks the content, calls Ollama for embeddings, inserts into `agents.documents` + `agents.chunks`.
- [ ] Edge Function: `POST /agents/search` — accepts `{ app_id, query, top_k, filter? }`, embeds the query, runs vector search filtered by `app_id`, returns chunks with scores and source citations.
- [ ] Edge Functions for conversations: `POST /agents/conversations`, `POST /agents/conversations/:id/messages`, `GET /agents/conversations/:id`.
- [ ] Edge Function: `GET /agents/tool-runs/cached` + cache write path on the runtime side.
- [ ] Hand-test by POSTing one markdown file from each app's notes folder and verifying chunks/embeddings exist with the right `app_id`.
- [ ] Build a 20-item hand-graded eval set: query + expected source-chunk IDs. Validate retrieval precision@5 ≥ 0.8 before Phase 3.

**Phase 2 done when:** vector search returns relevant chunks for hand-built queries with measured precision, conversations persist across calls, and RLS prevents cross-app reads.

### Phase 3 — Agent integration via aptkit (Week 3)

Goal: an aptkit agent that retrieves from Supabase, uses Gemma, persists everything.

- [ ] Create `packages/retrieval` in aptkit. Wrap `POST /agents/search` as a tool registered in the `tool-registry`. Tool definition: `search_knowledge_base(query, top_k, filter)` returns chunks with citations.
- [ ] Compose a variant of `packages/agents/query` that uses the retrieval tool + Gemma provider. Use existing `bounded-agent-loop` — no agent-loop code changes.
- [ ] Wire conversation persistence as a hook on aptkit's runtime trace events: every `assistant` and `tool` event fires `POST /agents/conversations/:id/messages`.
- [ ] Wire tool-run caching: before executing a tool, check `GET /agents/tool-runs/cached`; on cache miss, execute and write back.
- [ ] Studio page: a new Query Agent (RAG) preview that exercises the full path (Gemma + retrieval + Supabase persistence) against fixtures and a real corpus.

**Phase 3 done when:** asking the agent a real question results in a retrieval call, a Gemma generation, a citation-backed answer, and a persisted conversation row in Supabase.

### Phase 4 — Measure, then decide (Week 4)

Goal: evidence-based decision on next moves (ship vs. iterate vs. fine-tune).

- [ ] Run aptkit's `eval-harness` against the full path: 20+ hand-built eval items. Score retrieval precision@5, answer faithfulness (rubric judge), JSON output validity rate.
- [ ] Categorize failures by mode:
  - retrieval miss (right answer not in top-k) → fix retrieval (chunk strategy, embeddings, re-ranking)
  - retrieval hit but bad answer (right chunks, wrong synthesis) → fix prompting
  - retrieval hit, good prompt, wrong answer anyway → model gap (Gemma can't do this task)
- [ ] Decision matrix:
  - ≥ 80% pass → ship; iterate from real usage
  - 50-80% with retrieval misses dominating → invest in retrieval (re-ranking, hybrid search, better chunking)
  - 50-80% with model failures dominating → escalate to Claude/GPT via fallback chain; consider fine-tuning only IF the failure pattern is narrow and trajectories from Phase 3 can supply training data
  - < 50% → architecture problem; don't paper over with training

**Phase 4 done when:** there's a written one-pager with eval numbers, failure category breakdown, and a chosen next action.

---

## What to borrow from Hermes Agent

Hermes is Python-based and self-hosted; aptkit is TypeScript and library-first. Borrow the patterns, not the stack.

| Hermes pattern | What to take | Where it lands |
| --- | --- | --- |
| Auto-generated skill documents (agentskills.io standard) | When the agent solves a problem the same way 3+ times, generate a reusable skill doc the next agent run can load as prompt context | Phase 3 stretch goal; a new `agents.skills` table + a Skill primitive in aptkit prompts package |
| Sub-agents via RPC for parallel workstreams | Use aptkit's existing agent composability (one agent dispatches to another) for concurrent sub-tasks (search + summarize in parallel) | Already possible in aptkit; document the pattern in Phase 3 |
| Trajectory capture for RL/fine-tuning | Every conversation in `agents.messages` IS a trajectory. Add an export job: dump `(conversation_id, messages[], final_outcome)` to JSONL for fine-tuning datasets | Phase 4 — set up the export pipeline even if you don't fine-tune yet |
| Multi-platform gateway (Telegram, Discord, Slack, CLI through one process) | Only borrow if you actually need it. Probably not for now — apps hit HTTP endpoints directly | Skip until there's a real reason |
| Local-first persistent memory in `~/.hermes/` | Skip — you have Supabase, which is better (queryable, multi-app, RLS-enforced) | N/A |

The MLOps loop is the load-bearing idea. Even if fine-tuning is months away, capture trajectories now. That's the asset that makes the "should I fine-tune?" question answerable later.

---

## What NOT to do

1. **Don't pre-train your own model.** Pre-training is millions in compute and months of work; almost never the right call for an app developer. Fine-tuning (LoRA/QLoRA on Gemma weights) is the *furthest* you'd realistically go, and only after Phase 4 evidence justifies it.
2. **Don't pick Gemma's embeddings.** Use a dedicated embedding model (`nomic-embed-text-v1.5`). Generation models make worse embeddings than purpose-built embedding models.
3. **Don't index every write synchronously at scale.** HNSW rebuilds get expensive on large corpora. Batch reindex via background job once you cross ~10k chunks.
4. **Don't trust `app_id` from clients.** Always derive from the authenticated JWT. RLS catches mistakes; defense-in-depth catches malice.
5. **Don't centralize *data*; centralize the *agent layer*.** Existing per-app schemas stay where they are. The `agents` schema only holds RAG infrastructure, not app domain data. Apps write *into* `agents.documents` with their `app_id` when they want indexed copies.
6. **Don't ship a "platform" before you ship one good agent.** The 5 packaged agents in aptkit are templates, not the product. Pick one use case (e.g., "answer questions about my notes with citations"), get it working end-to-end, then generalize.
7. **Don't conflate "evals" with "tests".** Tests verify the agent loop runs; evals verify the agent loop produces good answers. Both are needed. Aptkit's `eval-harness` is for the second.

---

## Open questions (decide before Phase 2)

- **Embedding dimension.** `nomic-embed-text-v1.5` returns 768-dim. If you anticipate switching to OpenAI's `text-embedding-3-small` (1536) or Voyage's (1024), the column type matters. Pick now; migrations are painful.
- **Chunking strategy.** Fixed-size (e.g., 512 tokens with 64-token overlap) vs. semantic (paragraph/heading boundaries). Semantic is better for prose/docs; fixed is fine for code. Default to fixed for v1; revisit in Phase 4 if retrieval misses dominate.
- **Where Edge Functions run vs. PostgREST RPC.** Vector search via Edge Function is flexible but adds latency. A `search_chunks(...)` Postgres function called via PostgREST RPC is faster. Start with Edge Functions; move hot paths to RPC after Phase 4 numbers come in.
- **Conversation retention.** Unbounded growth is a real cost. Decide: keep N most recent per user? TTL after 90 days? Archive to cold storage? Easier to decide now than to retrofit.
- **Cross-app retrieval.** Will any agent need to search across multiple apps' corpora? Default: no — strict app isolation. If yes later, that's an explicit policy decision, not a default.

---

## Done means

This plan is done when Phases 1-4 are checked off and there's a written one-pager (Phase 4 deliverable) with eval numbers and a decided next action. The agent runs, retrieves, generates with Gemma, persists everything to Supabase, and you have measured evidence about whether it's good enough to ship or what specifically needs to improve.

Anything beyond that — fine-tuning, multi-platform gateways, skill auto-generation, RL — is a Phase 5+ decision made *from* evidence, not toward it.
