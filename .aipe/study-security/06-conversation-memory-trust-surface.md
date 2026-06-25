# Conversation-memory trust surface

*Retrieval-based episodic memory · persistent prompt injection + retention + shared-store mixing · LLM-agent security · Project-specific*

## Zoom out, then zoom in

Until `@aptkit/memory` landed, every injection surface in this repo was
*single-turn*: a hostile question or a poisoned knowledge-base chunk could
steer the model on **that** request, but the blast radius ended when the loop
returned. Conversation memory removes that boundary. `remember(turn)` embeds a
past user question + assistant answer and stores it as a vector row; `recall`
pulls the most-similar past exchanges back into a *future, unrelated* request.
That is exactly the mechanism a RAG corpus uses for documents — so it inherits
the document-injection threat (a retrieved chunk is untrusted content in the
prompt) and adds a new one: **the untrusted content is now something the user
themselves said on a prior turn, replayed into a later context they never
connected it to.**

```
  Where the memory boundary sits

  ┌─ turn N (e.g. a hostile or manipulated question) ───────────────┐
  │  user asks Q_N  →  agent answers A_N                            │
  │            remember({conversationId, Q_N, A_N})                 │
  │            embed → upsert  meta.kind='memory', text="Q_N…A_N"   │ ← stored
  └──────────────────────────────┬──────────────────────────────────┘
                                 │  vector row persists indefinitely
  ┌─ turn N+k (unrelated query, maybe a different session) ─────────┐
  │  recall(Q_{N+k})  → similarity search → past Q_N/A_N text       │ ← replayed
  │  → fed back into the model's context as "past exchange"         │
  └──────────────────────────────────────────────────────────────────┘
```

The engine lives at `packages/memory/src/conversation-memory.ts`; the optional
agent-facing tool at `packages/memory/src/memory-tool.ts`. It ships in the
published bundle (`packages/core/src/index.ts:8` re-exports `@aptkit/memory`)
but is **not yet wired into any agent inside aptkit** — the only live
consumer is buffr's chat session (`/Users/rein/Public/buffr/src/session.ts:53,66`),
which is where the real trust decisions get made.

## What the control actually does — and what it does *not*

The engine's *only* trust-relevant filter is `kind`. `remember` upserts with
`meta.kind` (`conversation-memory.ts:84`); `recall` over-fetches then keeps
only rows whose `meta.kind === kind` (`conversation-memory.ts:96-98`). That
separates memory from documents *within a result set*. It does **nothing**
else:

- It does **not** filter by `conversationId`. `recall(query, k)` takes no
  conversation or tenant argument (`conversation-memory.ts:89`) — it returns
  the most-similar memory rows in the whole store, regardless of which
  conversation wrote them. `conversationId` is stored
  (`conversation-memory.ts:84`) and returned on the hit
  (`conversation-memory.ts:103-104`), but the engine never filters on it. The
  docstring says so plainly: isolation "is the caller's job."
- It does **not** redact, expire, or cap. Every remembered turn stores the
  **raw** question and answer text verbatim (`defaultFormat`,
  `conversation-memory.ts:44-46`) and upserts it with no TTL, no eviction, no
  PII pass. Memory grows monotonically.
- It does **not** distinguish trust level once a row is in a shared store. In
  buffr's wiring the memory store **is** the document store
  (`session.ts:53` passes the same `PgVectorStore`), so a `kind='memory'` row
  lands in `agents.chunks` alongside indexed documents and is returned by the
  same `search_knowledge_base` tool the agent already calls
  (`session.ts:43-44`). The agent cannot tell "a document the operator indexed"
  from "something a past user typed" — both arrive as tool results.

## The four new trust seams, named

**1. Persistent prompt injection / memory poisoning.** A single-turn injection
in this repo is gated by the output validator and read-only tools
(`04-validated-model-output-gate.md`, `01-tool-policy-enforcement-by-omission.md`).
Memory defeats the *temporal* bound of those gates. If turn N's question (or
an answer steered by injected content — see `04`, the answer is untrusted too)
contains an instruction, `remember` embeds it, and a semantically similar
turn N+k recalls it straight back into context — possibly in a **different
session**, since buffr persists to a durable `PgVectorStore`
(`session.ts:41,53`). The injection is no longer "what the model saw this
request"; it's "what the model will see whenever a future query is similar
enough to retrieve it." This is the single sharpest new exposure: it converts
the existing, well-mitigated single-turn injection finding into a
**persistent** one, and the existing mitigations (output gate, read-only
tools) limit *what the injected instruction can do*, not *that it gets
replayed*.

**2. Shared-store trust-level blur.** Because buffr shares the store, memory
surfaces through `search_knowledge_base` (`session.ts:51`), the tool whose
results the agent already treats as grounding for cited answers. A retrieved
document is operator-curated; a retrieved memory row is *user-authored*. The
tool's output carries `meta` through to the model (`text` and a snippet,
`search-knowledge-base-tool.ts:110-116`) with no marker of which kind it is —
so the agent may cite a past user's words as if they were a knowledge-base
fact. The `kind` tag exists in the row but `search_knowledge_base` does not
read it (only `recall` does), so the document tool is exactly the wrong place
for the one filter the engine has to land.

**3. Indefinite retention of raw Q/A (PII / data-exposure).** Every exchange
is stored verbatim and forever (`conversation-memory.ts:84`, no eviction
anywhere in the engine). In buffr these rows persist in Postgres
(`agents.chunks`, `/Users/rein/Public/buffr/sql/001_agents_schema.sql:14-25`).
A user who pastes a customer record, a token, or personal data into a question
has now created a durable, embeddable, recallable copy of it — and, on the
shared-store path, one that can resurface in a later answer. This widens the
existing data-exposure finding (`02-secret-scan-guard.md`, lens 5): that guard
runs over **replay artifacts**, not over memory rows, so a secret a user types
is captured by `remember` *without passing the secret-scan at all*.

**4. Cross-conversation leakage rests entirely on the caller.** Since `recall`
ignores `conversationId`, isolation depends on the *store* being scoped.
buffr's `PgVectorStore.search` filters `where app_id = $2`
(`/Users/rein/Public/buffr/src/pg-vector-store.ts:74,77`), so memory can't leak
*across app_ids* — but **within** an app_id, every conversation's memory is
recallable by every other (buffr runs a single `appId`, default `'laptop'`,
`session.ts:41`, `pg-vector-store.ts:27`). There is **no row-level security**
in the schema — app_id isolation is a `WHERE` clause in application code, not a
DB-enforced policy (`001_agents_schema.sql` defines `app_id` columns and a
plain index, no `enable row level security`, no policies). This is the exact
shape of the retrieval `app_id` story: the engine filters by `kind`, the store
filters by `app_id` in SQL, and a multi-tenant deployment would need a real
isolation boundary that does not exist yet.

## The load-bearing test

*If you stripped this analysis out, which trust assumption goes unexamined?*
"The agent's context contains only operator-curated documents and the current
question." With memory wired (buffr), that's false: the context can contain
**any past user's words from the same app_id, replayed by similarity**, with
no trust marker and no retention bound. Strip the framing and a persistent
injection or a leaked PII string looks identical to a benign document hit.

## Buildable moves (defensive, not exploit)

- **Mark memory at the surfacing point.** Have `search_knowledge_base` (or a
  dedicated `search_memory`, `memory-tool.ts`) label memory hits as
  user-authored / lower-trust in the tool result, so the model is told the
  provenance instead of inferring grounding. The `kind` is already on the row.
- **Scope recall to the caller.** Add a `conversationId`/tenant filter to
  `recall` (or to the store query) so isolation isn't "the caller's job" by
  omission. Until then, document that a *shared* store across tenants is unsafe.
- **Bound retention.** TTL / eviction / a redaction pass in `remember`, and run
  the existing `findSecretLikeString` guard (`02-secret-scan-guard.md`) over the
  formatted turn *before* upsert so a typed secret can't become a durable
  embedded row.
- **Row-level security in buffr** before any multi-tenant use — the `app_id`
  `WHERE` clause is app-code, not a DB policy; a query that forgets it (or a
  future direct SQL path) reads every tenant's memory.

## Cross-links

- `04-validated-model-output-gate.md` — the single-turn injection gate this
  surface makes *persistent*; the answer text memory stores is itself
  untrusted output per that file.
- `01-tool-policy-enforcement-by-omission.md` — why a recalled injection can't
  reach a mutating tool (read-only allowlists) even though it gets replayed.
- `02-secret-scan-guard.md` — the data-exposure guard that does **not** cover
  memory rows.
- `.aipe/study-prompt-engineering/12-prompt-injection-defense.md` — the
  injection-defense posture, now to be read with "and it persists across
  sessions once remembered" appended.
- `.aipe/study-data-modeling/` — the `agents.chunks` shape memory shares with
  documents, and the dropped document-FK that lets a memory row exist with no
  document parent (`001_agents_schema.sql:26-27`).
