# App-code tenancy without RLS

**Industry name(s):** multi-tenant row isolation · the missing Row-Level
Security (RLS) policy · **Type:** Industry standard (and the repo's #1 trust
gap — a control that *should* exist and doesn't)

## Zoom out, then zoom in

This is the one finding to lead with. buffr's Postgres schema is shaped for
multiple tenants — every row carries an `app_id` — but the isolation between
tenants lives entirely in application code. The trust assumption is *"every
query remembers to filter by `app_id`."* Hold that thought: it's an
assumption enforced by developer discipline, not by the database, and one
forgotten `WHERE` clause leaks another tenant's rows.

```
  Zoom out — where tenancy is (and isn't) enforced

  ┌─ App layer (buffr/src) ────────────────────────────────────┐
  │  every query: where app_id = $2   ← the ONLY enforcement   │ ← we are here
  │  (pg-vector-store.ts, profile.ts, supabase-trace-sink.ts)  │
  └──────────────────────────┬──────────────────────────────────┘
                             │  SQL with app_id as a parameter
  ┌─ Database (Postgres agents schema) ───────────────────────┐
  │  documents · chunks · conversations · profiles · messages │
  │  each row: app_id text not null default 'laptop'           │
  │  ✗ NO Row-Level Security  ✗ NO CREATE POLICY              │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the missing control is **Row-Level Security (RLS)** — a Postgres
feature that filters rows by a policy the *database* enforces on every
query, no matter what the SQL says. The question it answers: *if a query
forgets its `app_id` filter, does another tenant's data leak?* Today: yes.

## Structure pass

**Layers:** app code holds the *intent* (filter by tenant), the database
holds the *data* (all tenants in one table). Isolation is supposed to live
at the seam between them.

**Axis — trust:** trace "who guarantees a query sees only one tenant's
rows?" across the app/DB seam.

```
  The trust gap — no flip where there should be one

  ┌─ app code ─────┐   seam: the query   ┌─ database ──────┐
  │ INTENDS to     │ ═══════════════════► │ enforces        │
  │ filter app_id  │   (no DB check)      │ NOTHING         │
  └────────────────┘                      └─────────────────┘
         ▲                                       ▲
         └──── "who guarantees one tenant?" ─────┘
               app: "I'll remember" · DB: "not my job"

  With RLS, the DB side would flip to "enforces app_id" —
  and the guarantee would survive a forgotten WHERE clause.
```

The lesson is the *absent* flip. A load-bearing security seam should change
the trust answer as you cross it — app *requests*, database *enforces*.
Here both sides say "the app handles it," so the boundary carries no
guarantee.

**Seam:** every `query()` call in `buffr/src`. There is no single choke
point — and that's the problem. Isolation distributed across N query sites
is N chances to forget.

## How it works

#### Move 1 — the mental model

You know the bug where a frontend hides a row with a `.filter()` but the API
still returns every row in the response — the data's right there in the
network tab, the UI just chose not to show it. App-code tenancy is the
server-side version: the *query* chooses to filter by `app_id`, but the
table holds every tenant's rows and would hand them over the moment a query
asks without the filter. The fix moves the filter from "what the query
chooses" to "what the database enforces."

```
  Two models of tenant isolation

  app-code only (today):        with RLS (the fix):
  ┌──────────────┐              ┌──────────────┐
  │ query says   │              │ query says   │
  │ WHERE app_id │              │ (anything)   │
  └──────┬───────┘              └──────┬───────┘
         ▼                             ▼
  ┌──────────────┐              ┌──────────────┐
  │ DB returns   │              │ DB applies   │
  │ what query   │              │ POLICY:      │
  │ asked        │ ← forget the │ app_id=current│ ← can't leak
  │              │   filter →   │ ALWAYS       │   even if query
  │              │   LEAK       │              │   forgets
  └──────────────┘              └──────────────┘
```

#### Move 2 — the step-by-step walkthrough

**Every table carries `app_id`.** The schema declares it on documents,
chunks, conversations, and profiles — `not null default 'laptop'` — and
indexes chunks by it.

```sql
-- buffr/sql/001_agents_schema.sql:6, 19, 30, 34, 54
app_id text not null default 'laptop',                 -- documents (:6)
app_id text not null default 'laptop',                 -- chunks (:19)
create index if not exists chunks_app_id
  on agents.chunks (app_id);                            -- (:30)
app_id text not null default 'laptop',                 -- conversations (:34)
app_id text not null default 'laptop',                 -- profiles (:54)
```

The `app_id` column and its index say the schema *anticipates* multiple
tenants. The index even optimizes the per-tenant query path. Everything is
in place except the enforcement.

**Every query passes `app_id` as a parameter.** The app code is disciplined
— today. The vector search filters by it; so do profile reads and
conversation inserts.

```sql
-- buffr/src/pg-vector-store.ts:70-77 (search)
select id, content, chunk_index, document_id, meta,
       1 - (embedding <=> $1::vector) as score
from agents.chunks
where app_id = $2                                       -- ← the only isolation
order by embedding <=> $1::vector
limit $3
```

```typescript
// buffr/src/profile.ts (read)
'select content from agents.profiles where app_id = $1 order by updated_at desc limit 1'
// buffr/src/supabase-trace-sink.ts:5-6 (insert)
'insert into agents.conversations (app_id, agent_name) values ($1, $2) returning id'
```

Note this *is* parameterized (`$2`), so there's no SQL-injection angle —
`app_id` is bound, not concatenated. The risk isn't injection; it's
*omission*. The isolation is correct everywhere it's written, and absent
everywhere it's forgotten.

**The database enforces nothing.** A grep over `buffr/sql/` for `CREATE
POLICY`, `ENABLE ROW LEVEL SECURITY`, or `row_security` finds nothing — only
the `app_id` columns and the index. So the trust assumption is exactly:
*every current and future query remembers `where app_id = $n`.* The day
someone writes an admin report, a debug query, or a new feature's read path
and forgets the clause, that query returns every tenant's rows. The
database happily complies, because nothing told it not to.

**Concrete consequence.** Add a "recent conversations" feature with `select
* from agents.conversations order by created_at desc limit 20` — no
`app_id`. On a single-`app_id` laptop (`default 'laptop'`) it looks correct
in testing. Deploy it where two `app_id`s share the database and tenant A's
new feature shows tenant B's conversations. No error, no log, no crash —
just a cross-tenant read. That's the failure mode RLS exists to make
impossible.

#### Move 2.5 — current state vs future state

This is built-but-not-hardened, so the Phase A / Phase B split matters.

```
  Phase A (now)                  Phase B (RLS hardened)
  ───────────────────            ───────────────────────────
  app_id column on every table   same columns, unchanged
  every query: WHERE app_id=$n   queries MAY keep the clause
  isolation = app discipline     isolation = DB policy
  forgotten clause → LEAK        forgotten clause → 0 rows (safe)

  what changes: add per-table
    ALTER TABLE ... ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON agents.<t>
      USING (app_id = current_setting('app.current_app_id'));
  and set app.current_app_id once per connection/session.

  what does NOT change: the schema, the app_id columns,
  the existing queries (they keep working — the policy is
  additive, an AND'd filter the DB enforces).
```

The cost of the fix is low because the discriminator already exists —
adding RLS is a migration plus a per-session `SET`, not a reshape. The
takeaway is *what doesn't have to change*: the column, the index, and every
existing query all stay. RLS is the backstop you add under the discipline
you already have.

#### Move 3 — the principle

A tenant discriminator on the row is necessary but not sufficient. Isolation
that lives in app code is a convention; isolation that lives in the database
is a guarantee. The difference is what happens on the query someone forgets
to write correctly — and someone always eventually does. Push the invariant
down to the layer that can enforce it unconditionally, the same reason a
`NOT NULL` constraint beats "we always set that field in code."

## Primary diagram

```
  App-code tenancy without RLS — the full picture

  ┌─ buffr/src (app layer) ────────────────────────────────────┐
  │  pg-vector-store.ts   where app_id = $2   ✓ disciplined     │
  │  profile.ts           where app_id = $1   ✓ disciplined     │
  │  supabase-trace-sink  insert (app_id, ..) ✓ disciplined     │
  │  future_feature.ts    select * from ...   ✗ FORGETS app_id  │
  └──────────────────────────┬──────────────────────────────────┘
                             │ SQL
  ┌─ Postgres (agents schema) ────────────────────────────────┐
  │  documents·chunks·conversations·profiles·messages          │
  │  app_id text not null default 'laptop'                      │
  │  ✗ no ENABLE ROW LEVEL SECURITY  ✗ no CREATE POLICY        │
  │  → returns whatever the query asks → cross-tenant LEAK      │
  └─────────────────────────────────────────────────────────────┘

  FIX: enable RLS + a tenant_isolation policy per table →
       DB filters by app_id unconditionally, leak becomes 0 rows
```

## Elaborate

Row-Level Security is Postgres's per-row authorization: a policy attached to
a table that's AND'd into every query the database runs, transparently.
It's the standard answer to multi-tenant isolation in a shared-table
("pooled") model — the alternative being schema-per-tenant or database-per-
tenant, both heavier. Supabase (buffr's host) leans on RLS heavily; here the
schema is Supabase-backed but the RLS layer Supabase expects simply isn't
written. This connects directly to `study-data-modeling`, which owns the
schema shape — the `app_id` column is a data-modeling decision; whether it's
*enforced* is this guide's. It also pairs with lens 2 (auth): there's no
authn yet to bind a caller to an `app_id`, so RLS and auth are the matched
pair the system needs before it serves a second tenant.

## Interview defense

**Q: You have an `app_id` on every row and every query filters by it. Isn't
that multi-tenant isolation?**

It's isolation by convention, not by guarantee. The database enforces
nothing — it returns whatever the query asks for. So isolation holds exactly
as long as every query, forever, remembers `where app_id = $n`. The first
query that forgets — an admin report, a debug script, a new feature — leaks
across tenants with no error. The fix is Row-Level Security: a policy the
database AND's into every query, so a forgotten clause returns zero rows
instead of everyone's.

```
  app-code filter:  guarantee = developer discipline (fails open)
  RLS policy:        guarantee = the database (fails closed)
```

*Anchor: a discriminator column is necessary but not sufficient — without
RLS, isolation is a convention, and conventions get forgotten.*

**Q: What's the cost of adding RLS here?**

Low, because the discriminator already exists. It's a migration —
`ENABLE ROW LEVEL SECURITY` plus a `tenant_isolation` policy per table — and
setting `app.current_app_id` once per session. The schema, the `app_id`
columns, the index, and every existing query all stay; the policy is
additive, an AND'd filter. You're adding a backstop under discipline you
already practice, not reshaping the data.

*Anchor: RLS is additive here — the column's already there, so it's a
migration plus a per-session SET, not a reshape.*

## See also

- `05-trajectory-persistence-pii.md` — the other buffr exposure; the
  `messages` table this tenancy gap also governs
- `audit.md` lens 2 (auth — no caller is bound to an app_id) and lens 5
- `study-data-modeling` — the `agents` schema and the `app_id` column shape
- `study-system-design` — buffr as the storage body for aptkit
