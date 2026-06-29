# 04 — `app_id` tenancy without row-level security

**Industry name(s):** shared-schema multi-tenancy · discriminator-column
tenancy · application-enforced isolation (vs database-enforced / RLS).
**Type:** Industry-standard tenancy pattern, with the DB-level half (RLS)
deferred.

## Zoom out, then zoom in

Every tenant-scoped table carries the same `app_id` column, and every
query that should be scoped has to remember to filter on it. Here's the
column threaded through the schema.

```
  Zoom out — one discriminator column, threaded through every table

  ┌─ buffr Postgres: agents schema ─────────────────────────────────┐
  │  documents   .app_id  text not null default 'laptop'            │
  │  chunks      .app_id  text  ← btree-indexed (chunks_app_id)      │
  │  conversations.app_id text                                      │
  │  profiles    .app_id  text                                      │
  │                                                                 │
  │  isolation enforced by:  WHERE app_id = $n  in app code         │
  │  isolation enforced by:  ✗ NO row-level security policy         │
  └─────────────────────────────────────────────────────────────────┘
```

Zoom in. `app_id` is a discriminator: every tenant's rows live in the same
tables, separated only by this column's value (default `'laptop'`). That's
a perfectly standard multi-tenancy shape — but isolation between tenants is
currently enforced *only* by app code remembering to write `where app_id =
$n`. Postgres row-level security (RLS), the DB-level half that would make
isolation impossible to forget, is **not exercised**. This file describes
what's there and names the gap honestly, then hands the trust call to
`study-security`.

## The structure pass

Axis: **trust — what stops tenant A's query from reading tenant B's
rows?**

```
  axis = "who guarantees a query only sees its own tenant?"

  ┌─ search (chunks) ────────┐  seam  ┌─ loadProfile / messages ─────┐
  │ WHERE app_id = $2        │ ══╪══► │ some queries scope by app_id,│
  │ → scoped, app-enforced   │ flips? │ messages joins via convo only│
  └──────────────────────────┘        └──────────────────────────────┘
        ▲                                       ▲
   the DB itself enforces NOTHING — every row is visible to every
   connection; isolation is a property of the QUERY, not the data
```

- **Layers:** the `app_id` column (data) vs the queries that filter on it
  (app code).
- **The axis (trust/isolation):** the answer to "what stops cross-tenant
  reads?" is the *same* at every layer — "the app code's `where` clause,"
  and nothing below it. There's no seam where the DB takes over
  enforcement, which is precisely the finding.
- **The seam that's *missing*:** with RLS, the trust boundary would flip at
  the DB — a policy would scope every query whether or not the app
  remembered to. Today that seam doesn't exist; the boundary is entirely
  in app code.

## How it works

#### Move 1 — the mental model

You've filtered a list by a user id a hundred times: `items.filter(i =>
i.userId === currentUser)`. `app_id` tenancy is that, pushed into SQL —
`where app_id = $current`. It works exactly as well as a client-side
`.filter`: fine as long as every read remembers to apply it, and a hole
the moment one forgets. RLS is the equivalent of moving that filter into
the data layer so it *can't* be forgotten — and that's the part not built
yet.

```
  the pattern — discriminator column + per-query filter

  every tenant-scoped row:   { app_id: 'laptop', ...data }
                                    │
  every scoped read:         SELECT ... WHERE app_id = $appId
                                    │
  isolation holds IFF:       every read remembers the WHERE
                                    │
  RLS (not built):           CREATE POLICY ... USING (app_id = current_setting(...))
                             → DB enforces it even if the query forgets
```

#### Move 2 — the walkthrough

**The column, with a default.** Every tenant table declares `app_id text
not null default 'laptop'`
(`/Users/rein/Public/buffr/sql/001_agents_schema.sql:5,17,34,54`). The
default `'laptop'` is the single-tenant case — buffr is "a laptop runtime,"
so one tenant is the norm and the column is forward-room for more. It's
`not null`, so a row can never be tenant-less.

**The one indexed tenant filter.** Only `chunks` indexes `app_id`
(`chunks_app_id`, schema line 30) — because it's the only tenant filter on
a hot, high-row-count path. `PgVectorStore.search` applies it on every
query — `/Users/rein/Public/buffr/src/pg-vector-store.ts:70-77`:

```sql
select id, content, chunk_index, document_id, meta,
       1 - (embedding <=> $1::vector) as score
from agents.chunks
where app_id = $2                     -- ← the tenant scope
order by embedding <=> $1::vector
limit $3
```

The `appId` is fixed per `PgVectorStore` instance
(`pg-vector-store.ts:27`, `this.appId = opts.appId ?? 'laptop'`), so a
store object is bound to one tenant at construction. That's the isolation
mechanism: scope the *connection wrapper*, not the data.

**Where scoping is inconsistent — the honest part.** `loadProfile` scopes
by `app_id` (`/Users/rein/Public/buffr/src/profile.ts:5`). But
`agents.messages` has *no* `app_id` column at all — it's reached only
through `conversation_id` (the real FK), and `conversations` carries the
`app_id`. So a message's tenancy is *transitive* — you'd have to join
through `conversations` to scope messages by tenant, and
`SupabaseTraceSink` never does (it only ever inserts, never tenant-filtered
reads — `supabase-trace-sink.ts:27-37`). For an append-only log written by
a tenant-bound session that's fine; it becomes a gap the moment something
*reads* messages across conversations without joining tenant.

**What's not there: RLS.** There is no `alter table … enable row level
security`, no `create policy` anywhere in the schema. **What breaks
because it's missing: a single forgotten `where app_id` — or any
direct-SQL access (psql, a future admin tool, a bug) — sees every tenant's
rows.** At the current scale (one `'laptop'` tenant) the blast radius is
zero. As a multi-tenant claim it's `not yet exercised`, and that's the
honest framing.

#### Move 3 — the principle

A discriminator column gives you multi-tenancy in the data model for
almost free, but it pushes the *enforcement* entirely onto every query
that touches the table — isolation becomes a property of the code, not the
data. That's an acceptable trade while there's effectively one tenant and
all access goes through tenant-bound wrappers. The moment a second tenant
matters, the enforcement has to move into the data layer (RLS), because
"every query remembers the filter" is a guarantee app code cannot actually
make. Knowing *which* half you've built — the column, not the policy — is
the whole point of auditing it.

## Primary diagram

```
  app_id tenancy — what's built vs what's deferred

  ── BUILT: discriminator column + per-query / per-wrapper scope ──────
  documents/chunks/conversations/profiles.app_id  (not null, default 'laptop')
        │
  PgVectorStore(appId)  ──►  every search: WHERE app_id = $appId
  loadProfile(appId)    ──►  WHERE app_id = $1
  messages              ──►  tenancy TRANSITIVE via conversation_id only
        │
  ── NOT YET EXERCISED: DB-enforced isolation ────────────────────────
  ✗ ALTER TABLE ... ENABLE ROW LEVEL SECURITY
  ✗ CREATE POLICY tenant_isolation USING (app_id = current_setting('app.id'))
        │
  consequence: one forgotten WHERE / any direct SQL = cross-tenant read
```

## Elaborate

Three classic multi-tenancy shapes: separate databases, separate schemas,
or a shared schema with a discriminator column. buffr's is the third — the
cheapest to operate, the weakest at isolation. Postgres RLS is the standard
upgrade that keeps the shared-schema cheapness while making isolation
DB-enforced: a policy scopes every query by a session variable, so app code
*can't* leak across tenants even with a buggy `where`. It's deferred here
deliberately — the runtime is single-tenant (`'laptop'`), so the cost of
RLS (policy maintenance, session-variable plumbing, harder ad-hoc queries)
isn't yet bought by any benefit. The trust analysis of this gap — what an
attacker or a bug could actually reach — belongs to `study-security`; this
file owns only the *shape* (column present, policy absent). Read next:
`study-security` for the trust-boundary call, `study-system-design` for the
single-tenant-laptop architecture that makes the deferral reasonable.

## Interview defense

**Q: How do you isolate tenants, and is it safe?**

Shared-schema multi-tenancy: an `app_id` discriminator column on every
tenant table, defaulting to `'laptop'`. Isolation is enforced in app code —
the `PgVectorStore` is bound to one `appId` at construction and adds `where
app_id = $2` to every search; `loadProfile` scopes the same way. It's safe
*at the current single-tenant scale*. It is not safe as a general
multi-tenant guarantee, because there's no row-level security — a single
forgotten `where` or any direct SQL sees every tenant's rows. That's a
deliberate deferral, not an oversight.

```
  built:   app_id column + WHERE app_id = $n  (app-enforced)
  missing: RLS policy                          (DB-enforced)
  ──────────────────────────────────────────────────────────
  isolation today = property of the query, not the data
```

Anchor: *the column is the cheap half of tenancy; RLS is the half that
makes isolation impossible to forget — and it's the half I haven't built.*

**Q: `messages` doesn't even have an `app_id` — bug?**

It's transitive: messages scope through `conversation_id → conversations →
app_id`. Fine for an append-only log written by a tenant-bound session.
It'd need a join (or a denormalized `app_id`) the moment something reads
messages across conversations.

Anchor: *transitive tenancy through a FK is fine for write-only logs,
risky for cross-conversation reads.*

## See also

- `01-dropped-fk-for-drop-in-parity.md` — the FK situation on chunks.
- `06-trace-as-append-only-log.md` — why `messages` gets away with
  transitive tenancy.
- `study-security` — owns the trust-boundary verdict on this gap.
- `audit.md` §4 (integrity), §7 (red-flags capstone).
