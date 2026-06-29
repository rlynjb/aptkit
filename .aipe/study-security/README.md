# Study — Security (aptkit + buffr)

The one question this guide answers: **what can an attacker reach, and what happens when they do?**

This is an audit-style guide. It traces the *trust axis* across every boundary in the aptkit toolkit and its buffr runtime — where untrusted input enters, who's allowed past, what's hidden vs exposed, and what the dependencies drag in. The interesting surface here isn't a login form (there isn't one yet). It's **the model**: an LLM that decides which tools to call, emits arguments that flow into a vector search, and produces output that gets persisted. The model is an untrusted input source sitting *inside* your trust boundary, and most of the real controls in this repo are about keeping it boxed.

## The trust axis, traced top to bottom

```
  Where untrusted input enters, and what boxes it

  ┌─ Untrusted: the human ──────────────────────────────────┐
  │  question string → agent.answer(question)               │
  └───────────────────────────┬─────────────────────────────┘
                              │ flows into a prompt (no sanitize)
  ┌─ Semi-trusted: the MODEL ─▼─────────────────────────────┐
  │  decides tool calls + emits tool ARGS                   │
  │  ── boxed by ──                                          │
  │    · filterToolsForPolicy  (can only call allowed tools)│  ← 01
  │    · maxTurns / maxToolCalls (can't loop forever)       │  ← 02
  │    · minTopK / matchesFilter (bad args can't wipe results)│ ← 03
  └───────────────────────────┬─────────────────────────────┘
                              │ tool call → parameterized SQL
  ┌─ Trusted: the store (buffr) ▼───────────────────────────┐
  │  PgVectorStore: pg `$1` params, `where app_id = $2`     │  ← 04 (no RLS)
  │  SupabaseTraceSink: full trajectory → agents.messages   │     (PII surface)
  └─────────────────────────────────────────────────────────┘

  Side surface — Studio dev server (Vite middleware):
    POST /api/replays/promote { path } → resolveReplayPath  ← 05 (traversal gate)
```

## Reading order

1. **`00-overview.md`** — one-page orientation: the trust map, where the boundaries are, the single worst exposure ranked first.
2. **`audit.md`** — Pass 1. The 8-lens security walk, every lens grounded or honestly marked `not yet exercised`. Start here for the full picture.
3. **Pattern files** — Pass 2. The five controls/gaps this repo actually exercises, each a deep walk:
   - `01-tool-policy-least-privilege.md` — the per-agent allowlist that caps what the model can call.
   - `02-bounded-agent-loop.md` — `maxTurns` / `maxToolCalls` as the runaway-model brake.
   - `03-hallucination-tolerant-tool-args.md` — `minTopK` + `matchesFilter` defending against a weak model's bad arguments.
   - `04-app-id-tenancy-without-rls.md` — the named gap: cross-tenant isolation enforced in app code, not the database.
   - `05-path-traversal-containment.md` — `resolveReplayPath`, the one input-sanitization seam in the repo.

## Cross-links to neighboring guides

- **`study-data-modeling`** — the `agents` schema shape, and the RLS question from the data-integrity side (this guide covers RLS as a *trust* gap; data-modeling covers it as a *constraint* gap).
- **`study-system-design`** — the provider-neutral and retrieval-neutral seams these controls sit behind.
- **`study-agent-architecture`** — the bounded agent loop and tool registry as architecture (this guide covers them as *safety* mechanisms).
- **`study-ai-engineering`** — RAG grounding and the eval/replay backbone; prompt-injection defense ties back here.

One rule honored throughout: **no real secret values appear anywhere in this guide.** The `.env` files in both repos hold live provider keys and a Postgres connection string with a password. This guide describes the *surface* — where secrets live and how they're handled — never a single value.
