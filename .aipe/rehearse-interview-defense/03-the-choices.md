# Chapter 3 — The Choices

Once the interviewer has the architecture, they start testing your judgment. "Why local Gemma?" "Why build RAG from scratch?" "Why one bundle and not separate packages?" These aren't trivia — they're probing whether you made decisions or defaulted into them. The difference between a strong and a weak answer here is almost never the choice itself. It's whether you can name the alternative, the criterion you decided on, and the cost you're paying.

This chapter defends the four load-bearing choices in aptkit. Not the trivial ones — nobody senior cares which test runner you picked. The four that, if you got them wrong, would change the project.

## The chapter-opening diagram — the decision tree

Four real forks, each with the picked branch marked and the cost noted. This is the chapter in one picture.

```
  THE LOAD-BEARING CHOICES — picked branch marked ★, cost in (parens)

  1. MODEL: local vs frontier
       ├─ frontier (Claude/GPT)  → reliable tool-calling, $ per call, cloud dep
       └─ ★ local Gemma/Ollama   → zero key, private, free
                                    (cost: no native tool-calling — I emulate it)

  2. RAG: framework vs from-scratch
       ├─ LangChain / LlamaIndex → fast to standup, opaque control flow
       └─ ★ from-scratch contracts→ I own embed→chunk→upsert→search→rank
                                    (cost: I wrote the pipeline; no community plugins)

  3. VECTOR STORE: in-memory-first vs pgvector-day-one
       ├─ pgvector from day one   → durable immediately, infra to run
       └─ ★ in-memory first       → zero infra, instant tests, cosine scan
                                    (cost: linear scan; buffr swaps in pgvector+HNSW)

  4. PACKAGING: N packages vs one bundle
       ├─ N published packages    → granular installs, N version matrices
       └─ ★ one bundle (16 inlined)→ one install, one version
                                    (cost: consumers take all 16; bundledDeps gotcha)
```

The shape to carry: every branch I picked has a named cost, and for two of them (the vector store, the model) buffr or an unbundled adapter absorbs that cost when it matters. That's the senior move — not "I picked the right thing," but "I picked this, here's what it costs, here's where the cost goes away."

## Choice 1 — local Gemma over a frontier model

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "Why run Gemma locally instead of just calling Claude   │
│    or GPT-4?"                                              │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Did you think about cost, privacy, and dependency, or   │
│   did you reach for local because it's trendy? And do you │
│   understand what you GAVE UP — because a local open      │
│   model has real limitations a frontier model doesn't.    │
└─────────────────────────────────────────────────────────┘
```

> "The default is local Gemma over Ollama, and the criterion was zero-dependency reproducibility — anyone can clone the repo and run an agent end-to-end with no cloud key, no billing, nothing leaving the machine. That matters for a toolkit people are meant to try. The cost I paid is the big one: Gemma has no native tool-calling. So I emulate it in the provider — I render the tools into the system prompt as JSON, demand a single JSON object back, parse it into a tool_use block, and retry once with a corrective nudge if the JSON is malformed. That's `gemma-provider.ts`. The frontier providers — Anthropic and OpenAI — are still there as adapters behind the same port; they're just unbundled. If reliability or latency mattered more than local-first, I'd flip the default to a frontier model in one line, because the port makes that a config change, not a rewrite."

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                  │ STRONG ANSWER                │
├──────────────────────────────┼──────────────────────────────┤
│ "I used a local model        │ "I defaulted to local Gemma  │
│ because it's private and      │ for zero-dependency repro —  │
│ doesn't cost anything to run."│ clone and run, no key. The   │
│                              │ cost is Gemma has no native  │
│                              │ tool-calling, so I emulate   │
│                              │ it in the provider. Frontier │
│                              │ models are adapters behind   │
│                              │ the same port — one-line flip│
│                              │ if reliability beats local." │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ True but shallow. It names   │ Names the criterion, names   │
│ the upside and stops. The    │ the real cost (emulated tool │
│ interviewer's next question  │ calling), and pre-answers    │
│ — "what did that cost you?"  │ the follow-up by showing the │
│ — lands on silence.          │ port makes the choice cheap  │
│                              │ to reverse.                  │
└──────────────────────────────┴──────────────────────────────┘
```

## Choice 2 — RAG from scratch over a framework

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "Why build the RAG pipeline yourself instead of using   │
│    LangChain or LlamaIndex?"                              │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Reinventing-the-wheel red flag, or a deliberate choice? │
│   Do you know what the frameworks actually give you, and  │
│   can you justify owning the control flow instead?        │
└─────────────────────────────────────────────────────────┘
```

> "I'd already shipped framework-flavored RAG — AdvntrCue, Next.js and pgvector and GPT-4. The point of aptkit was the opposite: to own the substrate. So I built the pipeline from contracts — embed, chunk, upsert, search, rank — behind two ports, `EmbeddingProvider` and `VectorStore`. The criterion was control and understanding: I wanted retrieval to reach the agent as a tool, `search_knowledge_base`, not as a framework's hidden control flow. The cost is real — I wrote the pipeline and I don't get a framework's plugin ecosystem. But the payoff showed up later: when I added episodic memory, it reused the exact same retrieval contracts with zero new infrastructure. A framework would have hidden that seam from me; building it from contracts is what made the reuse obvious."

The memory-reuse proof is the strongest thing you can say here. It's evidence the boundary was real, not asserted.

```
  ▸ The proof a boundary is real isn't that you drew it.
    It's that a second consumer plugged into it for free.
```

## Choice 3 — in-memory-first over pgvector on day one

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "You're using an in-memory vector store. Isn't that     │
│    just technical debt you'll have to rip out?"           │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Can you tell the difference between debt and sequencing?│
│   A weak candidate apologizes for the in-memory store. A  │
│   strong one explains why it's the right FIRST step, not  │
│   a mistake to walk back.                                 │
└─────────────────────────────────────────────────────────┘
```

> "It's not debt — it's sequencing. The in-memory store is a cosine scan over an array, which means the whole pipeline runs with zero infrastructure and the tests are instant and deterministic. That let me get the contracts right first. Because both stores implement the same `VectorStore` contract, the durable one was an additive swap, not a rewrite — buffr's `PgVectorStore` runs over Postgres pgvector with an HNSW index and the agent code never changed. If I'd started with pgvector on day one I'd have paid the infra cost before I'd validated the contract shape. This is the one choice I'd flip almost never — the sequencing was right."

This is the choice where the weak instinct is to apologize. Don't. The in-memory store is a deliberate first rung, and the proof is that the second rung (pgvector) cost nothing in the agent layer.

## Choice 4 — one bundle over N published packages

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "You've got 16 internal packages but publish one        │
│    bundle. Why not publish them separately?"              │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Do you understand the consumer's install experience and │
│   version-matrix pain? Or did you bundle because it was   │
│   easier for you?                                         │
└─────────────────────────────────────────────────────────┘
```

> "The repo is 16 internal packages, all versioned together, but the published surface is one bundle — `@rlynjb/aptkit-core`, with `bundledDependencies` inlining all 16 into one tarball. The criterion was the consumer's experience: buffr does one install, pins one version, and gets a coherent set instead of reconciling 16 separate version matrices. The cost is that a consumer takes all 16 even if they want three, and there's a real packaging gotcha — each bundled package needs `"files": ["dist/src"]` or `npm pack` excludes its gitignored dist, which is documented in RELEASE.md because I hit it. If I had multiple independent consumers wanting different subsets, I'd flip to separate packages. With one consumer, the bundle is right."

## When you don't know — the embedding model choice

```
╔═══════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                        ║
║                                                           ║
║   They ask: "Why nomic-embed-text? How does it compare    ║
║   to OpenAI's text-embedding-3 or Voyage on retrieval     ║
║   quality for your domain?"                                ║
║                                                           ║
║   You picked nomic because it runs locally over Ollama at ║
║   768 dimensions and fit the zero-dependency goal. You    ║
║   have NOT run a head-to-head retrieval-quality benchmark ║
║   against the cloud embedders on your corpus.             ║
║                                                           ║
║   Say:                                                    ║
║   "I picked nomic-embed-text because it runs locally and  ║
║    fit the zero-key goal — it's 768-dim and it's behind   ║
║    the EmbeddingProvider contract, so OpenAI or Voyage    ║
║    are drop-in replacements. What I have NOT done is a     ║
║    head-to-head retrieval-quality benchmark on my corpus, ║
║    so I can't tell you nomic beats text-embedding-3 on    ║
║    recall — I'd want to run precision@k and recall@k       ║
║    across both before claiming that, and I already have   ║
║    those scorers in the evals package to do it."           ║
║                                                           ║
║   What this signals: you know the choice was operational  ║
║   (local), not quality-proven, you know exactly how       ║
║   you'd prove it, and the seam makes swapping cheap. You  ║
║   don't pretend to a benchmark you didn't run.            ║
║                                                           ║
║   Do NOT say:                                             ║
║   "nomic is good enough, the embeddings work fine."       ║
║   "Good enough" with no measurement is the answer of      ║
║   someone who never measured.                             ║
╚═══════════════════════════════════════════════════════════╝
```

## What you'd change

The choice most worth revisiting is the model default. Local Gemma was right for a zero-dependency toolkit, but the emulated tool-calling is a real reliability tax — every tool call is a JSON-parse-and-maybe-retry instead of a structured native call. If aptkit were aimed at production reliability rather than reproducible demos, you'd default to a frontier model with native tool-calling and keep Gemma as the offline option. The port makes that a config flip, which is exactly why you can say this without it being a rewrite.

## One-page summary

**Core claim:** For every load-bearing choice, name the alternative, the criterion, and the cost — and where the cost goes away. "I picked X, here's what it costs, here's where it's absorbed" beats "I picked X because it's good."

**Choices defended (4 load-bearing):**
1. *Local Gemma vs frontier* → zero-dependency repro; cost is emulated tool-calling; one-line flip via the port.
2. *RAG from scratch vs framework* → own the substrate; cost is writing the pipeline; proof is memory reusing the contracts free.
3. *In-memory-first vs pgvector-day-one* → sequencing not debt; same contract made the swap additive; flip almost never.
4. *One bundle vs N packages* → one install, one version for the consumer; cost is all-16 and the `"files"` gotcha; flip if multiple consumers.

**Pull quote:** The proof a boundary is real isn't that you drew it — it's that a second consumer plugged into it for free.

**What you'd change:** Default to a frontier model if the target were production reliability; the emulated tool-calling is a real reliability tax. Port makes it a config flip.
