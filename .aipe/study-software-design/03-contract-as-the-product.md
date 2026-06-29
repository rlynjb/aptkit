# The Contract as the Product

**Industry name(s):** dependency inversion / published interface /
contract-first design · **type:** Industry standard

The retrieval contracts (`EmbeddingProvider` + `VectorStore`) aren't
plumbing inside the RAG pipeline — they're the deliverable. The strongest
evidence: a brand-new feature, episodic memory (`@aptkit/memory`), reuses
them with *zero new infrastructure*, and an external repo (buffr) ships
the durable implementation. When a contract proves right by being reused
without modification, the contract is the product.

---

## Zoom out, then zoom in

Here's the whole retrieval story in one frame. Two small interfaces sit
in the middle. Above them: the index path, the query path, the search
tool, and — the proof — the memory engine, all written against the
interfaces. Below them: an in-memory adapter here, a Postgres adapter
in buffr.

```
  Zoom out — the contracts are the center of gravity

  ┌─ Clients of the contracts ─────────────────────────────────────┐
  │ indexDocument · queryKnowledgeBase · search_knowledge_base tool │
  │ createConversationMemory (remember/recall) ← the PROOF          │
  └────────────────────────────┬────────────────────────────────────┘
                               │ embed() / upsert() / search()
  ┌─ Contracts ★ ──────────────▼────────────────────────────────────┐
  │ EmbeddingProvider  ·  VectorStore   (contracts.ts)              │  ← we are here
  └────────────────────────────┬────────────────────────────────────┘
                               │ implemented by
  ┌─ Adapters ─────────────────▼────────────────────────────────────┐
  │ InMemoryVectorStore · OllamaEmbeddingProvider  (in aptkit)      │
  │ PgVectorStore  (in buffr — different repo, same contract)       │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **dependency inversion made the deliverable** —
the high-level policy (RAG, memory) and the low-level detail (in-memory,
pgvector) both depend on an abstraction the codebase owns. The question:
*how do you know your abstraction is the right boundary and not a guess?*
Answer: you reuse it for something it wasn't designed for, and it fits
without changing.

---

## The structure pass

**Layers.** Policy (RAG pipeline, memory engine) → contracts
(the two interfaces) → mechanism (in-memory cosine, pgvector SQL).

**Axis — trace `dependency` again, but watch for the *reuse* signal.**

```
  One axis: "who depends on the contract — and how many, doing what?"

  ┌─ retrieval index/query ─┐ ─┐
  ┌─ search tool            ┐  │  all depend DOWN on the same
  ┌─ memory remember/recall ┐  ├─► two contracts — built for RAG,
  └─────────────────────────┘ ─┘  reused by memory unmodified
                ▼
  ┌─ EmbeddingProvider / VectorStore ┐  depends on nothing
  └──────────────────────────────────┘
```

**Seam.** The contract boundary is load-bearing because *count the
clients*: the more independent things that depend on a contract without
forcing it to change, the more the boundary was real. Memory crossing the
same seam RAG uses is the seam proving itself.

---

## How it works

### Move 1 — the mental model

You know how a well-designed React hook gets reused in components it was
never written for — `useFetch` written for one screen turns out to power
five — and you don't touch the hook, you just call it? A contract that's
the *product* is that, at the architecture seam. You design
`VectorStore` for document RAG, then realize episodic memory is *also*
"embed a thing, store it, search by similarity" — and you reuse the
contract verbatim.

```
  Pattern — one contract, N independent clients, zero changes

   RAG index ──┐
   RAG query ──┤
   search tool ─┼──► [ VectorStore contract ] ──► InMemory / Pg
   memory ─────┘      (designed for the first 3,
                       reused by the 4th unchanged)
```

### Move 2 — the step-by-step walkthrough

**The contract carries only what every adapter must promise.** Look at
what's *not* in `VectorStore` (`contracts.ts:33`): no `connect()`, no
`close()`, no SQL, no collection name. Just `dimension`, `upsert`,
`search`. The interface is the minimum that's true of every backing
store. That minimalism is what lets pgvector and an in-memory array both
satisfy it.

**RAG is the first client.** The pipeline functions speak only the
contract (`pipeline.ts`):

```ts
const vectors = await wiring.embedder.embed(texts);     // EmbeddingProvider
await wiring.store.upsert(chunks);                      // VectorStore
// ...
return wiring.store.search(vector, topK);               // VectorStore
```

`indexDocument` (:32) and `queryKnowledgeBase` (:50) name no vendor. The
comment at `contracts.ts:1–5` states the rule out loud.

**Memory is the proof.** Now read `createConversationMemory`
(`conversation-memory.ts:60`). It takes the *same two contracts* by
dependency injection (:18–31) and re-implements RAG's two paths under new
names:

```ts
async remember(turn) {                       // = the RAG INDEX path
  const [vector] = await embedder.embed([text]);
  await store.upsert([{ id: `${kind}:${turn.conversationId}:${n}`, vector, meta }]);
},
async recall(query, k) {                     // = the RAG QUERY path
  const [vector] = await embedder.embed([query]);
  const hits = await store.search(vector, fetchK);
  return hits.filter(h => h.meta?.kind === kind).slice(0, k).map(...);
},
```

`remember` *is* index; `recall` *is* query. No new interface, no new
store type, no schema migration. The comment at :48–59 says it plainly:
*"Pass a `PgVectorStore` for durable memory, an `InMemoryVectorStore`
for tests — the logic is identical."* That's the contract proving it was
drawn at the right boundary.

```
  Layers-and-hops — memory reuses RAG's exact two paths

  ┌─ Memory client ──┐  remember(turn)        recall(query)
  │ conversation-    │       │                     │
  │ memory.ts        │       ▼ embed+upsert         ▼ embed+search+filter
  └──────────────────┘  ┌────────────────────────────────┐
                        │ EmbeddingProvider + VectorStore │  ← same contract
                        │   (the RAG index/query paths)   │     as RAG
                        └────────────────┬────────────────┘
                                         ▼
                            InMemoryVectorStore / PgVectorStore
```

**The external proof — buffr's `PgVectorStore`.** The durable adapter
lives in a *different repository* and is injected into aptkit from
outside. aptkit's core never imports it. A contract that an external repo
can satisfy without aptkit knowing is a published interface in the truest
sense.

### Move 2 variant — the load-bearing skeleton

1. **Kernel:** a minimal interface owned by the policy layer + injection
   of the implementation + ≥2 independent clients that depend on it.

2. **What breaks if removed:**
   - Put a vendor method on the contract (e.g. `store.sql(...)`) → the
     in-memory adapter can't satisfy it; the abstraction collapses to
     "Postgres with extra steps" and memory/tests can't reuse it.
   - Let memory define its *own* store interface → two near-identical
     contracts drift apart; buffr now has to implement two; the "zero
     new infra" win evaporates. (This is the leak the audit warns about
     in lens 3.)
   - Remove injection (let the pipeline `new InMemoryVectorStore()`) →
     buffr can't supply pgvector; the contract stops being a product and
     becomes an internal detail.

3. **Skeleton vs hardening:** the kernel is the minimal contract + DI +
   reuse. The dimension field on the contract is hardening (it makes the
   one-way-door explicit — see `04`).

### Move 2.5 — current state vs future state

The contract is right, but it's not yet *complete*. One capability is
missing and the absence leaks.

```
  Phase A (now)                        Phase B (the fix the audit names)
  ─────────────                        ──────────────────────────────────
  VectorStore has no metadata filter.  VectorStore gains optional filter:
  Both the search tool (:88) and        search(vector, k, filter?)
  memory recall (:94) OVER-FETCH        Pg pushes filter into SQL WHERE;
  (topK*4 / max(k*4,20)) then           in-memory filters in the scan.
  POST-FILTER by meta in the client.    Clients drop the over-fetch +
  Same workaround, two magic numbers,   the two magic numbers; the
  two files.                            knowledge lives in ONE place.
```

What doesn't have to change in Phase B: the policy layer (RAG, memory),
the adapters' core ranking, the DI wiring. Only the contract grows one
optional argument. That's the payoff of getting the contract right first
— the fix is additive, not a rewrite.

### Move 3 — the principle

You don't know an abstraction is correct until something reuses it that
you didn't design it for. Designing the contract first, then proving it
by reuse, is how you turn "an interface I hope is right" into "the thing
the system is actually built on." The reuse is the unit test for the
abstraction.

---

## Primary diagram

```
  The contract as the product — full recap

  ┌─ Policy layer (high-level, owns the contract) ──────────────────┐
  │ RAG: indexDocument · queryKnowledgeBase · search tool           │
  │ Memory: remember (=index) · recall (=query)   ← reuse, no change │
  └────────────────────────────┬────────────────────────────────────┘
              both depend DOWN  │ on the abstraction
  ┌─ Contract ★ ────────────────▼────────────────────────────────────┐
  │ EmbeddingProvider { dimension, embed }                          │
  │ VectorStore       { dimension, upsert, search }                 │
  │   minimal — only what EVERY adapter can promise                 │
  │   (gap: no metadata filter yet → over-fetch leaks to clients)   │
  └────────────────────────────▲────────────────────────────────────┘
              detail depends UP │ on the same abstraction (inverted)
  ┌─ Mechanism layer ───────────┴────────────────────────────────────┐
  │ InMemoryVectorStore (cosine, this repo)                          │
  │ PgVectorStore (SQL, buffr — external, injected in)               │
  └────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

This is the dependency-inversion principle stated as a product
decision: the high-level policy and the low-level detail both depend on
an abstraction the *high-level side* owns. Most codebases get this
backward — the policy imports the database driver. AptKit inverts it: the
contract lives with the policy (`@aptkit/retrieval`), and the database
lives outside (buffr).

The whole monorepo exists for this (`context.md`): `@rlynjb/aptkit-core`
ships to npm carrying the contracts, and any host app fills the slots.
The contract *is* the product — literally the npm surface. Compare to
AdvntrCue, where pgvector was welded into the app: useful, but not a
library. AptKit's move is making the boundary the thing you ship.

Read next: `04-guard-rails-as-information-hiding.md` (the dimension field
on the contract), `06-capability-as-composition.md` (an agent built by
injecting these contracts).

---

## Interview defense

**Q: How do you know the retrieval contract is the right abstraction and
not over-engineering?** Because memory — a feature it wasn't designed for
— reuses it with zero new infrastructure. `remember` is the index path,
`recall` is the query path, over the same `EmbeddingProvider` and
`VectorStore`. And buffr's `PgVectorStore`, from a separate repo,
satisfies it without aptkit importing anything. An over-engineered
abstraction has one user and lots of speculative methods; this one has
three internal users plus an external implementation and only three
methods.

```
  the test for a real abstraction: count the independent reusers

  designed for:   RAG document search
  reused by:      memory (unchanged) + buffr's PgVectorStore (external)
  methods added for the reuse:  zero
  → the boundary was real
```

Anchor: "an abstraction is proven by reuse you didn't design for."

**Q: The contract has no metadata filter — isn't that a hole?** Yes, and
the audit names it (lens 3). It's the one place the abstraction is
incomplete: because the port can't filter, two clients over-fetch and
post-filter with their own magic numbers. The honest read is that the
contract is *correct but not complete* — the fix is additive (one
optional `filter` arg), and getting the rest of the contract right is
exactly what makes the fix cheap. A perfect contract that needs a rewrite
to extend would be worse.

Anchor: "correct boundary, incomplete surface — the fix is additive."

---

## See also

- `01-deep-provider-port.md` — the ports this file's contracts are an instance of
- `04-guard-rails-as-information-hiding.md` — the dimension field on the contract
- `06-capability-as-composition.md` — injecting these contracts into an agent
- `00-overview.md` — DIP / DI in the PATTERN VOCABULARY
- `audit.md` — lens 1 & 3 (the over-fetch leak), lens 8 (the filter fix)
- `../study-system-design/` — the same seam at the architecture altitude
- `../study-agent-architecture/` — memory as agentic retrieval
