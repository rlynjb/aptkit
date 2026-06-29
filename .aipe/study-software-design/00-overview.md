# Software Design — Overview & Pattern Vocabulary

One-page orientation for the AptKit software-design study guide, plus
the **PATTERN VOCABULARY** this guide owns. Read this first; it's the
map and the dictionary every other file in the folder uses.

---

## The through-line

> **Complexity is the enemy. Deep modules are the weapon.**

A *deep* module hides a lot of behavior behind a small interface. A
*shallow* one has an interface nearly as big as its body. AptKit's whole
design bet is depth at three seams — the model-provider contract and the
two retrieval contracts — so that everything above them stays simple. The
audit measures how well the bet pays off, and where a few facts leaked
out of their module and now have to be maintained in two or three places.

```
  AptKit, one diagram — the deep seams (★) hold the design together

  ┌─ Clients (agents, Studio, buffr) ───────────────────────────┐
  │  RagQueryAgent · recommendation · query · monitoring · ...   │
  └───────────────┬───────────────────────┬─────────────────────┘
                  │ depends on             │ depends on
  ┌─ Ports ───────▼───────────┐   ┌────────▼─────────────────────┐
  │ ★ ModelProvider           │   │ ★ EmbeddingProvider          │
  │   (model-provider.ts)     │   │ ★ VectorStore (contracts.ts) │
  └───────┬───────────────────┘   └────────┬─────────────────────┘
          │ implemented by                  │ implemented by
  ┌─ Adapters ────────────────┐   ┌─────────▼─────────────────────┐
  │ Gemma · Anthropic · OpenAI│   │ InMemoryVectorStore (here)    │
  │ Fallback · ContextGuard   │   │ PgVectorStore (in buffr)      │
  │ Fixture (test)            │   │ OllamaEmbeddingProvider       │
  └───────────────────────────┘   └───────────────────────────────┘
```

The dependency arrows point **inward, at the ports** — never from a
client to an adapter. That's the dependency-inversion bet, and it's why
buffr can supply `PgVectorStore` without aptkit knowing Postgres exists.

---

## PATTERN VOCABULARY — the role-names this guide owns

Every Pass 2 file teaches a named pattern, and every pattern carries its
own standard role-vocabulary. The rule (from `format.md`):
**standard term leads, repo's local name in parens on first use** —
"the port (`ModelProvider`)", "the adapter (`GemmaModelProvider`)",
"the seam (the retrieval contracts)". Never reversed.

AptKit is, at the code level, a **ports & adapters** codebase (also
called hexagonal architecture / dependency-inversion). This guide is the
canonical home of that vocabulary at the module/interface altitude. The
same pattern shows up at the architecture altitude in
`../study-system-design/` (`provider-abstraction`) — that guide
cross-links back here for the role definitions.

```
  THE THREE ROLES (the core)

  port      the interface/contract — the swap point the codebase
            owns. The shape; holds no behavior.
            (= interface = contract = abstraction)
            AptKit: ModelProvider, EmbeddingProvider, VectorStore

  adapter   an implementation of the port; adapts an outside thing
            (vendor SDK, local HTTP, fixture) to the port's shape.
            AptKit: GemmaModelProvider, InMemoryVectorStore,
                    FallbackModelProvider, FixtureModelProvider

  client    code that depends on the port and calls it. (Prefer
            "client" over "caller" — avoids colliding with any
            repo type.)
            AptKit: runAgentLoop, RagQueryAgent, the pipeline fns

  → a client depends on a port; adapters implement it; the two
    sides never touch — only the port between them.
```

```
  THE SUPPORTING CAST (helpers, not roles)

  factory   selects + constructs an adapter and returns it AS the
            port, so clients never name a concrete adapter.
            AptKit: createRetrievalPipeline(wiring) returns the
                    RetrievalPipeline bound to whichever store/
                    embedder you passed — a light factory.

  DI        dependency injection — passing the adapter in as a
            parameter instead of the client fetching it.
            AptKit: createConversationMemory({ embedder, store }),
                    new GemmaModelProvider({ chat }),
                    RagQueryAgent({ model, tools })

  DIP       dependency inversion — depend on the port, not the
            adapter. DI is the how; DIP is the why.
            AptKit: the pipeline never imports a vendor; buffr's
                    PgVectorStore satisfies VectorStore from outside.

  seam      a boundary you can swap on one side without the other
            side changing.
            AptKit: the VectorStore boundary (swap in-memory ↔
                    pgvector); the GemmaChatTransport boundary
                    (swap real HTTP ↔ recorded responses in tests).
```

```
  VERBS / PHRASES THAT SIGNAL FLUENCY (use these in the files)

  "the adapter implements the port"
  "the client depends on the port"
  "GemmaModelProvider satisfies ModelProvider"   (structural)
  "swap the adapter behind the port"
  "the dependency points inward / at the port"   (DIP)
  "seam — swapped on one side, the other side unchanged"
```

```
  MAPPING — anchored in AptKit's real stack (calibration)

  runAgentLoop / RagQueryAgent  →  client
  ModelProvider                 →  port   (the upper seam)
  EmbeddingProvider             →  port
  VectorStore                   →  port   (the lower seam)
  GemmaModelProvider            →  adapter (local, live)
  InMemoryVectorStore           →  adapter (in-process)
  PgVectorStore (in buffr)      →  adapter (durable, external)
  FixtureModelProvider          →  adapter (test double)
  GemmaChatTransport            →  a port  (sub-seam inside Gemma)
  createRetrievalPipeline(...)  →  factory
  ({ embedder, store }) args    →  DI (adapter passed in, not picked)

  four words and you have it:  port · adapter · client · seam
```

Where a pattern other than ports & adapters fires (the
decorator — `ContextWindowGuardedProvider`; the chain — the fallback
provider), that pattern's own role-words lead, defined inline in the file
where it appears.

---

## Reading order

```
  00-overview.md                  ← you are here (map + vocabulary)
  audit.md                        ← Pass 1: the 8-lens audit
  ───────────────────────────────────────────────────────────────
  01-deep-provider-port.md        ← the deepest design move: the ports
  02-emulation-hidden-behind-the-port.md
                                  ← what the deepest adapter hides
  03-contract-as-the-product.md   ← why the contract IS the deliverable
  04-guard-rails-as-information-hiding.md
                                  ← minTopK / matchesFilter / dim guards
  05-injectable-transport-seam.md ← the sub-seam that makes Gemma testable
  06-capability-as-composition.md ← the RAG agent assembled from ports
```

Read `audit.md` for the verdicts and the ranked fixes; read the `0N-`
files for the deep walks behind the patterns the audit cross-links to.

---

## Source note

The design primitives here — deep modules, information hiding,
complexity, layering, pull-complexity-down, define-errors-out — are from
**John Ousterhout, *A Philosophy of Software Design*.** The ideas are
taught here in original words and applied to AptKit's real files; for the
full conceptual treatment read the book, and see the `read-aposd`
guide for the framework taught chapter by chapter. The ports & adapters
vocabulary is standard (Cockburn's hexagonal architecture / the
dependency-inversion principle); the role definitions above are the
transferable words, bound to this repo's names.

## See also

- `../study-system-design/` — the same seams one altitude up (service
  boundaries, provider-abstraction); cross-links back to this vocabulary
- `../study-agent-architecture/` — the agent loop as a client of the ports
- `../study-testing/` — the fixture/replay test doubles
- `read-aposd` — the book taught as a framework
