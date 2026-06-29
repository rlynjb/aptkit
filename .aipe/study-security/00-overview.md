# Overview — the trust map of aptkit + buffr

One page to orient before the audit. Here's the whole security picture in a single frame, then the verdict: the single worst exposure, ranked first.

## The whole thing, one diagram

```
  aptkit (toolkit) + buffr (runtime) — the trust boundaries

  ┌─ UNTRUSTED ─────────────────────────────────────────────────────┐
  │  Human question string                                          │
  │  Indexed documents (could contain adversarial text)             │
  └──────────────────────────────┬───────────────────────────────────┘
                                 │  no sanitization beyond JSON parse
                                 ▼
  ┌─ SEMI-TRUSTED: the model ────────────────────────────────────────┐
  │  Gemma (local) / Anthropic / OpenAI via ModelProvider.complete() │
  │  decides: which tool, what args, when to stop                    │
  │                                                                   │
  │  CONTROLS that box it:                                            │
  │   filterToolsForPolicy  — sees only allowed tools (01)           │
  │   maxTurns / maxToolCalls — bounded work (02)                    │
  │   minTopK + matchesFilter — bad args can't starve/wipe (03)      │
  │   parseAgentJson         — tolerant, never eval()s output        │
  └──────────────────────────────┬───────────────────────────────────┘
                                 │  tool call → handler
                                 ▼
  ┌─ TRUSTED: storage (lives in buffr) ──────────────────────────────┐
  │  PgVectorStore   — pg `$1..$8` params, `where app_id = $2` (04)  │
  │  SupabaseTraceSink — persists FULL trajectory to agents.messages │
  │  agents schema   — app_id column, NO row-level security          │
  └──────────────────────────────────────────────────────────────────┘
                                 ▲
  ┌─ SECRETS ───────────────────┴────────────────────────────────────┐
  │  .env (both repos, gitignored): ANTHROPIC_API_KEY, OPENAI_API_KEY,│
  │  DATABASE_URL (with password). Never in source, never in bundle. │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ DEV-ONLY side surface: Studio Vite middleware ──────────────────┐
  │  ~14 /api/* routes, no auth (localhost dev server)               │
  │  resolveReplayPath gates file writes to artifacts/replays/ (05)  │
  └──────────────────────────────────────────────────────────────────┘
```

## The verdict — what to worry about, in order

This repo is a young AI toolkit, not a production multi-tenant service. The honest framing: the LLM/agent-security controls are real and deliberate, while the classic web controls (authn, authz, rate limiting, input sanitization) are mostly **not yet exercised** because there's no public HTTP surface that needs them yet. Rank the exposures by what an attacker could actually reach:

1. **app_id tenancy with no RLS — the worst latent exposure.** `agents.chunks` / `conversations` / `messages` / `profiles` all carry an `app_id` column (`buffr/sql/001_agents_schema.sql`), and `PgVectorStore.search` filters `where app_id = $2` (`buffr/src/pg-vector-store.ts:74`). But that filter lives in *application code only*. The database has no row-level security. The day a second tenant shares this Postgres and any query path forgets the `app_id` predicate — or `appId` is ever taken from caller input instead of the trusted config — one tenant reads another's conversations. Today buffr hardcodes `appId: 'laptop'`, so it's latent, not live. **See `04-app-id-tenancy-without-rls.md`.**

2. **Full conversation trajectories persisted as a PII surface.** `SupabaseTraceSink` writes *every* event — user questions, assistant text, tool args, tool results, token counts — into `agents.messages` (`buffr/src/supabase-trace-sink.ts:53-85`). That table is the richest data in the system and has no field-level access control and no redaction. Whatever a user types, and whatever the retrieval surfaces, lands in durable storage. Combined with finding 1, it's the highest-value target.

3. **The model is untrusted input that flows into a prompt unsanitized.** A user question goes straight into `agent.answer(question)` and into the prompt; indexed documents (which the model retrieves and reads) could carry adversarial instructions. There is no prompt-injection defense — the mitigations that *do* exist (tool allowlist, bounded loop) limit the *blast radius* of a hijacked model rather than preventing the hijack. This is `not yet exercised` as a defended threat, and it's the right next thing to build.

The good news, and why this repo reads as security-literate despite the gaps: the controls that *are* here are the right ones for an agent system. Least-privilege tool policy (01), a bounded loop (02), and hallucination-tolerant tool args (03) are exactly the three things that keep a semi-trusted model from becoming a fully-trusted one. Read those three first — they're the load-bearing positives — then the two gaps (04, 05) and the full lens walk in `audit.md`.
