# 05 — Library vs deployment split (aptkit fills no slots; buffr does)

> **Subtitle:** Library/deployment separation / Hexagonal core with an
> external composition root — *Industry standard.* aptkit is the
> deployment-agnostic library (the core + its ports); buffr is the
> composition root (the adapter that wires real implementations into the
> ports). The two repos meet at the npm bundle.

## Zoom out — where this sits

aptkit holds zero durable state, names zero databases, and assumes nothing
about where it runs. It exposes ports and leaves the slots empty. A *separate
repo*, buffr, installs aptkit as one npm dependency and plugs Postgres,
pgvector, and a trace database into those empty slots. The split is the whole
reason the monorepo exists.

```
  Zoom out — the two repos and the boundary between them

  ┌─ aptkit (library, deployment-agnostic) ────────────────────────────┐
  │  ports:   ModelProvider · EmbeddingProvider · VectorStore           │
  │           CapabilityTraceSink                                       │
  │  default adapters: gemma · OllamaEmbeddingProvider ·                │
  │                    InMemoryVectorStore (non-durable)                │
  │  the agents, the loop, the eval kit — all of it                     │
  └───────────────────────────┬─────────────────────────────────────────┘
                  ships as ─────┼──── @rlynjb/aptkit-core@0.4.1 (one npm tarball)
  ┌─ buffr (deployment, the composition root) ▼─────────────────────────┐
  │  installs the bundle, then FILLS THE SLOTS:                         │
  │   PgVectorStore        → implements VectorStore over Supabase       │
  │   SupabaseTraceSink     → implements CapabilityTraceSink            │
  │   agents schema (SQL)   → the durable tables                        │
  │   one warm pg.Pool, one in-process conversation (the laptop runtime)│
  └─────────────────────────────────────────────────────────────────────┘
```

The seam here isn't a function call — it's a *repository boundary* crossed by
an npm package. aptkit ships, buffr installs and composes.

## Structure pass — layers, axis, seam

Two layers, but they live in different repos: the **library** (ports + default
adapters) and the **deployment** (durable adapters + composition). Trace one
axis — **what may this code know about** — across the boundary:

```
  axis traced: "what is this layer allowed to depend on?"

  ┌─ aptkit (library) ──────────┐   may know: its own ports, neutral types.
  │                             │   MUST NOT know: Supabase, app product logic.
  └──────────────┬───────────────┘   (a hard constraint in context.md)
   repo seam ════╪════  ← dependency direction flips: library ◄── deployment
  ┌─ buffr (deployment) ▼───────┐   may know: aptkit's ports AND Supabase, pg, the schema.
  │                             │   it depends on aptkit; aptkit never depends on it.
  └─────────────────────────────┘
```

The dependency arrow points one way only: buffr → aptkit, never back. That's
dependency inversion at the repo level — the library defines the contract, the
deployment satisfies it. If the arrow ever reversed (aptkit importing a buffr
detail), the split would be broken.

## How it works

### Move 1 — the mental model

You know dependency injection: a component declares an interface prop and the
parent passes the real thing in. This is that, but the "parent" is a whole
separate repo and the "prop" is a port aptkit exposes. aptkit declares
`VectorStore`; buffr passes in `PgVectorStore`.

```
  the pattern — composition root in a different repo

  aptkit defines:    VectorStore (interface, no impl that persists)
                          ▲
                          │ implements
  buffr supplies:    PgVectorStore ──┐
                                     ▼
  buffr composes:    createChatSession({ store: new PgVectorStore(pool), ... })
                     ── the ONE place real implementations meet the ports
```

The composition root — the single place where concrete implementations get
wired to ports — lives in buffr's `session.ts`, not in aptkit at all.

### Move 2 — the parts

**The empty slots (aptkit).** aptkit's defaults are deliberately
non-production: `InMemoryVectorStore` loses its corpus on exit, the gemma
adapter is local-only. They exist so the library *runs* with zero external
deps — for tests, for the Studio demo — not so it ships to production. The
durable slots are left for the deployment.

**The composition root (buffr).** `/Users/rein/Public/buffr/src/session.ts`
(`createChatSession`, lines 34-76) is where it all comes together:

```ts
const embedder = new OllamaEmbeddingProvider(...);        // from the bundle
const store    = new PgVectorStore(pool);                  // buffr's own adapter
const pipeline = createRetrievalPipeline({ embedder, store });   // bundle wires them
const memory   = createConversationMemory({ embedder, store });  // line 53: same store
const agent    = new RagQueryAgent(...);                   // from the bundle
// ... per turn: agent.run() → trace flushed → memory.remember(exchange)  (line 66)
```

Every named import except `PgVectorStore` and the trace sink comes from
`@rlynjb/aptkit-core`. buffr's *own* code is just the two adapters
(`PgVectorStore`, `SupabaseTraceSink`), the SQL schema, and this wiring.

```
  layers-and-hops — buffr filling aptkit's slots

  ┌─ buffr/session.ts (composition root) ──────────────────────────────┐
  │  imports from @rlynjb/aptkit-core ──hop1──► OllamaEmbeddingProvider │
  │                                              createRetrievalPipeline │
  │                                              RagQueryAgent           │
  │  injects buffr-owned adapters ───hop2──────► PgVectorStore (store)   │
  │                                              SupabaseTraceSink (trace)│
  └───────────────────────────┬─────────────────────────────────────────┘
                  hop3: store.search / upsert │
                                              ▼
  ┌─ Supabase Postgres (durable, buffr only) ──────────────────────────┐
  │  schema `agents`: documents · chunks(vector 768, HNSW) · messages   │
  │  sql/001_agents_schema.sql:28-29  hnsw (embedding vector_cosine_ops)│
  └─────────────────────────────────────────────────────────────────────┘
```

**The buffr adapters, concretely.** `PgVectorStore`
(`/Users/rein/Public/buffr/src/pg-vector-store.ts:19`) implements
`VectorStore`: `upsert` is an `INSERT … ON CONFLICT` (lines 38-65), `search` is
`1 - (embedding <=> $1::vector)` with `app_id` filtering ordered by distance
(lines 67-85). `SupabaseTraceSink` implements `CapabilityTraceSink` (covered in
`04`). The `agents` schema (`sql/001_agents_schema.sql`) holds the durable
tables, `app_id`-keyed for multi-tenant separation.

#### Move 2 variant — the load-bearing skeleton

The split's kernel: **ports in the library + a composition root in the
deployment + a one-way dependency arrow**. What breaks if each goes:

- **the ports** — gone, and the library hardcodes a database; buffr can't
  substitute anything, and aptkit can't ship as deployment-agnostic.
- **the composition root in a separate repo** — gone (wiring done inside
  aptkit), and aptkit now imports Supabase; the library is no longer neutral.
- **the one-way dependency arrow (buffr → aptkit, never reverse)** — gone, and
  product/deployment logic leaks back into core, which is the exact thing the
  "core must not import app-specific logic" constraint
  (`.aipe/project/context.md`) forbids. This is the part that's easy to
  violate and the whole reason the rule exists.

Hardening on top: the published-API compatibility contract, the `@aptkit/core`
↔ `@rlynjb/aptkit-core` alias.

### Move 3 — the principle

Put the contracts in the library and the concrete wiring in the deployment, and
keep the dependency arrow pointing only one way. The payoff is concrete:
aptkit can be published, tested, and demoed with zero infrastructure, while
buffr — or any future deployment — supplies the durable pieces by implementing
ports it doesn't have to modify the library to satisfy.

## Primary diagram

```
  library vs deployment, full recap

  ┌─ aptkit (published library) ───────────────────────────────────────┐
  │  PORTS: ModelProvider · EmbeddingProvider · VectorStore · TraceSink │
  │  DEFAULT (non-durable) adapters + agents + loop + evals             │
  │  may NOT depend on any deployment ──────────────────────────────────┘
  │                          │ @rlynjb/aptkit-core@0.4.1 (npm)
  │      one-way dependency  ▼
  ┌─ buffr (deployment / composition root) ────────────────────────────┐
  │  session.ts wires: bundle imports + PgVectorStore + SupabaseTraceSink│
  │  agents schema (SQL) · pgvector+HNSW · one pg.Pool · one conversation│
  │  depends on aptkit; aptkit never depends on buffr                   │
  └─────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the Hexagonal / Ports-and-Adapters architecture taken to the repo
level: the "application core" is a published package, and the "composition
root" (the term for the single place where the object graph is wired) lives in
the consuming deployment. The constraint that makes it real is social as much
as technical — "core must not import app-specific product logic" — enforced by
keeping them in separate repos so a violation requires a deliberate dependency,
not an accidental import. The buffr storage internals belong to
`study-database-systems` and the schema to `study-data-modeling`; this file
owns only the boundary.

## Interview defense

**Q: Why two repos instead of one with a `prod` config?**
Because the boundary is a *dependency* boundary. In one repo, nothing stops an
accidental import of a Supabase detail into the core. Across repos, the library
literally cannot import the deployment — the arrow only points buffr → aptkit.
The library publishes contracts; the deployment satisfies them.

```
  buffr ──depends on──► aptkit        (never the reverse)
  PgVectorStore implements VectorStore; aptkit never names pgvector
```
*Anchor:* "aptkit defines the ports; buffr is the composition root that fills them."

**Q: What's the part people get wrong?**
Letting the dependency arrow reverse — putting deployment-specific wiring or
product logic into the core "just for now." That's the one constraint the whole
split protects. The composition root has to live in the deployment, not the
library, or the library stops being deployment-agnostic.

```
  composition root = buffr/session.ts  (NOT inside aptkit)
```
*Anchor:* "Core must not import app-specific logic — that's the whole point."

## See also

- `00-overview.md` — the deployment boundary on the full map
- `01-provider-abstraction.md` / `02-retrieval-as-a-tool.md` — the ports buffr fills
- `04-capability-event-trace.md` — the trace sink buffr supplies
- `06-single-bundle-publishing.md` — how the boundary is shipped (one tarball)
- `study-database-systems` / `study-data-modeling` — buffr's store + schema
