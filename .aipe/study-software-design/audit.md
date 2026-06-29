# Software Design Audit — aptkit

> *A Philosophy of Software Design* (John Ousterhout), applied to the live
> aptkit repo. The book is the source for every primitive named here; read it.
> This file is the **audit** — Pass 1 of the two-pass shape. It walks 8 lenses
> across the real code. The deep walks for the patterns worth their own file
> live in the `01-`…`06-` discovered-pattern files; this audit cross-links to
> them rather than restating.

The through-line of the whole book in one sentence: **complexity is the enemy,
and a deep module — big behaviour behind a small interface — is the weapon.**
aptkit is a young, unusually disciplined monorepo built around exactly that
idea: a handful of narrow contracts (`ModelProvider`, `VectorStore`,
`EmbeddingProvider`, `CapabilityTraceSink`) with substantial, swappable
implementations hidden behind each. The audit's job is to say where that
discipline holds, where it leaks, and which one thing to fix first.

```
  The whole repo through the one lens that matters — interface vs body

  contract (interface)         implementation (body, hidden)
  ────────────────────         ──────────────────────────────
  ModelProvider.complete()  →  Gemma tool-call emulation, fallback chain,
       3 lines                  context-window guard, fixtures   ← DEEP
  VectorStore (3 methods)   →  cosine scan / pgvector            ← DEEP
  EmbeddingProvider         →  nomic over local Ollama HTTP      ← DEEP
  ToolPolicy (2 fields)     →  filterToolsForPolicy              ← thin, fine
  CapabilityTraceSink       →  in-memory array OR Supabase rows  ← deep body,
       1 method                                                    seam wired twice
```

Verdict up front: the module/interface discipline here is **above the bar for a
repo this size.** The strongest evidence isn't any single module — it's that
`@aptkit/memory` was built as a *second* consumer of the retrieval contracts
with zero new infrastructure. That only happens when the original interface was
drawn at the right place. The weaknesses are real but narrow, and named in the
lenses below.

---

## 1. complexity-in-this-codebase

The diagnostic overview. Ousterhout's three symptoms of complexity — change
amplification, high cognitive load, unknown-unknowns — and where each lives.

**Where a change amplifies across files.** The load-bearing contracts are the
amplification surface, by design and by the repo's own `context.md`
("must-not-change constraints"). Change the shape of `ModelProvider`
(`packages/runtime/src/model-provider.ts:54`) and every provider adapter, the
agent loop, structured generation, and every agent ripples. Same for
`VectorStore`/`EmbeddingProvider` (`packages/retrieval/src/contracts.ts:22-37`):
they're implemented in-repo (`InMemoryVectorStore`, `OllamaEmbeddingProvider`),
re-consumed by `@aptkit/memory`, and **also implemented out-of-repo by buffr's
`PgVectorStore`**. A change there amplifies across a repo boundary you can't see
from here. This is the correct kind of amplification — concentrated at a few
deliberate contracts — but it's still the highest-leverage risk in the repo, so
it's named first.

**Where cognitive load spikes.** `packages/providers/gemma/src/gemma-provider.ts`
(216 lines) is the one module that carries genuinely surprising complexity: it
*emulates a capability the model doesn't have* (tool-calling). To read it you
have to hold the outbound half (`buildSystemText` renders tools into system
prose, lines 133-165), the inbound half (`parseToolCall` salvages JSON from
messy output, 168-182), the retry loop with `RETRY_NUDGE` (62-89), and the
"is this a botched tool call or real prose?" heuristic (`looksLikeToolAttempt`,
185-187). That's a lot — but it's all *hidden behind `complete()`*, so the cost
is paid once, by the reader of this file, and never by callers.
→ deep walk in `02-emulation-hidden-behind-complete.md`.

**Where the unknown-unknowns hide.** Two spots. (1) The metadata-filter
behaviour in `search-knowledge-base-tool.ts:101-106` — `matchesFilter` silently
*ignores* filter keys absent from a chunk's meta. That's deliberate
(hallucination tolerance) and commented, but it's a surprise waiting for anyone
who assumes a filter excludes non-matching rows. (2) The trace seam: there are
**two** `CapabilityTraceSink` implementations wired independently — an in-memory
one in `apps/studio/vite.config.ts:540` and `SupabaseTraceSink` in buffr — and
nothing in aptkit tells you the second exists. → `05-injectable-trace-seam.md`.

Top 3 hotspots by path: `gemma-provider.ts` (surprising emulation),
`search-knowledge-base-tool.ts` (silent filter semantics), the
`ModelProvider`/`VectorStore` contracts (amplification radius).

---

## 2. deep-vs-shallow-modules

Depth = functionality ÷ interface size. The best module hides the most behind
the least; the worst has an interface nearly as wide as its body.

**Deepest module (best): the Gemma provider.** Interface: `complete(request) →
Promise<response>` — one method, inherited from a 3-line type
(`model-provider.ts:54-58`). Body: the entire tool-call emulation. A caller
writes `await provider.complete({ messages, tools })` and gets back a normalized
`tool_use` block exactly as if Anthropic's native API had produced it — never
seeing the system-prompt rendering, the JSON salvage, or the retry. That's the
textbook deep module: enormous behaviour, pinhole interface.
→ `01-deep-provider-module.md`, `02-emulation-hidden-behind-complete.md`.

Runner-up: `createConversationMemory` (`packages/memory/src/conversation-memory.ts:60`).
Interface is two methods (`remember`, `recall`). Body hides the kind-tagging,
the per-conversation id counters (69-71), and the over-fetch-then-filter dance
that makes recall work in a shared store (89-106). Two methods, a real engine
behind them.

**Shallowest module (worst): `filterToolsForPolicy`**
(`packages/tools/src/tool-policy.ts:11-23`). Interface: a 2-field `ToolPolicy`
type plus a function taking `(allTools, policy)`. Body: a `Set` membership
filter and a field re-map. The interface is about as wide as the body — you
have to pass the full tool list *and* the policy, and the function does little
more than a `.filter().map()`. **But this is the right call**, and not a defect
to fix: it's a pure function, trivially testable, and the thinness is the point
— policy is data (`ragQueryToolPolicy` is a 2-line const at
`rag-query-agent.ts:15-18`), and a thin pure function over data is exactly what
you want for an allowlist. Classitis would be wrapping this in a
`ToolPolicyManager` class with `addRule`/`evaluate`/`getAllowed` methods. The
repo *didn't* do that. Praise, not a finding.

There is **no real classitis in the repo.** The closest thing to an
over-decomposed surface is the five-package provider split
(`anthropic`/`openai`/`fallback`/`local`/`gemma`), but each package is a
genuinely different deep module behind the same contract, so the split earns its
place — that's information hiding, not classitis.

Fix for the worst: none warranted. If anything grows here, watch for
`ToolPolicy` sprouting per-tool argument constraints (e.g. "may call
`search_knowledge_base` but only with `top_k ≤ 10`"); *that* would deepen the
module and justify more body behind the same narrow `filterToolsForPolicy` call.

---

## 3. information-hiding-and-leakage

A leak is a design decision that shows up in two modules, forcing them to change
together. Find the facts that cross a boundary they shouldn't.

**The cleanest hiding in the repo: vendor identity.** The retrieval pipeline
*never names a vendor* — the header comment at `contracts.ts:1-5` states it as
an invariant, and the code keeps it: `pipeline.ts` speaks only `embedder` and
`store`. "nomic", "Ollama", "pgvector" are confined to the adapter files. Swap
the store and the pipeline doesn't notice. → `03-contract-as-the-product.md`.

**Leak #1 (real, mild): the embedding dimension is known in three places.**
`assertWiring` checks it in `pipeline.ts:22-29`; `InMemoryVectorStore` re-checks
every vector in `in-memory-vector-store.ts:36-42`; and `createConversationMemory`
checks it *again* at `conversation-memory.ts:62-65`. The same fact — "embedder
dim must equal store dim" — is enforced at three sites. This is arguably
defensible (fail-loud-everywhere on a one-way door), but it's the same knowledge
edited in three files. If the rule ever changes (say, a store that re-projects
dimensions), all three move together. The fix: let the *store* own dimension
validation on `upsert`/`search` (it already does, lines 36-42) and have the
pipeline and memory trust it rather than pre-checking. The pre-checks buy an
earlier, clearer error message at wiring time; that's the tradeoff keeping them.

**Leak #2 (the named weakness): metadata-filter semantics live in the tool, not
the contract.** The `VectorStore.search(vector, k)` contract
(`contracts.ts:36`) has **no metadata predicate.** So both consumers that need
filtering re-implement the same workaround on top of it: the search tool
over-fetches `topK * 4` then post-filters (`search-knowledge-base-tool.ts:88-90`),
and memory over-fetches `max(k*4, 20)` then filters by `kind`
(`conversation-memory.ts:94-98`). That's the *same design decision* — "the store
can't filter, so over-fetch and filter client-side" — made independently in two
modules. It's a leak: the absence of a contract feature is a fact both modules
encode. → `04-guard-rails-as-information-hiding.md` walks the tool's version;
the honest read is that a `filter?` parameter on `VectorStore.search` would pull
this complexity *down* into each store (pgvector can do it in SQL) and erase the
duplication. It wasn't added because the in-memory store would gain nothing and
the contract stayed minimal — a reasonable young-repo call, now ready to revisit.

**Leak #3 (cross-repo, structural): the trace seam.** `CapabilityTraceSink`
(`events.ts:26-28`) is a one-method interface. Its body — what actually happens
to an event — is implemented twice, independently: an in-memory array in
`apps/studio/vite.config.ts:540-545`, and `SupabaseTraceSink` in buffr. Both are
correct; neither knows about the other. The seam is clean (the interface held),
but the *observability story is split across two repos with no shared adapter*,
and aptkit ships no reference sink. → `05-injectable-trace-seam.md`.

---

## 4. layers-and-abstractions

Find pass-through methods (a method that just forwards to another with no value
added) and adjacent layers offering the same abstraction.

**Mostly clean.** The agent layering is real, not pass-through: each agent
composes prompt + policy + loop + validator into something the loop alone
couldn't do. `RagQueryAgent.answer` (`rag-query-agent.ts:62-83`) is the model:
it lists tools, filters by policy, then calls `runAgentLoop` with a synthesis
instruction and budgets — that's composition, not forwarding.
→ `06-capability-as-composition.md`.

**One genuine pass-through, and it's fine: `createRetrievalPipeline`.** The
pipeline object's `index` and `query` (`pipeline.ts:75-80`) forward straight to
the free functions `indexDocument`/`queryKnowledgeBase`. That *looks* like a
pass-through layer. It isn't quite — the closure exists to bind one
*validated* wiring (the `assertWiring` call at line 74 runs once, then both
methods trust it), so the layer adds "this wiring is checked" as a guarantee.
Thin, but it earns its keep. If it didn't run `assertWiring`, it'd be a pure
pass-through to delete.

**A pass-through *variable* worth noting: `capabilityId`.** It's threaded from
each agent's `*_CAPABILITY_ID` const through `runAgentLoop` options
(`run-agent-loop.ts:79`) into every emitted trace event
(`run-agent-loop.ts:116, 128, 148`) and onward into the sink. That's a variable
passed through several layers that none of them *use* except to forward — the
classic pass-through-variable smell. But it's load-bearing at the *end* of the
chain (the trace consumer keys on it), and there's no tidy alternative short of
a context object, which would be heavier. Accept it; it's the cost of
flat, explicit tracing.

No adjacent layers offering the same abstraction. The provider stack
(guard → fallback → concrete provider) nests cleanly: each layer adds one thing
(context-window safety, failover) and they all speak `complete()`. That's
self-similar layering done right, not redundant layers.

---

## 5. pull-complexity-downward

Find knobs pushed up to callers that the module had enough information to decide
itself. The book's rule: it is more important for a module to be simple to *use*
than simple to *implement* — so swallow complexity downward.

**Done well: the agent loop owns its own termination.** `runAgentLoop` decides
`forceFinal` from `maxTurns`/`maxToolCalls` internally
(`run-agent-loop.ts:101-102`) and injects the synthesis instruction itself
(line 104). The caller doesn't manage the "last turn must produce an answer, not
another tool call" logic — the loop pulled it down. Good.

**Done well: Gemma owns its retry count.** `maxToolCallAttempts` defaults to 2
inside the provider (`gemma-provider.ts:49`); callers get correct behaviour
without configuring it. The knob exists for tuning, but the default is the
module's decision.

**The one knob that's pushed up and shouldn't be: `minTopK`.** The search tool
exposes `minTopK` as an *option set at construction*
(`search-knowledge-base-tool.ts:38-41, 51`). Its whole reason for existing is to
stop a weak local model from passing `top_k: 1` and starving its own retrieval —
which is a fact the *tool* knows (it's wrapping retrieval for an LLM) far better
than the app wiring it. The comment even explains the failure mode. The default
is 1 (no floor), so out of the box the guard is *off* — every caller using a
local model has to know to set it. The fix: default `minTopK` to something like
2-3 when the tool is used in a local-model context, or detect-and-floor
internally. The counter-argument that kept it a knob: a cloud model doesn't need
the floor and the tool can't see which model it's serving. Fair — but a safer
default with an opt-*out* beats an opt-*in* guard rail.

---

## 6. errors-and-special-cases

Find exception handling scattered across call sites, and special cases a
different definition would erase. The best error handling is the error that
can't happen.

**Defining errors out of existence — the standout.** `matchesFilter`
(`search-knowledge-base-tool.ts:101-106`) and the `recall` filter
(`conversation-memory.ts:96-98`) both *define away* a class of failure rather
than handle it. A weak model hallucinating a filter key like
`{textContains: "x"}` would, under naive semantics, match nothing and wipe every
result — an error you'd then have to detect and recover from. Instead the design
says "a filter key only excludes hits that *have* that key with a different
value." Hallucinated keys are simply ignored. The special case (empty results
from a bogus filter) doesn't exist because the definition removed it. That's the
book's favorite move. → `04-guard-rails-as-information-hiding.md`.

**Errors masked at a low level.** `cosineSimilarity` returns 0 for a
zero-magnitude vector instead of `NaN` (`in-memory-vector-store.ts:55-56`) — the
NaN special case is killed at the lowest possible layer, so nothing upstream
ever sees it. Same spirit: `queryKnowledgeBase` returns `[]` for an empty
embedding (`pipeline.ts:57`) rather than throwing.

**Errors that fail loud, on purpose.** Dimension mismatch throws at wiring time
in three places (lens 3). That's the deliberate *opposite* choice — a one-way
door that corrupts ranking silently if allowed, so it's made impossible to
proceed. Knowing which errors to swallow (NaN, bogus filter) and which to make
unmissable (dimension) is the actual skill, and the repo gets it right.

**try/catch sprawl? No.** Exception handling is concentrated: the agent loop has
one try/catch around tool execution (`run-agent-loop.ts:158-168`) that converts
any tool failure into a `tool_result` with `isError`, so the model can react
instead of the loop crashing. `generateStructured` has one around the model call
(`structured-generation.ts:67-81`). Both *aggregate* error handling at the layer
that can do something with it, rather than scattering it. Clean.

---

## 7. readability (names · comments · consistency · obviousness)

**Names.** Strong overall — no `data`/`obj`/`tmp`/`manager` sprawl. The names
carry domain meaning: `assertWiring`, `RETRY_NUDGE`, `looksLikeToolAttempt`,
`buildSynthesisInstruction`, `minTopK`. The one mild offender: `meta:
Record<string, unknown>` on `VectorChunk`/`VectorHit` (`contracts.ts:11, 18`) is
honestly untyped, and the *shape* it actually carries (`docId`, `chunkIndex`,
`text`, `kind`, `conversationId`) is only knowable by reading the producers
(`pipeline.ts:44`, `conversation-memory.ts:84`). Vague-by-necessity, but a
documented `ChunkMeta` type for the known keys would prevent a typo'd
`hit.meta.docID` from silently becoming `undefined`.

**Comments.** Above average — and the right *kind*. The best ones document the
interface and the *why*, not the code: `contracts.ts:1-5` ("pipeline never names
a vendor"), the `minTopK` comment explaining the multi-part-question miss
(`search-knowledge-base-tool.ts:38-41`), the `matchesFilter` rationale (101-104),
the `store` injection note in memory (`conversation-memory.ts:20-31`). None of
these restate code; each carries a fact the code can't. The missing one: no
interface comment on `ModelProvider` itself (`model-provider.ts:54`) — the most
load-bearing contract in the repo has no doc comment saying what an
implementation must guarantee (idempotency? streaming? what `usage` means when
estimated). Add it.

**Consistency.** One real inconsistency: the two retrieval-style tools express
the same "over-fetch then filter" idea with different magic numbers — `topK * 4`
in the search tool (line 88) vs `max(k * 4, 20)` in memory
(`conversation-memory.ts:94`). Same job, two conventions. Minor, but it's
exactly the kind of drift that says the shared concept wants to live in one
place (the contract — see lens 3). Also: `search_knowledge_base` uses `top_k`
with `minTopK` floor; `search_memory` uses `top_k` with no floor
(`memory-tool.ts:51`) — two tools, two policies for the same parameter.

**Obviousness.** The "huh?" spot: `matchesFilter`'s `!(key in hit.meta)`
(line 105) reads as a bug on first encounter ("why does a filter *ignore* missing
keys?") until you read the comment. It's correct and intentional, but it's the
one place the code surprises you. The comment saves it — which is precisely why
the comment is load-bearing and must never be deleted in a refactor.

---

## 8. red-flags-audit

The capstone. Ousterhout's red flags as a checklist against this repo, sorted by
severity for aptkit. This is the actionable index the rest of the audit feeds.

```
  red flag                  fires?  where + one-line fix
  ───────────────────────── ──────  ─────────────────────────────────────────
  Information leakage        YES     VectorStore has no metadata filter →
   (mild→moderate)                   over-fetch+post-filter duplicated in
                                     search tool (search-knowledge-base-tool
                                     .ts:88) AND memory (conversation-memory
                                     .ts:94). Add filter? to the contract.

  Avoidable config /         YES     minTopK defaults to 1 (guard off) and is
   knob pushed up                    a construction knob (search-knowledge-
                                     base-tool.ts:51). Make the safe value the
                                     default; opt out, not in.

  Same knowledge edited      YES     embedding-dimension check in 3 files
   in 3 places                       (pipeline.ts:22, in-memory-vector-store
                                     .ts:36, conversation-memory.ts:62). Let
                                     the store own it; callers trust it.

  Hard-to-describe interface MINOR   meta: Record<string,unknown> on Vector
                                     Chunk/Hit (contracts.ts:11) — known keys
                                     undocumented. Add a ChunkMeta type.

  Missing interface comment  MINOR   ModelProvider (model-provider.ts:54) has
                                     no contract doc. Add one.

  Non-obvious code           MINOR   matchesFilter ignores absent keys
                                     (search-knowledge-base-tool.ts:105).
                                     Reads as a bug; comment saves it. Keep
                                     the comment.

  Shallow module / classitis NO      filterToolsForPolicy is thin but
                                     correctly so (pure fn over data). No
                                     manager-class sprawl anywhere.

  Pass-through method        NO       createRetrievalPipeline forwards but
                                     adds validated-wiring guarantee
                                     (pipeline.ts:74). Earns its place.

  Temporal decomposition     NO      modules split by responsibility (provider
                                     / retrieval / memory / tools), not by
                                     execution phase.

  try/catch everywhere       NO      error handling aggregated at the loop
                                     (run-agent-loop.ts:158) and the structured
                                     call (structured-generation.ts:67).

  Conjoined methods          NO      no two methods that must be read together
                                     to understand either.
```

**The one to fix first:** add a metadata filter to the `VectorStore.search`
contract. It collapses two independent over-fetch-then-filter implementations
into one, pushes the complexity down into each store (pgvector does it in SQL for
free), and removes the `topK * 4` magic-number drift. It touches a
must-not-change contract, so it's a deliberate, versioned change — but it's the
highest-leverage design move available in the repo right now.

---

## See also

- `README.md` — map, reading order, the through-line, the book source note.
- `00-overview.md` — one-page orientation to the design shape.
- `01-deep-provider-module.md` … `06-capability-as-composition.md` — the deep
  walks for each load-bearing design move.
- Cross-guide seams: `../study-system-design/` (the same contracts at service
  altitude — boundaries, the buffr split), `../study-agent-architecture/`
  (the loop and agentic retrieval as reasoning patterns), `../study-testing/`
  (the injectable-transport seam as the test boundary, fixtures, replay).
