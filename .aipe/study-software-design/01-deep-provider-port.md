# The Deep Provider Port

**Industry name(s):** ports & adapters / hexagonal architecture /
dependency-inversion seam · **type:** Industry standard

The single most load-bearing design move in AptKit. A tiny interface
(the port) hides an arbitrary amount of vendor behavior, and the whole
16-package monorepo is built to depend on the port and never on an
adapter.

---

## Zoom out, then zoom in

Okay — here's the whole thing. Every box that wants a model or a vector
store points at one of three small interfaces in the middle, and
everything that *implements* those interfaces sits below them. Nothing
above the line ever names a vendor.

```
  Zoom out — where the ports live

  ┌─ Client layer ───────────────────────────────────────────┐
  │  RagQueryAgent · recommendation · query · monitoring      │
  │  runAgentLoop · the retrieval pipeline functions          │
  └───────────────┬───────────────────────┬──────────────────┘
                  │ calls .complete()      │ calls .embed()/.search()
  ┌─ Port layer ★ ▼───────────┐   ┌────────▼──────────────────┐
  │ ModelProvider             │   │ EmbeddingProvider          │
  │ (model-provider.ts:54)    │   │ VectorStore (contracts.ts) │  ← we are here
  └───────────────┬───────────┘   └────────┬───────────────────┘
                  │ implemented by          │ implemented by
  ┌─ Adapter layer ▼──────────┐   ┌─────────▼──────────────────┐
  │ Gemma · Anthropic · OpenAI│   │ InMemoryVectorStore         │
  │ Fallback · ContextGuard   │   │ PgVectorStore (lives in buffr)│
  │ Fixture (test)            │   │ OllamaEmbeddingProvider     │
  └───────────────────────────┘   └─────────────────────────────┘
```

Zoom in: the concept is the **port** — the interface (`ModelProvider`,
`EmbeddingProvider`, `VectorStore`) that the codebase owns and that
every adapter must satisfy. The question it answers: *how do you build
an agent system that doesn't rot when you swap the model vendor or the
vector database?* Answer: you make the swap point a contract, depend on
the contract, and let the vendors be interchangeable adapters behind it.

---

## The structure pass

**Layers.** Three: clients (agents, pipeline functions), ports (the
three contracts), adapters (the implementations).

**Axis — trace `dependency` (which way does the arrow point?).**

```
  One axis: "which way does the dependency arrow point?"

  ┌─ client (RagQueryAgent) ─┐   arrow points DOWN, at the port
  │  depends on ModelProvider│ ──────────────────────────┐
  └──────────────────────────┘                           ▼
  ┌─ port (ModelProvider) ───┐   holds no dependency on anyone
  │  pure shape, no body      │ ◄─────────────────────────┐
  └──────────────────────────┘                            │
  ┌─ adapter (GemmaModelProvider)┐  arrow points UP, at the port
  │  implements ModelProvider     │ ───────────────────────┘
  └──────────────────────────────┘
       both client and adapter depend on the port;
       the port depends on nothing → dependency INVERTED
```

**Seam.** The port boundary is the seam, and it's load-bearing because
the `dependency` axis-answer *inverts* across it: above it, code depends
downward on the contract; below it, code depends upward on the same
contract. A boundary where the arrow flips is exactly where a contract
should live.

Skeleton mapped — now the mechanics.

---

## How it works

### Move 1 — the mental model

You already know this shape from the frontend: a `fetch()` doesn't know
whether it's hitting your dev server or production — it speaks HTTP, and
HTTP is the contract. Swap the backend, the `fetch()` call is unchanged.
A port is the same idea moved in-process: define the smallest interface
that captures "what a model does," make every vendor implement *that*,
and your agent code calls the interface, never the vendor.

```
  Pattern — the port as the only thing both sides see

         client ──calls──►  ┌─────────────┐  ◄──implements── adapter A
                            │    PORT      │  ◄──implements── adapter B
         client ──calls──►  │ (interface)  │  ◄──implements── adapter C
                            └─────────────┘
              the two sides never reference each other;
              only the port sits between them
```

### Move 2 — the step-by-step walkthrough

**The port itself — and notice how small it is.** Here's the entire
model port (`packages/runtime/src/model-provider.ts:54`):

```ts
export type ModelProvider = {
  id: string;
  defaultModel?: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
};
```

Three fields. One method. That's the whole contract every model vendor
must satisfy — Anthropic's SDK, OpenAI's, a local Ollama HTTP call, a
recorded fixture. The *depth* isn't here; it's in what each adapter hides
behind `complete()`. The port is deliberately a thin shape with no body —
that's what makes it ownable and swappable.

**The retrieval ports — same move, two interfaces**
(`packages/retrieval/src/contracts.ts:22`, :33):

```ts
export type EmbeddingProvider = {
  id: string;
  dimension: number;                          // fixed per provider (768 = nomic)
  embed(texts: string[]): Promise<number[][]>;
};

export type VectorStore = {
  dimension: number;
  upsert(chunks: VectorChunk[]): Promise<void>;
  search(vector: number[], k: number): Promise<VectorHit[]>;
};
```

Read the comment block above these (`contracts.ts:1–5`): *"the pipeline
logic never names a vendor (nomic / OpenAI / pgvector / in-memory are
incidental)."* That sentence is the design intent stated in the code. The
port carries a `dimension` field because the one fact the store and the
embedder *must* agree on travels with the contract.

**The client depends on the port — not the adapter.** Watch the agent
loop (`packages/runtime/src/run-agent-loop.ts:103`):

```ts
const response = await model.complete({ system, messages, tools: ..., maxTokens, signal });
```

`model` here is typed `ModelProvider` (`run-agent-loop.ts:37`). The loop
has no idea whether it's talking to Gemma over local HTTP or replaying a
fixture. That's the dependency pointing inward, at the port.

**The adapters satisfy the port — structurally.** TypeScript's
structural typing means an adapter just has to *have the shape*.
`InMemoryVectorStore implements VectorStore`
(`in-memory-vector-store.ts:10`) and buffr's `PgVectorStore` implements
the identical three methods from a different repo entirely. Neither
aptkit nor the pipeline imports `PgVectorStore`; buffr supplies it from
outside and injects it.

```
  Layers-and-hops — a query crosses the port twice, names no vendor

  ┌─ Client ─────────┐  hop 1: pipeline.query("...", 5)
  │ RagQueryAgent /   │ ──────────────────────────────────┐
  │ search tool       │                                    ▼
  └──────────────────┘                          ┌─ Port (VectorStore) ─┐
  ┌─ Client ─────────┐  hop 4: VectorHit[] ◄──── │ search(vector, k)    │
  │ ranked results    │ ◄───────────────────────  └─────────┬───────────┘
  └──────────────────┘                              hop 2/3 │ cosine scan
                                                            ▼
                                            ┌─ Adapter ─────────────┐
                                            │ InMemoryVectorStore   │
                                            │  — or PgVectorStore   │
                                            └───────────────────────┘
              the client's code is byte-identical regardless of
              which adapter answers hop 2/3
```

### Move 2 variant — the load-bearing skeleton

Strip the port down to what can't be removed:

1. **Isolate the kernel.** A port is: *a named interface the codebase
   owns + at least two adapters that satisfy it + clients that depend on
   the interface, not the adapters.* That's it. `ModelProvider` (the
   interface) + Gemma & Fixture (two adapters) + `runAgentLoop` (the
   client) is the minimal instance.

2. **Name each part by what breaks if it's missing.**
   - Drop the *interface* → clients import vendor SDKs directly; swapping
     a vendor becomes a find-and-replace across every agent. (The reason
     the monorepo exists, per `context.md`: core must not name a vendor.)
   - Drop the *second adapter* → you have an interface with one
     implementation, which is just an indirection with no payoff. The
     port earns its keep only when something else can satisfy it. AptKit
     proves the port real with `FixtureModelProvider` (test) and
     `PgVectorStore` (durable, external).
   - Drop *client-depends-on-port* (let the client `new` the adapter) →
     the inversion is gone; the dependency points the wrong way and the
     port is decorative.

3. **Skeleton vs hardening.** The kernel is interface + ≥2 adapters +
   inward dependency. Hardening layered on top: the fallback *chain* (try
   adapters in order), the context *guard* (reject before a doomed call),
   the *factory* (`createRetrievalPipeline`) that hides which adapter you
   got. All optional; none changes the kernel.

### Move 3 — the principle

The depth of a port is measured by what its adapters hide, not by the
port's own size. The smaller the interface and the more behavior behind
it, the deeper the module — and the more a swap costs nothing. AptKit's
three-line `ModelProvider` is deep precisely *because* `complete()` can
hide Gemma's entire tool-call emulation (next file) while the client sees
one method.

---

## Primary diagram

```
  The deep provider port — full recap

  ┌─ Client layer ────────────────────────────────────────────────┐
  │ runAgentLoop / RagQueryAgent / pipeline fns                    │
  │   typed against the PORT, never an adapter                     │
  └──────────────┬──────────────────────────┬─────────────────────┘
       depends on│ (arrow points inward)     │depends on
  ┌─ Port layer ★▼──────────────┐   ┌────────▼──────────────────────┐
  │ ModelProvider               │   │ EmbeddingProvider · VectorStore│
  │  { id, defaultModel,        │   │  { dimension, upsert, search } │
  │    complete(req) }          │   │  carries the shared `dimension`│
  └──────────────▲──────────────┘   └────────▲──────────────────────┘
       satisfies │ (arrow points inward)      │satisfies
  ┌─ Adapter layer──────────────┐   ┌─────────┴──────────────────────┐
  │ Gemma (hides emulation)     │   │ InMemoryVectorStore (cosine)   │
  │ Fallback (hides the chain)  │   │ PgVectorStore (in buffr, SQL)  │
  │ ContextGuard (decorator)    │   │ OllamaEmbeddingProvider        │
  │ Fixture (replays recordings)│   │                                │
  └─────────────────────────────┘   └────────────────────────────────┘
        depth = how much each adapter hides behind the small port
```

---

## Elaborate

This is Cockburn's hexagonal architecture and the dependency-inversion
principle, applied at the module level. The reason it's worth a dedicated
file in *this* repo: the entire monorepo's reason to exist
(`context.md` → "Core must not import app-specific product logic") is
enforced by these ports. They're not a stylistic choice; they're the
boundary that lets `@rlynjb/aptkit-core` ship to npm as a vendor-neutral
bundle while buffr supplies the Postgres binding from outside.

The closest thing you've already built: AdvntrCue colocated pgvector in
one Postgres instance. There, the vector store and the app were welded
together. AptKit's move is the un-welding — the same retrieval logic, but
the store is now a port the deployment fills. That's the upgrade from
"RAG that works" to "RAG that's a library."

Read next: `02-emulation-hidden-behind-the-port.md` (the deepest
adapter), `03-contract-as-the-product.md` (why the contract is the
deliverable).

---

## Interview defense

**Q: Why is a three-method interface a *deep* module? Isn't depth about
size?** Depth is functionality divided by interface size — and the
interface is the denominator. A small interface with a lot of behavior
behind it is the deepest possible module. `ModelProvider` has one real
method, `complete()`, and behind it Gemma hides tool-call emulation,
retry, and JSON parsing; the client sees none of it. Small surface, large
hidden body — that's deep by definition.

```
  depth = functionality / interface-size

  ┌──────────────┐   small interface (3 fields)
  │ ModelProvider│   ─────────────────────────────
  └──────┬───────┘   large hidden body (emulation,
         ▼            retry, parse, flatten)  → DEEP
```

Anchor: "the port is the denominator; the adapter is the numerator."

**Q: How do you know the port is the *right* boundary and not premature
abstraction?** Two independent things satisfy it that the core never
imports: `FixtureModelProvider` for tests and buffr's `PgVectorStore` for
durability. An interface with exactly one implementation is just
indirection; this one has several, including one from a different repo.
That's the proof the seam was real, not speculative.

Anchor: "a port with one adapter is indirection; with two it's a seam."

---

## See also

- `00-overview.md` — the PATTERN VOCABULARY (port / adapter / client / seam)
- `02-emulation-hidden-behind-the-port.md` — what the deepest adapter hides
- `03-contract-as-the-product.md` — the contract as the shipped artifact
- `05-injectable-transport-seam.md` — a sub-port inside the Gemma adapter
- `audit.md` — lens 2 (deep-vs-shallow) and lens 8 (red flags)
- `../study-system-design/` — provider-abstraction at the service altitude
