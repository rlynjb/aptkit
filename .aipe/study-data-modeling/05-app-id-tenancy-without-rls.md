# 05 — The discriminator column for tenancy, without RLS

**Industry name(s):** discriminator-column multi-tenancy / shared-schema
tenant key (a.k.a. tenant discriminator, `tenant_id` partition). **Type:**
Industry standard.

Every table carries `app_id text not null default 'laptop'`, and every query
filters `where app_id = $1`. It's a real tenancy model — but isolation is
enforced **only by the application remembering to add the filter**, with no
row-level security and no composite key tying rows to a tenant.

## Zoom out, then zoom in

`app_id` runs through all five tables and through every read path. It's the
column that says "whose data is this."

```
  Zoom out — where app_id lives

  ┌─ buffr query layer ────────────────────────────────────────┐
  │  search:   where app_id = $2   (pg-vector-store.ts:74)     │ ← we are here
  │  profile:  where app_id = $1   (profile.ts:6)              │
  │  insert:   app_id from cfg.appId / default 'laptop'        │
  └───────────────────────────────┬─────────────────────────────┘
                                  │
  ┌─ agents schema ────────────────▼────────────────────────────┐
  │  documents.app_id   chunks.app_id   conversations.app_id     │
  │  profiles.app_id    (+ index on chunks.app_id)               │
  │  every row tagged; NO row-level security policy              │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the simplest multi-tenant model is one shared schema with a tenant
column on every row — cheap, no per-tenant tables, no connection juggling.
This is that. The question it answers: *how do you keep one app's documents,
memory, and conversations separate from another's in a single Postgres
schema?* You tag every row with `app_id` and filter on it. The honest caveat
— the focus of this file — is *what enforces the filter*: here, nothing but
the application code.

## Structure pass

```
  One axis — "what stops app A reading app B's rows?" — across layers

  ┌─ application (buffr) ─────────────┐
  │  query includes where app_id=$    │   → THE APP. If it forgets the
  └───────────────────────────────────┘      clause, isolation is gone.
              │  the seam ═══════════════  ◄── trust boundary SHOULD flip here
              ▼
  ┌─ database (Postgres) ─────────────┐
  │  app_id column, index, default    │   → NOTHING. No RLS policy, no
  └───────────────────────────────────┘      composite PK on (app_id, id).
              │
              ▼
  ┌─ row ─────────────────────────────┐
  │  app_id = 'laptop' (the default)  │   → all rows default to ONE tenant.
  └───────────────────────────────────┘
```

- **Layers:** application → database → row.
- **Axis = "what enforces tenant isolation?"** At the application layer, the
  `where app_id` clause does. At the database layer — **nothing**. There's
  no row-level security policy and no composite key.
- **The seam that *should* exist but doesn't.** Tenancy is a trust boundary;
  ideally the *database* enforces it (RLS), so a forgotten `where` clause
  can't leak across tenants. Here the boundary is enforced entirely above
  the database, which means a single missing filter is a cross-tenant data
  leak. That gap is the finding — and the cross-link to study-security.

## How it works

#### Move 1 — the mental model

You've written this exact pattern in any multi-user app: a `posts` table
with a `user_id` column, and every query is `where user_id = currentUser`.
Forget the clause in one query and you've shipped a data leak. The fix at
scale is to stop trusting yourself to remember — push the filter into the
database (row-level security) so it's applied automatically. This schema is
at the "remember the clause" stage, not the "database enforces it" stage.

```
  The pattern — tenant tag on every row, filter in every query

  insert: app_id = cfg.appId (default 'laptop')
              │
              ▼
  ┌─ agents.chunks ──────────────────────────────┐
  │ id      app_id   embedding   ...              │
  │ c1#0    laptop   [...]                        │
  │ c2#0    tenantB  [...]   ← different tenant   │
  └───────────────────────────────────────────────┘
              │ read MUST add: where app_id = $
              ▼
  forget the clause → both tenants' rows returned (LEAK)
```

#### Move 2 — the step-by-step walkthrough

**Step 1 — every table carries the tenant column with a default.**

```sql
-- buffr/sql/001_agents_schema.sql (documents :6, chunks :16, conversations :34, profiles :54)
app_id text not null default 'laptop',
```

`not null` means a row always belongs to *some* tenant; the `'laptop'`
default means single-tenant use needs no explicit `app_id` anywhere. That
default is the tell that this is a laptop runtime — one tenant, named
`laptop`, by convention.

**Step 2 — the index supports the filter.** `chunks` (the hot table) gets a
B-tree index on `app_id`.

```sql
-- buffr/sql/001_agents_schema.sql:30
create index if not exists chunks_app_id on agents.chunks (app_id);
```

So `where app_id = $2` on the retrieval path uses an index. Note the
*query* combines `where app_id = $2` with `order by embedding <=> $1` — the
`app_id` B-tree and the `embedding` HNSW index serve two parts of the same
query; Postgres picks one to drive. For a small per-tenant corpus this is
fine. (Whether HNSW + a tenant filter compose efficiently at scale is a
study-database-systems question.)

**Step 3 — the application injects `app_id` on read.** The store holds a
single `appId` and stamps it into every query.

```ts
// buffr/src/pg-vector-store.ts:67-78
async search(vector: number[], k: number): Promise<Hit[]> {
  this.assertDim(vector);
  const { rows } = await this.pool.query(
    `select id, content, ..., 1 - (embedding <=> $1::vector) as score
     from agents.chunks
     where app_id = $2                          -- ← the isolation, in app code
     order by embedding <=> $1::vector limit $3`,
    [toVectorLiteral(vector), this.appId, k],
  );
  ...
}
```

```ts
// buffr/src/profile.ts:5-7
const { rows } = await pool.query(
  'select content from agents.profiles where app_id = $1 order by updated_at desc limit 1', [appId]);
```

Every read path includes the clause — currently. The risk is structural, not
present: there is no mechanism that *forces* a new query to include it. Add a
table and a query tomorrow, forget `where app_id`, and the isolation is
silently gone for that path.

**Step 4 — what's missing that would make it safe.** Two things a
multi-tenant-hardened schema would have, and this one doesn't:

- **Row-level security.** `alter table agents.chunks enable row level
  security` + a policy `using (app_id = current_setting('app.tenant'))`.
  Then the database applies the filter automatically; a forgotten `where`
  clause can't leak. Not present — `not yet exercised`.
- **Composite key / FK including `app_id`.** The PK is `id` alone, not
  `(app_id, id)`. The soft link `chunk.document_id → document.id` doesn't
  carry `app_id`, so nothing structurally prevents a chunk in tenant A from
  referencing a document in tenant B. (The dropped FK,
  `01-soft-fk-for-drop-in-parity.md`, means even that cross-tenant link is
  unchecked.)

```
  Layers-and-hops — where isolation is (and isn't) enforced

  ┌─ app A ────┐ search(vec)            ┌─ app B ────┐
  │ appId=lap  │ ──┐                ┌── │ appId=tB   │
  └────────────┘   │                │   └────────────┘
                   ▼                ▼
        ┌─ PgVectorStore ──────────────────────┐
        │ where app_id = this.appId  ← app code │  ← isolation lives HERE
        └───────────────┬───────────────────────┘
        ┌─ Postgres ────▼───────────────────────┐
        │ NO RLS policy → DB returns ANY app_id  │  ← NOT enforced here
        │ if the clause is ever omitted          │
        └────────────────────────────────────────┘
```

#### Move 2 variant — the load-bearing skeleton

Kernel of "discriminator-column tenancy": **a `tenant_id` (here `app_id`) on
every row + every query filtered by it.** That's the whole pattern. The
*hardening* the repo omits: **RLS so the database enforces the filter**, and
**composite keys so cross-tenant references are structurally impossible.**

- **Drop the column** and you have no tenancy at all — one shared pool of
  everyone's data.
- **Drop the filter in any one query** and that path leaks across tenants.
  Nothing catches it.
- **Drop RLS** (the current state) and isolation is exactly as good as the
  application's discipline — fine for one tenant, fragile for many.

For a single-tenant laptop runtime (`default 'laptop'`), the skeleton alone
is correct and the hardening is genuinely unnecessary. The pattern file
exists to name what flips the moment a second tenant appears.

#### Move 3 — the principle

A tenant discriminator column is the right *first* multi-tenancy model — it's
cheap and it scales to a surprising number of tenants. But a discriminator is
only a tenancy *model*, not a tenancy *guarantee*. The guarantee comes from
who enforces the filter: application code (one forgotten clause from a leak)
or the database (RLS, leak-proof by construction). Know which you have. This
repo has the model without the guarantee — correct for one tenant, a
known-and-named gap before many.

## Primary diagram

```
  app_id tenancy — the model, and the missing guarantee

  ┌─ every agents.* table ─────────────────────────────────────┐
  │  app_id text not null default 'laptop'   ← the discriminator│
  │  index chunks_app_id                     ← supports filter  │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ read
  ┌─ application enforces ─────────▼────────────────────────────┐
  │  where app_id = $   in EVERY query (by discipline)          │
  └─────────────────────────────────────────────────────────────┘
  MISSING (not yet exercised):
    · row-level security  → DB enforces the filter automatically
    · composite key (app_id, id) → cross-tenant refs impossible
  VERDICT: correct for one tenant ('laptop'); fragile for many.
```

## Elaborate

Shared-schema-with-tenant-column is the most common SaaS multi-tenancy model
— it's what you reach for before schema-per-tenant or database-per-tenant
(which trade isolation for operational cost). Postgres specifically supports
hardening it with row-level security: a policy that pins every query to
`current_setting('app.tenant_id')`, so the database refuses to return another
tenant's rows even if the application forgets the `where` clause. That's the
standard fix for the exact gap this schema has.

The repo is honest about being a laptop runtime — `default 'laptop'` says so
in the schema. The tenancy column is there as a *seam for later*: the data
is already tagged, so adding RLS is a migration, not a re-model. That's the
right sequencing — tag now, enforce when a second tenant arrives. The
security consequence (a forgotten filter = cross-tenant leak) is walked in
study-security; this file is the data-model shape. Read next:
`01-soft-fk-for-drop-in-parity.md` (the soft link also ignores `app_id`).

## Interview defense

**Q: You use `app_id` on every table for tenancy but have no row-level
security. Isn't that a data-leak waiting to happen?**

> Verdict: for the current single-tenant laptop runtime, no — there's one
> tenant, `'laptop'`, the column default. As a *multi-tenant* design, yes,
> it's the known gap: isolation is enforced only by every query including
> `where app_id = $`, in application code. One forgotten clause leaks across
> tenants. The data is already tagged, so the fix is additive — enable RLS
> with a policy pinning queries to the current tenant, which moves
> enforcement into the database where a missing clause can't bypass it. I
> sequenced it deliberately: tag the rows now, enforce when a second tenant
> exists.

```
  where app_id=$ in app code   ← isolation today (discipline-enforced)
        │ forget it once
        ▼
  cross-tenant leak             ← what RLS would make impossible
```

Anchor: *a discriminator column is a tenancy model, not a tenancy guarantee
— the guarantee is RLS.*

**Q: Why is the primary key `id` and not `(app_id, id)`?**

> Because the in-memory `VectorStore` keyspace is just `id` — chunk ids like
> `doc-7#0` are globally unique by construction, so the durable store mirrors
> that with `id` as the PK to keep drop-in parity. The cost is that nothing
> structurally ties a row to its tenant in the key, and the soft `document_id`
> link doesn't carry `app_id` either, so a cross-tenant reference isn't
> prevented by the schema. With real multi-tenancy I'd move to `(app_id, id)`
> and carry `app_id` through the link.

Anchor: *the single-column PK mirrors the contract's keyspace; multi-tenancy
would push `app_id` into the key.*

## See also

- `01-soft-fk-for-drop-in-parity.md` — the soft link ignores `app_id`, so
  cross-tenant references aren't structurally blocked.
- `03-kind-tag-shared-collection.md` — `meta.kind` is a second logical
  partition layered on top of `app_id`.
- `audit.md` lenses 3, 7 — the `app_id` index and the no-RLS red flag.
- **study-security** — `app_id` as a trust boundary; the forgotten-filter
  leak.
