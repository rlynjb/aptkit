# Study — Security (aptkit + buffr)

The trust axis, made into an audit. One question runs through every file
here: **what can an attacker reach, and what happens when they do?** Not
"is this secure" — that word is banned. Trace the boundary, name the trust
assumption, say what breaks if it's wrong.

This guide spans two repos because the threat surface does. `aptkit`
(`/Users/rein/Public/aptkit`) is the deployment-agnostic library — the
agent loop, the tool policies, the retrieval pipeline. `buffr`
(`/Users/rein/Public/buffr`) is the laptop body that binds aptkit to a
real Postgres and persists trajectories. The interesting controls live in
aptkit; the interesting *exposures* live in buffr.

## Trace the trust axis

```
  The trust axis across the system — who can reach what

  ┌─ UNTRUSTED ────────────────────────────────────────────────┐
  │  the model's output         user question / retrieved docs  │
  │  (tool calls, JSON, text)   (flow into the prompt)          │
  └───────────┬──────────────────────────┬──────────────────────┘
              │ gated by                  │ NOT gated
              ▼                           ▼
  ┌─ TRUSTED (aptkit) ─────────────────────────────────────────┐
  │  tool allowlist (filterToolsForPolicy)   ← lens 7, 01       │
  │  bounded loop (maxTurns/maxToolCalls)     ← lens 7, 02       │
  │  defensive parse (parseAgentJson)         ← lens 3, 03       │
  │  hallucination-tolerant filter            ← lens 3, 03       │
  └───────────────────────┬─────────────────────────────────────┘
                          │ app_id passed in code (no RLS)
                          ▼
  ┌─ STORAGE (buffr) ──────────────────────────────────────────┐
  │  parameterized SQL ($1)        ← lens 3 (safe)              │
  │  app_id tenancy, NO RLS        ← lens 2/5, 04 (real risk)   │
  │  agents.messages = full PII    ← lens 5, 05 (real risk)     │
  └─────────────────────────────────────────────────────────────┘
```

The model output is hostile-by-default and aptkit gates it three ways
(allowlist, loop bound, defensive parse). The retrieved/user content that
flows *into* the prompt is not gated at all — prompt injection is
undefended. And once a run finishes, buffr writes the entire trajectory to
a Postgres table whose tenant isolation is enforced in app code, not by
the database.

## Map of the guide

```
  README.md                          ← you are here
  00-overview.md                     ← one-page orientation, ranked
  audit.md                           ← Pass 1: the 8-lens walk

  01-least-privilege-tool-policy.md  ← Pass 2: the controls that hold
  02-bounded-agent-loop.md
  03-hallucination-tolerant-retrieval.md
  04-app-code-tenancy-without-rls.md ← the exposures worth a deep walk
  05-trajectory-persistence-pii.md
```

## Reading order

1. `00-overview.md` — the ranked verdict. What's worst, what holds.
2. `audit.md` — every lens checked, `not yet exercised` named honestly.
3. The pattern files in number order. `01`–`03` are controls the repo
   gets right; `04`–`05` are the two exposures that matter most.

## Cross-links to neighbouring guides

- **`study-data-modeling`** — the `agents` schema shape, the `app_id`
  column, and why Row-Level Security (RLS) is the data-modeling fix for
  the tenancy gap walked in `04`.
- **`study-agent-architecture`** — the bounded loop (`02`) and the
  tool-policy seam (`01`) as *architecture*; here they're read as *trust
  controls*.
- **`study-system-design`** — the provider/retrieval seams as boundaries;
  here the same seams are read for what crosses them untrusted.
- **`study-ai-engineering`** — the RAG pipeline and agentic retrieval;
  here `03` reads its defensive edges.

## A note on secrets

Cloud provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `NPM_TOKEN`)
and buffr's `DATABASE_URL` live in `.env` files that are gitignored in
both repos (`.gitignore:4` in aptkit, `.gitignore:2` in buffr). This guide
describes the secret *surface* — where keys are read, what they protect —
and never reproduces a key, token, or connection string. The local-default
path (Gemma over Ollama) makes no cloud call and needs no key at all.
