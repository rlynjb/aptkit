# Interview Defense — aptkit

This is your book. Not a study guide you read once — a thing you read front-to-back the week before, skim the morning of, and pull one chapter from the night before they ask. It defends **aptkit** (the published provider-neutral agent toolkit) and its companion runtime **buffr**, in your voice, from your real code. Every claim in here is grounded in a file you can open — because the fastest way to lose a room is to claim something you can't walk.

You've shipped RAG before (AdvntrCue: Next.js + pgvector + GPT-4). This is your *second* RAG system, and the growth is the whole story: last time you wired a framework to a cloud model; this time you built the substrate from contracts and ran a local model you had to teach to call tools. That arc is what these eight chapters arm you to defend.

## The system at a glance

One diagram to anchor the whole book — when they say "walk me through it," this is what you draw.

```
  aptkit — a provider-neutral toolkit for building LLM agents
  published as @rlynjb/aptkit-core@0.4.1 (npm) · 16 packages in one bundle

  ┌─ Studio (apps/studio) ── React/Vite preview + NDJSON replay UI ──────────┐
  └──────────────────────────────────┬───────────────────────────────────────┘
  ┌─ Agents (packages/agents/*) ──────▼───────────────────────────────────────┐
  │   query · recommendation · anomaly · diagnostic · rubric · ★ rag-query     │
  │   each = prompt + tool policy + bounded loop + validator                   │
  └──────────────────────────────────┬───────────────────────────────────────┘
  ┌─ Runtime (packages/runtime) ──────▼───────────────────────────────────────┐
  │   runAgentLoop (bounded) · structured-generation · CapabilityEvent trace   │
  │   ┌───────────────────────────────────────────────────────────────────┐   │
  │   │  THE CONTRACT:  ModelProvider.complete(request) → response         │   │
  │   └───────────────────────────────────────────────────────────────────┘   │
  └──────────┬───────────────────────────────────────────┬────────────────────┘
             │ model side                                 │ retrieval side
  ┌─ Providers ▼──────────────────────┐     ┌─ Retrieval (packages/retrieval) ▼─┐
  │  anthropic · openai · fallback ·  │     │  EmbeddingProvider + VectorStore   │
  │  local(guard) · ★ gemma (Ollama,  │     │  contracts · InMemoryVectorStore   │
  │  EMULATED tool-calling)           │     │  (cosine) · search_knowledge_base  │
  └──────────┬────────────────────────┘     └──────────────┬─────────────────────┘
             │                                              │ same VectorStore contract
  ┌─ External ▼───────────────────┐         ┌─ buffr (companion repo) ▼──────────┐
  │  Anthropic · OpenAI ·         │         │  PgVectorStore (Postgres/pgvector  │
  │  Ollama (gemma2:9b, nomic)    │         │  + HNSW) · agents schema · persist │
  └───────────────────────────────┘         │  CONSUMES @rlynjb/aptkit-core@npm  │
                                            └────────────────────────────────────┘
  Evals (packages/evals) cut across: precision@k/recall@k · rubric-judge (Claude
  judges Gemma — anti-circular) · replay/fixture golden-master
```

The two load-bearing ideas in that picture: **one `ModelProvider.complete()` contract** (swap any model, inject fixtures, chain fallbacks without touching an agent) and **the same contract shape reused for retrieval** (`VectorStore` — in-memory in aptkit, pgvector in buffr, one-line swap). If you can defend those two seams, you can defend the system.

Two things grew in since this diagram first settled, and both reinforce the same two seams rather than adding new ones. First, `@aptkit/memory` — episodic conversation memory — now rides the *exact same* `EmbeddingProvider` + `VectorStore` contracts as retrieval, which is the clearest proof the abstraction paid off (the honest caveat: no aptkit agent wires it into its loop yet — buffr's chat runtime is the only consumer). Second, Studio grew off-shell pages beyond trace replay: an in-browser `rag-query` demo that runs the whole retrieval path deterministically and scores it live (precision@1 / recall@k), plus rendered doc pages (api-docs, user-guide). Neither changes the spine — they're more consumers of the contracts you already defend.

## The eight chapters

| Ch | Title | The question it answers | Read it for |
|----|-------|-------------------------|-------------|
| 01 | The pitch | "Tell me about a project." | The 10s / 30s / 90s answer; the AdvntrCue→aptkit growth arc |
| 02 | The architecture | "Walk me through the system." | The whiteboard + one request traced end-to-end |
| 03 | The choices | "Why this stack?" | **6 load-bearing decisions** defended (the densest chapter) |
| 04 | The scale story | "What breaks at 10x/100x?" | Bottleneck *order* + how you'd measure; honest deferral |
| 05 | The failure story | "What happens when it goes wrong?" | Ollama down, bad JSON, dimension mismatch, the retrieval-miss war story |
| 06 | The hard parts | "Hardest bug? Proudest? Weakest?" | Answering honestly without collapsing |
| 07 | The counterfactuals | "What would you do differently?" | The 4 reconsiderable calls + when each flips |
| 08 | The AI question | "Did you use AI to build this?" | The calibrated-honest answer — judgment, not typing |

## How to use this book

```
  FIRST READ ────────► front to back, in order. Each chapter builds on the last.
                       Chapter 1 sets the pitch; 8 closes the loop on how it was built.

  REVIEW PASS ───────► skim only the chapter-opening diagram + the pull quotes
                       (┃ / ▸ lines) + the strong/weak tables. ~70% of the book.

  NIGHT BEFORE ──────► read only each chapter's one-page summary. Eight pages total.

  IN THE ROOM ───────► the diagrams are what you draw; the pull quotes are what you say.
```

Two register notes that run through every chapter:
- **Strong answers are in your voice** — first person, present tense, speakable. "I built RAG from contracts because…", not "the developer chose…". Read them out loud.
- **AI-honesty is woven throughout, not quarantined in Chapter 8.** The 2026 baseline assumes you used AI heavily. The differentiator is owning *which* decisions were yours (deliberate), which the AI proposed and you judged (evaluated-and-accepted), and which you defaulted to (and how you'd check them). Chapter 8 makes that explicit; the other seven model it.

## The one place you'll get pushed past your depth

Be ready for it: **the internals of an ANN vector index (HNSW — how the navigable-small-world graph actually works).** You use it (buffr's pgvector), you can explain *why* (linear scan doesn't scale, the `VectorStore` contract lets it drop in), but the graph-construction internals are a real gap. Chapter 4's "I don't know" recovery box is built for exactly this question — and the honest answer there ("I treat it as a swappable index behind the contract; here's what I'd verify with recall@k") is *stronger* than a hand-wavy fake. Embedding-model internals (why nomic, how it compares on MTEB) is the second such spot — Chapters 1 and 3 cover the recovery.

## Where this connects

This book is the **wide opener** — the whole-project defense. The **deep dives** live in the concept-level "Interview defense" blocks inside `.aipe/study-system-design/` (the architectural seams) and `.aipe/study-ai-engineering/` (RAG, embeddings, agentic retrieval, evals). When a chapter here points at a seam and says "the deep walk is in the study guide," that's where it goes. Read this book to defend the project; read those to defend the concepts underneath it.

---
Updated: 2026-06-24 — Bundle is now 16 packages at `@rlynjb/aptkit-core@0.4.1` (added `@aptkit/memory`); noted memory reusing the retrieval contracts and Studio's new off-shell pages (rag-query demo + doc pages).
