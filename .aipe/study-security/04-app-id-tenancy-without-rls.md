# app_id tenancy without RLS

*Application-enforced multi-tenancy (the missing-RLS gap) · Industry standard pattern, deliberately incomplete here*

## Zoom out, then zoom in

Here's the storage layer in buffr, the part aptkit deliberately doesn't ship. Every row in the `agents` schema carries an `app_id`. The question this concept answers: **when two tenants share this database, what actually stops one from reading the other's rows?**

```
  Zoom out — where tenant isolation is (and isn't) enforced

  ┌─ Capability layer (aptkit) ─────────────────────────────┐
  │  RagQueryAgent — no notion of tenant                    │
  └───────────────────────────┬─────────────────────────────┘
  ┌─ Store binding (buffr) ───▼─────────────────────────────┐
  │  PgVectorStore({ appId })                               │ ← isolation
  │    search:  where app_id = $2   ◄── enforced HERE, in   │   lives here
  │             ▲                        APP CODE only       │   (the risk)
  └─────────────┼────────────────────────────────────────────┘
  ┌─ Postgres ──┼───────────────────────────────────────────┐
  │  agents.chunks / conversations / messages / profiles    │
  │    app_id text column + index — NO row-level security   │ ← NOT here
  └──────────────────────────────────────────────────────────┘
```

Zoom in: this is **multi-tenant data isolation**, and the pattern is half-built. The shape you know: every row tagged with a tenant key, every query scoped to the current tenant. You've done this — a `user_id` column, a `WHERE user_id = ?` on every read. The gap that makes it a *security* topic: that `WHERE` lives only in application code. The database itself will happily return any tenant's rows to any query that forgets the predicate. There's no row-level security (RLS) backstop. Today it's latent because buffr runs single-tenant; the day a second `app_id` shares the instance, the isolation is one missing `WHERE` clause from a cross-tenant leak.

## The structure pass

Layers: **agent (tenant-blind) → store binding (tenant-aware) → Postgres (tenant-blind)**. Trace one axis — **trust** ("can this layer see another tenant's rows?") — down the stack.

```
  axis traced = "what stops a cross-tenant read?"

  ┌─ store binding ─┐   seam    ┌─ Postgres ──────────┐
  │ where app_id=$2 │ ════╪════►│ no policy at all     │
  │ (app code)      │ (NOTHING  │ a query w/o the      │
  │                 │  flips —  │ predicate sees ALL   │
  │                 │  the gap) │ rows                 │
  └─────────────────┘           └──────────────────────┘
         ▲                                 ▲
         └──── same axis, same answer? ─────┘
           → isolation should flip here but DOESN'T.
             The DB enforces nothing; app code is the
             only guard. That non-flip IS the finding.
```

In a properly isolated design, the trust answer flips at the database: even a query that forgets the predicate gets only the current tenant's rows, because RLS rewrites it. Here the answer *doesn't* flip — Postgres enforces nothing — so the only thing between tenants is the discipline of every query author. A seam where an axis *should* flip but doesn't is exactly where the surprise lives.

## How it works

#### Move 1 — the mental model

The shape is a **tenant key on every row, scoped by a predicate the application must remember to add.** Picture it as a shared table with a `tenant` column and an honor system: every query is *supposed* to say `WHERE tenant = me`, but nothing forces it.

```
  Pattern — application-enforced tenancy (no DB backstop)

  agents.chunks
  ┌──────────┬────────┬─────────────────────────┐
  │ id       │ app_id │ content                 │
  ├──────────┼────────┼─────────────────────────┤
  │ doc#0    │ laptop │ ...tenant A's data...    │
  │ doc#1    │ acme   │ ...tenant B's data...    │  ◄── same table
  └──────────┴────────┴─────────────────────────┘
       read with WHERE app_id='laptop'  → A's rows  ✓
       read WITHOUT the predicate        → EVERYONE's rows  ✗
                                            (no RLS to stop it)
```

#### Move 2 — the step-by-step walkthrough

**Step 1 — the tenant key exists on every table.** From `buffr/sql/001_agents_schema.sql` — `documents` (line 6), `chunks` (line 19), `conversations` (line 34), and `profiles` (line 54) all declare:

```sql
app_id text not null default 'laptop',
```

There's an index for it on chunks (line 30, `chunks_app_id`). So the *data* is correctly partitioned by tenant — every row knows whose it is. The schema half of the pattern is done right.

**Step 2 — the predicate lives in app code, and only there.** `PgVectorStore` takes an `appId` in its constructor (`buffr/src/pg-vector-store.ts:25-29`, defaulting to `'laptop'`) and adds it to every read and write. The search query (lines 70-77):

```ts
const { rows } = await this.pool.query(
  `select id, content, ..., 1 - (embedding <=> $1::vector) as score
   from agents.chunks
   where app_id = $2                       -- the ONLY isolation
   order by embedding <=> $1::vector
   limit $3`,
  [toVectorLiteral(vector), this.appId, k]);
```

`upsert` stamps `this.appId` into every inserted row (line 55). Note the good part: `appId` comes from *trusted config* (`loadConfig` reads `AGENT_APP_ID` from env, `buffr/src/config.ts:13`), not from caller input. So the predicate value isn't attacker-controlled. The risk isn't injection of the `app_id`; it's *omission* of the predicate.

**Step 3 — what breaks: a forgotten predicate, and there's no net.** Trace it concretely. Suppose a future query path — a new analytics read, a debugging tool, an ORM that defaults to "select all" — runs:

```sql
select content from agents.messages where conversation_id = $1
```

There's no `app_id` predicate. With RLS, Postgres would silently constrain that to the session's tenant. Without RLS (the current state — the schema has zero `create policy` / `enable row level security` statements), Postgres returns the row regardless of which tenant owns it. One forgotten `WHERE` on one query path leaks another tenant's conversation. The `messages` table is the worst place for this to happen — it holds the full trajectory (see `audit.md` lens 5).

```
  Layers-and-hops — the leak path that has no backstop

  ┌─ App code ───┐ hop 1: query missing `where app_id`   ┌─ Postgres ──┐
  │ new read     │ ─────────────────────────────────────►│ no RLS      │
  │ path         │                                        │ returns ALL │
  └──────────────┘ hop 2: rows from EVERY tenant ◄────────│ matching    │
                          (cross-tenant leak)             │ rows        │
                                                          └─────────────┘
       with RLS, hop 2 would be auto-scoped — that net is absent
```

#### Move 2.5 — current state vs future state

This is built-but-single-tenant, so the Phase A / Phase B framing is the point.

```
  Phase A (now)                    Phase B (multi-tenant target)
  ─────────────────────            ──────────────────────────────
  app_id hardcoded 'laptop'        many app_ids share the instance
  one user, one laptop CLI         a forgotten predicate = real leak
  app-code WHERE is sufficient     app-code WHERE is NOT sufficient
  RLS absent (acceptable)          RLS REQUIRED as the backstop

  What does NOT have to change: the schema (app_id already on every
  row) and PgVectorStore (already passes app_id). RLS is additive —
  `alter table ... enable row level security` + a policy per table
  keyed on a session GUC (e.g. current_setting('app.app_id')).
  The app-code predicate stays as defense in depth.
```

The cost of the fix is small *because* Phase A did the schema right. That's the constructive read: the tenant key is already everywhere, so adding RLS is a migration, not a redesign.

#### Move 3 — the principle

Multi-tenant isolation needs a backstop *below* the layer that writes queries, because the query-writing layer is exactly where humans forget. "Every query is scoped by the application" is a true statement that decays the moment someone adds a query and forgets — and you only find out when a tenant sees another's data. Row-level security moves the guarantee into the database, where omission fails closed instead of open. The pattern here is correct in its data shape and incomplete in its enforcement; naming *which half is missing* is the whole lesson.

## Primary diagram

```
  app_id tenancy without RLS — full picture

  ┌─ buffr store binding ───────────────────────────────────────┐
  │  PgVectorStore({ appId: from trusted config })              │
  │    every read/write carries  where app_id = $N              │
  │    ← isolation enforced HERE, in app code, by convention    │
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ Postgres: agents schema ─▼───────────────────────────────────┐
  │  documents / chunks / conversations / messages / profiles     │
  │    app_id text column on every table  ✓ (data partitioned)    │
  │    NO `enable row level security`, NO `create policy`  ✗       │
  │                                                               │
  │  consequence: a query that omits `where app_id` returns       │
  │  EVERY tenant's rows. Nothing fails closed.                   │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

Application-enforced tenancy is the default starting point for almost every SaaS schema, and RLS (or its equivalent: a tenant-scoped DB role, a query-rewriting middleware, separate schemas per tenant) is the standard hardening once more than one tenant is real. Postgres RLS is the cleanest fit here because the tenant key already exists — you enable it per table and write a policy comparing `app_id` to a session variable set at connection time. The contrast worth holding: this is the *inverse* of the tool-policy win in `01`. There, authorization is enforced at the resource (the registry refuses off-list tools). Here, authorization is enforced only at the caller, and the resource (Postgres) enforces nothing — which is the gap. See `study-data-modeling` for the schema from the integrity side, and `audit.md` lens 2 (authorization) and lens 5 (the `messages` PII surface this would protect).

## Interview defense

**Q: You tag every row with `app_id` and scope every query to it. Is your multi-tenant data isolated?**
Not durably. The `app_id` is on every row and `PgVectorStore` adds `where app_id = $2` to every query — but that predicate lives only in application code. Postgres has no row-level security, so any query path that forgets the predicate returns every tenant's rows. It's safe today only because buffr runs single-tenant with a hardcoded `app_id`.

```
   row has app_id  ✓        query says WHERE app_id  ✓ (by convention)
   DB enforces it           ✗  → one forgotten WHERE = cross-tenant leak
```
*Anchor: isolation enforced at the caller fails open; enforced at the database (RLS) fails closed.*

**Q: What's the fix and what does it cost?** Enable RLS per table and write a policy keyed on a session variable (`current_setting('app.app_id')`), set at connection time; keep the app-code predicate as defense in depth. It's cheap precisely because the schema already carries `app_id` on every row — it's an additive migration, not a redesign. The part people miss is that the app-code `WHERE` is necessary but not *sufficient*; the backstop has to live below the layer that writes queries.

## See also

- `01-tool-policy-least-privilege.md` — authz enforced *at the resource* (the contrast: this is the gap, that's the win).
- `audit.md` lens 2 (authorization) and lens 5 (the trajectory PII this RLS would protect).
- `study-data-modeling` — the `agents` schema from the constraint/integrity angle.
