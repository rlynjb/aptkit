# Overview — the security posture, ranked

One page. The verdict first, then the rank.

**The verdict:** aptkit treats the *model* as the attacker and defends
accordingly — least-privilege tool allowlists, a hard loop budget, a
defensive output parser, a hallucination-tolerant retrieval filter. Those
controls are real and they hold. What it does *not* defend is everything
upstream of authentication and everything around prompt injection: there
is no authn, no authz, no rate limiting, and retrieved/user content flows
into the prompt raw. buffr adds the only persistent storage, and that's
where the two genuine exposures live — tenancy without Row-Level Security,
and full-trajectory persistence to a PII table.

```
  Where the trust controls sit — and where the holes are

  ┌─ DEFENDED (the model is the threat) ───────────────────────┐
  │  ✓ tool allowlist          filterToolsForPolicy            │
  │  ✓ bounded loop            maxTurns / maxToolCalls         │
  │  ✓ defensive parse         parseAgentJson                  │
  │  ✓ filter-arg tolerance    matchesFilter / minTopK         │
  │  ✓ parameterized SQL       $1..$8 everywhere (buffr)       │
  │  ✓ markdown render         react-markdown, no raw HTML     │
  │  ✓ path containment        resolveReplayPath               │
  └─────────────────────────────────────────────────────────────┘

  ┌─ UNDEFENDED / NOT YET EXERCISED ───────────────────────────┐
  │  ✗ tenancy isolation       app_id in code, NO RLS    ← #1  │
  │  ✗ PII minimization        full trajectory persisted ← #2  │
  │  ✗ prompt injection        retrieved/user text raw   ← #3  │
  │  · authentication          none (library + CLI)            │
  │  · authorization           none                            │
  │  · rate limiting           none                            │
  └─────────────────────────────────────────────────────────────┘
```

## The three findings that matter, ranked

**#1 — Cross-tenant isolation is app-code-only; there is no RLS.**
Every row in buffr's `agents` schema carries an `app_id`
(`sql/001_agents_schema.sql:6,19,34,54`), and every query passes it as a
parameter (`where app_id = $2` in `src/pg-vector-store.ts:74`). But the
schema declares no `CREATE POLICY` and no `ENABLE ROW LEVEL SECURITY` — a
grep over `sql/` finds neither. The trust assumption is *"every query
remembers to filter by `app_id`."* One forgotten clause in a future query
returns another tenant's rows, and the database does nothing to stop it.
The deep walk and the fix are in `04-app-code-tenancy-without-rls.md`.

**#2 — The full agent trajectory is persisted to a PII table.**
buffr's trace sink (the `SupabaseTraceSink`, `src/supabase-trace-sink.ts`)
writes *every* event to `agents.messages`: assistant text, the user's
question, tool-call args, tool results and errors, token counts. That's by
design — it makes runs replayable — but `content`, `tool_calls`, and
`tool_results` are unredacted plaintext/JSONB. Anything a user types or a
document contains is now durable. The walk is in
`05-trajectory-persistence-pii.md`.

**#3 — Prompt injection is undefended.**
`renderPromptTemplate` (`packages/prompts/src/types.ts:24`) substitutes
`{var}` placeholders with no escaping; `injectProfile`
(`packages/context/src/profile-injector.ts`) concatenates profile text
with no delimiter; retrieved chunks reach the model as raw tool results.
A document or a user question carrying "ignore previous instructions" has
a clear path into the system prompt. This is the honest `not yet
exercised` of the LLM-security lens — see lens 7 in `audit.md`.

## What's genuinely solid

The model-as-attacker controls are the strength. The rag-query agent gets
a one-tool allowlist (`01`). The loop can't run away — `maxTurns` defaults
to 8 and the last turn strips the tools (`02`). Bad JSON from a weak local
model is parsed defensively (`03`). A hallucinated filter arg can't wipe
the result set (`03`). buffr's SQL is fully parameterized. Studio renders
docs through react-markdown (no raw-HTML XSS sink) and contains replay
paths under `artifacts/replays/`.

Read `audit.md` next for the full lens-by-lens walk.
