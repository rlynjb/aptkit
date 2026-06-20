# Study — Security (AptKit)

The trust axis, made into an audit. Every input is hostile until proven
otherwise; every boundary either enforces a trust decision or leaks one.
This guide traces that axis across the boundaries that actually exist in
AptKit — the model boundary (now in two flavors: keyed cloud and no-auth
local Gemma), the publish boundary, and the server-side key boundary — and is
blunt about the lenses that don't yet apply.

## The honest threat model first

AptKit is a **library plus a local dev tool**, not a deployed multi-user
service. There is no login, no tenant, no public endpoint, no database. If
you reach for "auth," "CSRF," "row-level access control," you are reaching
for controls this repo has no surface for. Naming them as findings would be
theater.

The real trust boundary is small and worth stating exactly:

```
  The AptKit trust boundary — who can reach what

  ┌─ developer's machine (TRUSTED) ─────────────────────────────┐
  │                                                             │
  │  .env (API keys)   Studio Vite server (Node process)        │
  │       │                    │                                │
  │       │ process.env        │ middleware: /api/* replay      │
  │       ▼                    ▼                                │
  │  provider adapters ──► model provider (UNTRUSTED OUTPUT)    │
  │   keyed cloud (TLS)  +  Gemma/Ollama (local, no key/TLS)    │
  │                            │  tool calls PARSED from prose   │
  │                            ▼                                │
  │  browser tab (localhost) ◄─ NDJSON trace (NO keys)          │
  └─────────────────────────────────────────────────────────────┘
       ▲                                          ▲
       │ git push / npm publish                   │
       ▼                                          │
  committed artifacts + fixtures ───────────────► public npm tarball
       (DATA-EXPOSURE SURFACE — the one that bites)
```

Three things cross a trust line and earn the whole audit:

1. **Model output** comes back from the provider and flows into the agent's
   own logic. The model is the untrusted party inside the loop. With the local
   Gemma provider this gets sharper: tool calls are *parsed from the model's
   prose* (no native tool-calling), so the model controls dispatch directly.
2. **API keys** live on the developer's machine and must stay server-side —
   never in the browser bundle, never in a committed artifact. (The local
   Gemma/Ollama path carries no key, but trades that for an unauthenticated,
   plaintext local transport.)
3. **Committed artifacts and fixtures** get pushed to GitHub *and* inlined
   into a public npm tarball. Anything that leaks into them is published to
   the world — now including the `provider-gemma`, `retrieval`, and
   `agent-rag-query` packages and their fixtures.

## Reading order

1. `00-overview.md` — the one-page orientation: the boundary, the controls
   that guard it, what's out of scope and why.
2. `audit.md` — Pass 1. The 8-lens security audit, every lens walked,
   `not yet exercised` named honestly where it applies.
3. `01-tool-policy-enforcement-by-omission.md` — least-privilege tool grants
   enforced by never showing the model tools outside its allowlist. The
   single most important LLM-security control here, and its sharp edge.
4. `02-secret-scan-guard.md` — the regex tripwire over every artifact, the
   defense against the data-exposure surface above.
5. `03-server-side-key-boundary.md` — how the Studio server keeps keys in
   `process.env` and out of the browser, plus the replay path-traversal guard.
6. `04-validated-model-output-gate.md` — parse → validate → retry, so
   malformed or injected model output never reaches a sink as trusted data.
7. `05-local-model-tool-call-trust-boundary.md` — the Gemma provider: tool
   calls parsed from prose over a no-auth, no-TLS local transport. The two new
   seams the cloud providers didn't have, and why removing the key didn't
   remove the trust decision.

## Top findings, ranked by real risk for THIS threat model

1. **Data-exposure via committed/published artifacts** — artifacts and
   fixtures are git-committed and inlined into the npm tarball. The
   `findSecretLikeString` guard is the only thing standing between a stray
   key and the public registry, and it's a narrow regex. See
   `02-secret-scan-guard.md`.
2. **Tool-policy is enforced by omission, not by a second gate** — the
   registry's `callTool` checks only that a tool is *registered*, not that
   it's in the calling agent's allowlist. The allowlist lives entirely at
   the schema-filtering layer. The Gemma path makes this seam more reachable:
   the model emits the tool name directly as a parsed JSON string, so only the
   registry's contents stop an off-policy name. See
   `01-tool-policy-enforcement-by-omission.md` and
   `05-local-model-tool-call-trust-boundary.md`.
3. **Gemma's no-auth local transport + prose-parsed tool calls** — the local
   provider POSTs to `http://localhost:11434` with no key and no TLS, and
   reconstructs tool calls by parsing the model's free text. Safe on a single
   laptop; an unauthenticated network service the moment `host` is
   off-loopback. Two trust seams the cloud providers never had. See
   `05-local-model-tool-call-trust-boundary.md`.
4. **`rubric-improvement` holds the widest grant** — it's the only agent
   whose allowlist includes a mutating tool (`save_judgment`). Every other
   agent is read-only. See `audit.md` → LLM/agent security.
5. **Raw user question into the prompt, no sanitization** — the query and
   rag-query agents pass the question straight through as the user turn (and
   rag-query injects `me.md` profile text + retrieved chunks). Prompt-injection
   surface, mitigated by read-only tools, output validation, and the
   fail-open `search_knowledge_base` filter. See `audit.md` → input-validation,
   `04-validated-model-output-gate.md`, and
   `05-local-model-tool-call-trust-boundary.md`.

## Cross-links

- **`.aipe/study-agent-architecture/`** — read-only tool grants as a *safety*
  property of the agent design; this guide treats the same allowlists as a
  *trust* control and finds where the enforcement actually lives.
- **`.aipe/study-prompt-engineering/12-prompt-injection-defense.md`** — the
  injection-defense posture; this guide names it as an input-validation lens
  finding and points at the output gate that backs it.
- **`.aipe/study-data-modeling/`** — the *shape* of artifacts and fixtures;
  this guide audits the *secret-scan* that runs over that shape before it's
  committed or published.
- **`.aipe/study-system-design/01-provider-abstraction.md`** — the provider
  boundary as architecture; this guide audits it as the trust line where
  keys leave the machine and untrusted output comes back.
