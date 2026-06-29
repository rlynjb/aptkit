# 03 — Library vs deployment split

**Industry name(s):** library/host separation · dependency injection at the
repo boundary · "framework vs application" split. **Type:** Project-specific
(a textbook idea, drawn at an unusual place — the repo boundary).

## Zoom out, then zoom in

Files `01` and `02` showed seams *inside* aptkit. This is the seam *around* it: the
whole library is one swappable unit, and a second repo — buffr — is the thing that
swaps the slots and runs it for real.

```
  Zoom out — the seam runs between two repos

  ┌─ aptkit (this repo, private:true) ──────────────────────────────┐
  │  runtime · agents · providers · retrieval · memory · evals       │
  │  default impls: InMemoryVectorStore, gemma, no durable trace     │
  │  packages/core re-exports all 16  ──►  npm bundle @rlynjb/aptkit-core
  └────────────────────────────────────────┬─────────────────────────┘
                                           │  npm install (published 0.4.x)
  ═══════════════════════════ LIBRARY / DEPLOYMENT SEAM ══════════════
                                           │
  ┌─ buffr (separate repo) ────────────────▼─────────────────────────┐
  │ fills the slots: PgVectorStore, SupabaseTraceSink, pg pool,       │ ← here
  │ the `agents` schema, profile loading, ChatSession lifecycle       │
  └───────────────────────────────────────────────────────────────────┘
```

The question: *where do you draw the line between reusable agent machinery and
deployment-specific wiring — and how do you keep the reusable half from ever knowing
about Postgres, Supabase, or "the laptop"?* aptkit's answer is to draw it at the repo
boundary: the durable, deployment-specific code lives in a *different repo* that
consumes the published bundle. Here's how the slots get filled.

## Structure pass

**Layers:** aptkit (contracts + default impls) → published npm bundle → buffr
(durable impls + lifecycle).

**Axis traced — *who knows about Postgres?***

```
  One axis — "who names a database?" — traced across the seam

  ┌─ aptkit core ──────────┐   NEVER. it speaks VectorStore + CapabilityTraceSink.
  └──────────┬──────────────┘
  ┌─ published bundle ─────▼┐   NEVER. it's the same code, tarballed.
  └──────────┬──────────────┘
  ┌─ buffr ─────────────────▼┐  ONLY HERE. pg.Pool, agents.chunks, Supabase.
  └──────────────────────────┘  the answer flips at the repo boundary.
```

**Seam:** the npm publish boundary. Knowledge of any concrete datastore is on
buffr's side only. aptkit defines the slots (`VectorStore`, `CapabilityTraceSink`);
buffr fills them.

## How it works

### Move 1 — the mental model

Think of it like React vs your app. React ships the reconciler, hooks, the component
contract — it never knows your API base URL or your auth provider. *Your app* fills
those in. aptkit is the "React": agent loop, contracts, default local impls. buffr is
the "app": it injects the durable backends and owns the process lifecycle. The
unusual part is that the line is a *repo* boundary, enforced by npm publish, not just
a module boundary.

```
  The split — define slots vs fill slots

  aptkit defines:                buffr fills:
  ┌──────────────────────┐       ┌────────────────────────────┐
  │ VectorStore          │◄──────│ new PgVectorStore({ pool })  │
  │ CapabilityTraceSink  │◄──────│ new SupabaseTraceSink({pool})│
  │ ModelProvider        │◄──────│ guard(new GemmaModelProvider)│
  │ EmbeddingProvider    │◄──────│ new OllamaEmbeddingProvider  │
  │ RagQueryAgent        │──used─►│ new RagQueryAgent({ ...above})│
  └──────────────────────┘       └────────────────────────────┘
```

### Move 2 — the walkthrough

**aptkit declares it's a library, not an app.** Root `package.json` is
`"private": true` with `"version": "0.0.0"` — the repo itself never publishes. Only
`packages/core` publishes, as `@rlynjb/aptkit-core@0.4.1`, with `bundledDependencies`
inlining all 16 internal packages (see `07-single-bundle-publishing.md`). **What
breaks if missing:** without the private root + single published surface, a consumer
would have to install 16 separate `@aptkit/*` packages and keep their versions in
lockstep.

**buffr imports the bundle and fills the slots.** This is the load-bearing file —
`createChatSession` is the entire wiring, and every line either constructs an aptkit
type or injects a buffr backend into one:

```ts
// buffr/src/session.ts:34 (abridged)
const pool = createPool(cfg.databaseUrl);                              // buffr: durable backend
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5' }); // aptkit type
const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension }); // buffr fills VectorStore
const pipeline = createRetrievalPipeline({ embedder, store });          // aptkit
const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });   // aptkit
const tools = new InMemoryToolRegistry([tool.definition], { ... });     // aptkit
const model = new ContextWindowGuardedProvider(new GemmaModelProvider(...), { maxTokens: 8192 }); // aptkit, composed
const memory = createConversationMemory({ embedder, store });           // aptkit engine, buffr store
const trace = new SupabaseTraceSink({ pool, conversationId });          // buffr fills CapabilityTraceSink
const agent = new RagQueryAgent({ model, tools, profile, trace });      // aptkit agent, all slots filled
```

Read the comments: every `aptkit type` came from `@rlynjb/aptkit-core`; every
`buffr fills` is the deployment-specific half. The agent at the bottom can't tell
its store is Postgres or its trace goes to a database — it only sees the contracts.

**buffr owns the lifecycle aptkit can't.** aptkit is stateless machinery; buffr owns
the things a deployment must own:

- **The process model** — one warm `pg.Pool`, one `conversation` row held across
  every turn (`session.ts:34`). aptkit has no concept of a long-lived session.
- **Persistence** — `persistMessage`/`startConversation` write to the `agents`
  schema (`supabase-trace-sink.ts:4`). aptkit never touches a database.
- **Best-effort policy** — a memory-write failure is swallowed so the answer isn't
  lost (`session.ts:65`). That's a *deployment* decision about acceptable failure,
  made on buffr's side.

```
  Layers-and-hops — one ask() across the seam

  ┌─ buffr ChatSession ─────┐  hop1: persistMessage(user)   ┌─ Postgres ──┐
  │  ask(question)          │ ─────────────────────────────►│ agents.*    │
  └──────────┬───────────────┘                              └─────────────┘
             │ hop2: agent.answer(question)   [crosses into aptkit]
  ┌─ aptkit RagQueryAgent ──▼┐  hop3: runAgentLoop → model + search tool
  │  (no DB knowledge)        │      trace.emit(event) per step
  └──────────┬────────────────┘            │ hop4 (back in buffr): SupabaseTraceSink
             │ hop5: trace.flush()          ▼  writes each event to agents.messages
  ┌─ buffr ─────────────────┐  hop6: memory.remember (best-effort, swallow on fail)
  └──────────────────────────┘
```

**Move 2.5 — current state vs future state.** The split is fully shipped, but it
reveals what *doesn't* have to change as deployments grow. buffr is one laptop,
single-process. A future cloud deployment (call it a second host) would reuse aptkit
unchanged — it would just fill the `VectorStore` slot with a managed pgvector and the
`CapabilityTraceSink` slot with a different sink. The contracts are the stable part;
the deployment is the variable part.

```
  Phase A (now)              Phase B (hypothetical second host)
  ─────────────              ────────────────────────────────
  buffr / laptop             cloud service
  PgVectorStore → Supabase   PgVectorStore → managed pgvector
  SupabaseTraceSink → PG     OTel sink → traces backend
  one process, one user      N processes (needs the dist-systems work)
  ─────────────────────────────────────────────────────────────
  UNCHANGED across both: every line of aptkit core
```

The cost of Phase B isn't in aptkit — it's the coordination work flagged in
`audit.md` lens 7 and owned by **`study-distributed-systems`**.

### Move 3 — the principle

Draw the reusable/deployment line at the *contract*, then let the boundary be as
hard as you can afford — here, a whole repo and an npm publish. The test of whether
you drew it right: the reusable half compiles and runs with a fake (in-memory)
backend, and the deployment half is *only* slot-filling plus lifecycle. aptkit
passes that test — it runs end-to-end with zero cloud, and buffr's wiring file is
almost entirely constructors.

## Primary diagram

The whole split, both repos, with the slots and their fillers lined up.

```
  Library vs deployment split — full picture

  ┌─ aptkit (private repo) ────────────────────────────────────────────┐
  │ DEFINES SLOTS:  ModelProvider · EmbeddingProvider · VectorStore ·    │
  │                 CapabilityTraceSink · ToolRegistry                   │
  │ DEFAULT IMPLS:  gemma · OllamaEmbeddingProvider · InMemoryVectorStore│
  │ AGENTS:         RagQueryAgent + 5 others                             │
  │ packages/core ─► bundledDependencies (16) ─► npm @rlynjb/aptkit-core │
  └────────────────────────────────┬─────────────────────────────────────┘
                  npm install       │  (compatibility contract, semver 0.4.x)
  ════════════════════════════════ SEAM ═════════════════════════════════
  ┌─ buffr (separate repo, the deployment body) ───────▼──────────────────┐
  │ FILLS SLOTS:    PgVectorStore (Supabase pgvector+HNSW)                 │
  │                 SupabaseTraceSink (agents.messages)                    │
  │ OWNS LIFECYCLE: warm pg.Pool · one conversation/session · best-effort  │
  │                 memory writes · the `agents` schema in shared reindb   │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the "mechanism not policy" separation (from OS design) applied at repo
scale: aptkit is mechanism (how an agent loop runs, how retrieval is shaped); buffr
is policy (which database, which failure tolerance, which process model). Drawing it
as two repos is stronger than two modules because the publish boundary makes leakage
*structurally* impossible — buffr can't reach into an aptkit internal that isn't
exported, and aptkit can't import buffr at all.

The five system shapes you've shipped each made a different deployment choice
(GitHub-as-store, SQLite+Supabase, filesystem) but *coupled* the machinery to that
choice. aptkit's move is to refuse the coupling and force the choice into a separate
repo. Read next: `07-single-bundle-publishing.md` (the mechanics of the publish
boundary) and `05-capability-event-trace.md` (the trace slot buffr fills).

## Interview defense

**Q: Why a separate repo instead of just modules in one repo?**
Because a publish boundary is enforced — buffr literally cannot import an aptkit
internal that `packages/core` doesn't re-export, and aptkit cannot import buffr.
Module boundaries rely on discipline; a repo + npm boundary is mechanical. Anchor:
*the seam is an `npm install`, so leakage is a compile error, not a code review.*

```
  aptkit ──publish──► npm ──install──► buffr
         (one-way; aptkit never imports buffr)
```

**Q: What does buffr actually add over aptkit?**
Two slot-fills (`PgVectorStore`, `SupabaseTraceSink`) and the lifecycle aptkit
deliberately has no opinion on: a warm connection pool, one conversation held across
turns, and a best-effort failure policy for memory writes. Everything else is aptkit
unchanged. Anchor: *buffr's wiring file is constructors and a lifecycle; no agent
logic.*

**Q: What's the load-bearing part people miss?**
That aptkit runs *fully* with the default in-memory/local impls — the split isn't
"aptkit is useless without buffr." It's "aptkit is complete with fakes; buffr swaps
the fakes for durable backends." That's why the in-memory store and gemma exist as
*defaults*, not test-only doubles. Anchor: *zero-cloud end-to-end is the proof the
line is in the right place.*

## See also

- `01-provider-neutral-model-seam.md` / `02-retrieval-contracts-as-the-swap-point.md`
  — the contracts buffr fills.
- `05-capability-event-trace.md` — the trace slot.
- `07-single-bundle-publishing.md` — the publish mechanics.
- **`study-distributed-systems`** — what a multi-process Phase B would require.
