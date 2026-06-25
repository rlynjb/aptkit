# Security audit — AptKit (Pass 1)

Eight lenses, walked in order against the real code. Each lens names what
the repo actually does with `file:line` grounding, or emits `not yet
exercised` honestly. The threat model is fixed: a TypeScript library plus a
local-dev Studio, no deployed multi-user surface. The trust boundary is the
developer's machine + their own API keys + untrusted model output. Read
`00-overview.md` first for the boundary diagram.

---

## 1. Trust boundaries and attack surface

The attack surface is small and worth enumerating exactly, because most of a
standard checklist simply doesn't apply.

**Where untrusted input crosses into trusted code:**

- **Model output** — the largest surface. Every provider's `complete()`
  returns text and `tool_use` blocks that flow back into the agent loop
  (`packages/runtime/src/run-agent-loop.ts:103`). The model is the untrusted
  party *inside* the loop. It is gated three ways: the tool schema it sees is
  filtered (lens 7), its tool-call count is bounded
  (`run-agent-loop.ts:101`), and its final output is parsed/validated before
  use (lens 3). → deep walk in `04-validated-model-output-gate.md`.
- **Gemma's emulated tool calls** — the *sharpest* new surface. `gemma2:9b`
  has no native tool-calling, so the provider renders tool schemas into system
  prose and parses the model's free text back into a `{name, arguments}` tool
  call (`packages/providers/gemma/src/gemma-provider.ts:168`). The model now
  *names the tool* through prose — a control decision derived from untrusted
  output. → deep walk in `05-local-model-tool-call-trust-boundary.md`.
- **The local Ollama transport** — a network hop the cloud providers didn't
  have. The Gemma chat/embedding providers POST to `http://localhost:11434`
  with no API key and no TLS (`gemma-provider.ts:201-215`,
  `ollama-embedding-provider.ts:60-74`). Untrusted input crosses *back* over an
  unauthenticated plaintext channel. Safe on loopback; an open service the
  moment `host` is non-loopback (lens 4).
- **Studio replay HTTP bodies** — the Vite middleware reads JSON request
  bodies for replay/promote endpoints (`apps/studio/vite.config.ts:920`).
  Reachable only from `localhost`. The one with a real path is
  `/api/replay/save` and the `*/promote` routes, which take a `path` field
  that is constrained to `artifacts/replays/` (`vite.config.ts:1415`). →
  `03-server-side-key-boundary.md`.
- **The user's free-form question** — passed straight into the query agent's
  prompt as the user turn (`packages/agents/query/src/query-agent.ts:92`), and
  the rag-query agent likewise (`rag-query-agent.ts:62`). No sanitization.
  Prompt-injection surface (lens 3). The rag-query path additionally injects
  user-profile (`me.md`) text into the system prompt
  (`rag-query-agent.ts:55`), and retrieved knowledge-base chunks flow back as
  tool results — both are untrusted-content channels into the prompt.
- **Recalled conversation memory** — the *newest* surface. `@aptkit/memory`
  (`packages/memory/src/conversation-memory.ts`) stores a past user
  question + assistant answer as a vector row and `recall`s the most-similar
  ones back into a *future* request. The replayed text is untrusted (it's what
  a past user typed, or an answer steered by injected content), and on the
  shared-store path it re-enters through the same `search_knowledge_base` tool
  the agent already trusts as grounding. Not wired into any aptkit agent yet;
  live only in buffr's chat session
  (`/Users/rein/Public/buffr/src/session.ts:53,66`). → deep walk in
  `06-conversation-memory-trust-surface.md`.
- **Fixtures / artifacts on disk** — JSON read by the Studio server and the
  eval scripts. Trusted as developer-authored, but they're also the
  data-*exit* surface (lens 5).

**Red flag check** — "input treated as trusted because it comes from our own
frontend": the Studio browser is the dev's own machine, so this is benign
here. The one thing that *looks* like trusting your own frontend is
`/api/replay/save` writing a JSON file from a POST body — but it's a local
dev server and the artifact is shape-normalized first
(`vite.config.ts:1497`).

---

## 2. Authentication and authorization

**`not yet exercised`** — and correctly so.

There is no login, no session, no token issuance, no user model anywhere in
the repo. The library is imported into a host process; the Studio is a local
Vite dev server. The only "principal" is the developer who started the
process. There is nothing to authenticate and no per-resource authz decision
to make.

The classic gap this lens hunts for — "authn present, authz assumed" — can't
exist without an authn layer to assume past. If AptKit ever grows a hosted
multi-tenant Studio, *this* is the lens that wakes up: every replay endpoint
would need a who-are-you check and every `artifacts/replays/` read would need
a which-tenant check. Today, buildable target is N/A.

---

## 3. Input validation and injection

The injection classes most checklists fire on — SQL, command, path, XSS —
are mostly absent by construction. The one live class is **prompt
injection**, and the defense is **output validation**, not input scrubbing.

- **SQL injection** — `not yet exercised`. No database, no query string
  built anywhere.
- **Command injection** — `not yet exercised`. No `exec`/`spawn` over
  user-influenced strings in the runtime path.
- **Path traversal** — *present and guarded*. The Studio promote/save
  endpoints take a `path` from the request body; `resolveReplayPath` resolves
  it and rejects anything not under `artifacts/replays/`
  (`apps/studio/vite.config.ts:1415-1424`). Without that guard a POST could
  name `../../etc/...` and the server would read it. This is the one place
  the repo does real input validation against a filesystem sink.
- **XSS** — low surface. The Studio renders model output as React text nodes
  (default-escaped), not via `dangerouslySetInnerHTML`. A grep for it comes
  up empty.
- **Prompt injection** — *present, unsanitized at input*. The query agent
  passes the raw question into the loop as the user turn
  (`packages/agents/query/src/query-agent.ts:92`); the other agents build
  prompts from `WorkspaceDescriptor` data. There is no input-side sanitizer —
  by design, because scrubbing natural language is brittle. The defense is on
  the *output* side: the model can only call read-only tools (lens 7), its
  output is parsed and schema-validated before it's trusted as data (lens 3 →
  `04-validated-model-output-gate.md`), and the loop is turn-bounded.

- **Persistent prompt injection via conversation memory** — *new, NOT bounded
  by those mitigations*. The above defenses bound an injection to a single
  turn. `@aptkit/memory` removes that bound: `remember` embeds a past
  question/answer and `recall` replays the most-similar one into a *future,
  unrelated* request — possibly a different session, since buffr persists to
  Postgres. An instruction injected in turn N can therefore resurface at turn
  N+k. The output gate and read-only allowlist limit *what* a recalled
  injection can do, not *that* it gets replayed. The engine filters recalled
  rows only by `kind` — never by `conversationId`
  (`packages/memory/src/conversation-memory.ts:96-98`). → deep walk in
  `06-conversation-memory-trust-surface.md`.

- **LLM-controlled query shaping** — *present, newly hardened*. The
  `search_knowledge_base` tool lets the model pass a `top_k` and a `filter`
  object — model-controlled retrieval parameters. A weak local model can
  hallucinate an over-broad or wrong-keyed `filter` (e.g.
  `{textContains: "x"}`) that, with naive AND-matching, would silently wipe
  every result. The hardening: `matchesFilter` only *excludes* a hit that
  *has* the key with a different value; keys absent from a chunk's metadata are
  ignored (`packages/retrieval/src/search-knowledge-base-tool.ts:101-106`).
  And `minTopK` floors the result count so a model passing `top_k: 1` can't
  starve its own retrieval (`search-knowledge-base-tool.ts:51,81`). This is the
  defensive posture for *model-controlled tool arguments*: don't trust the
  filter to be well-formed, make a malformed one fail *open* (still return
  results) rather than *closed* (silent empty). → lens 7.

**Verdict:** the right call for this threat model is exactly what's here —
don't try to sanitize the prompt, constrain what the model can *reach* and
*emit*. The `search_knowledge_base` filter hardening is the one place AptKit
already does an allow/deny-style pass on a model-controlled tool *argument*.
The buildable hardening, if AptKit took genuinely hostile input, would extend
that posture: an allow/deny pass on tool arguments before `callTool` across
the board, not on the prompt.

→ `04-validated-model-output-gate.md` for the output gate;
`.aipe/study-prompt-engineering/12-prompt-injection-defense.md` for the
prompt-side posture.

---

## 4. Secrets and configuration

The hygiene here is correct, and the one residual risk is the publish path.

- **Where keys live:** `.env` only, holding `OPENAI_API_KEY`, `OPENAI_MODEL`,
  `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`. Confirmed gitignored
  (`.gitignore:4`). Never hardcoded.
- **How they're read:** providers read `process.env` at construction —
  `packages/providers/anthropic/src/anthropic-provider.ts:25`
  (`apiKey ?? process.env.ANTHROPIC_API_KEY`), same shape for OpenAI. The
  Studio loads them via Vite's `loadEnv` into `process.env`
  (`apps/studio/vite.config.ts:830-845`).
- **Keys stay server-side:** the Studio uses keys only inside `configureServer`
  middleware (`vite.config.ts:799-817`). There is **no** `define:` block, no
  `import.meta.env` exposure, no `VITE_`-prefixed key — so nothing reaches the
  browser bundle. `/api/model-status` returns only a boolean `available` and
  the model *name*, never the key (`vite.config.ts:201-215`). → deep walk in
  `03-server-side-key-boundary.md`.
- **Keys must not reach logs/artifacts:** backed by the secret-scan guard
  (`packages/evals/src/assertions.ts:397`), which runs over every replay
  artifact before it's accepted (lens 5).

- **The Gemma path has no secret at all** — a different trust profile worth
  naming. The local providers carry no API key: `GemmaModelProvider` and
  `OllamaEmbeddingProvider` only hold a `host` and `model`, defaulting to
  `http://localhost:11434` (`gemma-provider.ts:48`,
  `ollama-embedding-provider.ts:47`). There's nothing to leak into a bundle or
  artifact. The tradeoff: the *transport* is unauthenticated and unencrypted
  (no key means the server isn't authenticated either), so the risk moves from
  *key confidentiality* to *channel trust* — "whatever answers
  `localhost:11434` is my model." Benign on a single laptop; an exposure the
  moment Gemma runs on a shared host or `host` points off-loopback. → deep walk
  in `05-local-model-tool-call-trust-boundary.md`.

**Red flag check** — secret in source / client bundle / logs: none found. The
residual risk isn't a leak *today*, it's that the publish pipeline inlines
artifacts (lens 5/6), so the secret-scan is load-bearing. The Gemma path adds
no key-leak surface but adds an unauthenticated-transport surface instead.

---

## 5. Data exposure and privacy

This is the lens that actually bites for this repo, and it's why a Pass-2
file exists for it.

The exposure path: replay artifacts (`artifacts/replays/*.json`) and agent
fixtures (`packages/agents/*/fixtures/`) are **committed to git** and
**inlined into the published npm tarball**. The core package declares
`bundledDependencies` for every internal package
(`packages/core/package.json:44-60`) — now including `provider-gemma`,
`retrieval`, and `agent-rag-query` (`package.json:35,41,43`) — and each agent
ships its compiled output, so fixtures travel with the agents into a public
registry artifact. Anything sensitive captured during a live run (a real
workspace metric, an accidental key in a tool result, an indexed
knowledge-base chunk) becomes world-readable on publish. The new local-RAG
path widens this: any fixture or artifact recorded from a real knowledge base
ships in the tarball under the same `bundledDependencies` umbrella.

The control: `findSecretLikeString` walks every artifact recursively and
fails validation if any string matches `sk-[A-Za-z0-9_-]{10,}` or
`OPENAI_API_KEY=` (`packages/evals/src/assertions.ts:397-421`). It's wired
into every `assert*ReplayArtifactShape` function
(e.g. `assertions.ts:120-123`), so a leaky artifact fails the shape eval and
can't be promoted to a fixture. → deep walk in `02-secret-scan-guard.md`.

The honest gap: the regex is narrow. It catches OpenAI-style `sk-` keys and a
literal env assignment, but **not** Anthropic keys (`sk-ant-...` actually
matches the `sk-` prefix, so that one's covered), generic bearer tokens, or
PII in a workspace metric. There's no field-level redaction of workspace data
either — a `WorkspaceDescriptor` with real customer numbers flows into a
prompt and can echo into the artifact's `answer`/`recommendations`.

**The new retention surface — conversation memory.** `@aptkit/memory` stores
every remembered exchange as the **raw** user question + assistant answer
verbatim, with no TTL, no eviction, and no redaction in the engine
(`packages/memory/src/conversation-memory.ts:44-46,84`). In buffr these rows
persist indefinitely in Postgres (`agents.chunks`,
`/Users/rein/Public/buffr/sql/001_agents_schema.sql:14-25`). Two consequences:
(a) a user who types a token or PII creates a durable, embeddable, recallable
copy of it; (b) the secret-scan guard above runs over **replay artifacts**,
not over memory rows — so a secret a user types is captured by `remember`
*without ever passing the scan*. → deep walk in
`06-conversation-memory-trust-surface.md`.

**Red flag check** — response returns more than the caller is entitled to:
there's no API caller to over-serve, but the *publish* is the over-serve.
Verbose errors: the Studio middleware returns `error.message` to the local
client (`vite.config.ts:228`), fine for localhost.

**Buildable move:** widen the secret-scan to cover generic high-entropy
tokens and add a workspace-PII denylist pass; gate `npm publish` on a
`git grep`/scan over the staged tarball, not just over promoted artifacts.

---

## 6. Dependencies and supply chain

- **Lockfile:** present — `package-lock.json` at the root. Installs are
  reproducible. (The context note "no lockfile audit run" refers to *running*
  `npm audit` in CI, not to the lockfile's absence.)
- **Direct deps:** the surface is deliberately thin. Root has only
  `@playwright/test` and `typescript` as devDeps (`package.json:38-41`).
  Provider packages pull `@anthropic-ai/sdk ^0.60` and `openai ^6.44`; Studio
  pulls `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `lucide-react`.
  No exotic transitive bloat in the runtime/agents path — those packages have
  zero or one internal dep.
- **`bundledDependencies`:** the published `@rlynjb/aptkit-core` inlines all
  11 internal `@aptkit/*` packages (`packages/core/package.json:44`). This is
  a supply-chain *narrowing* — consumers get one tarball with no floating
  internal-version resolution — but it also means the secret-scan + fixture
  contents (lens 5) ship inside that tarball.
- **postinstall/script risk:** no `postinstall` hooks in the package
  manifests; the only scripts are `build`/`test`/`pack`.

**Red flag check** — no lockfile (false; present), known CVEs unpatched: not
verified by this audit. **Buildable move:** add `npm audit --omit=dev` (or
`osv-scanner`) to the `publish-core.yml` workflow so a known-vuln in the
Anthropic/OpenAI SDK or Vite chain blocks a release. Today that gate doesn't
exist.

---

## 7. LLM and agent security

This is the lens with the most live surface, and the repo's design here is
genuinely good — with two sharp edges worth naming: the Gemma prose-parsed
dispatch (below) and the new conversation-memory recall channel, which is the
single highest-leverage addition this run.

- **Tool/permission scope:** each capability ships a `ToolPolicy` allowlist;
  `filterToolsForPolicy` reduces the full registry catalog to only the schemas
  that capability may call (`packages/tools/src/tool-policy.ts:11-23`). The
  model **never sees** tools outside its allowlist — enforcement by omission.
  Every agent's policy is **read-only** (list_*/get_*/execute_analytics) —
  `query-agent.ts:10-50`, the monitoring/diagnostic/recommendation agents
  likewise — **except `rubric-improvement`**, whose allowlist includes
  `save_judgment`, the one mutating tool in any policy
  (`packages/agents/rubric-improvement/src/rubric-improvement-agent.ts:15-25`).
  That's the widest grant; flag it as the one capability that can change state.
  → deep walk in `01-tool-policy-enforcement-by-omission.md`.
- **The sharp edge:** the allowlist is enforced *only* at the schema-filtering
  layer. At execution time the loop calls `tools.callTool(name, ...)` with
  whatever name the model emitted (`run-agent-loop.ts:159`), and the registry
  checks only that the tool is *registered* — not that it's in the calling
  agent's policy (`packages/tools/src/tool-registry.ts:56-59`). Since the
  registry holds *all* handlers, a tool name that reached `callTool` outside
  the policy would run. Today nothing puts it there (the model can't name a
  tool it never saw), but the trust assumption "the model only calls allowed
  tools" rests entirely on by-omission, with no defense-in-depth gate. The
  Gemma path makes this seam more reachable in principle: there the model emits
  the tool name directly as a JSON string (`gemma-provider.ts:168`), so the
  only thing stopping an off-policy name is the registry's contents, not the
  policy — see `05-local-model-tool-call-trust-boundary.md`.
- **Output handling:** model output is never treated as trusted code/SQL. It's
  parsed (`packages/runtime/src/json-output.ts:7`), schema-validated, and
  retried once with a strict-JSON nudge before use
  (`packages/runtime/src/structured-generation.ts:54-101`). → lens 3 /
  `04-validated-model-output-gate.md`.
- **Emulated tool calls on the Gemma path:** the highest-leverage new surface.
  Because `gemma2:9b` has no native tool-calling, `GemmaModelProvider` renders
  the tool schemas into system prose and parses the model's reply back into a
  `{name, arguments}` tool call (`packages/providers/gemma/src/gemma-provider.ts:168`).
  The model controls dispatch through free text — a control decision derived
  from untrusted output. The defense is fail-closed parsing: `parseToolCall`
  type-guards the parsed JSON and returns `null` (→ "plain answer", no
  dispatch) on anything malformed. It does *not* re-check the allowlist, so the
  by-omission gap below applies to this path too — what actually blocks an
  off-policy name today is that the rag-query registry holds only the
  `search_knowledge_base` handler (`rag-query-agent.ts:15-18`), so an
  off-policy name throws "tool not found". → deep walk in
  `05-local-model-tool-call-trust-boundary.md`.
- **Model-controlled tool arguments, hardened:** `search_knowledge_base` lets
  the model pass a `filter` and `top_k`. A weak local model can hallucinate an
  over-broad filter; `matchesFilter` makes it fail *open* (ignores keys absent
  from a chunk's metadata, so a bogus filter can't silently zero out results)
  and `minTopK` floors the result count
  (`search-knowledge-base-tool.ts:51,81,101-106`). This is the one place the
  repo treats a *model-controlled tool argument* as hostile and shapes its
  effect defensively. → lens 3.
- **Conversation memory as an untrusted recall channel:** the sharpest new
  LLM-security surface. `recall` feeds past user/assistant text back into a
  later context, and in buffr's wiring memory shares the document store, so it
  surfaces through the *same* `search_knowledge_base` tool the agent trusts as
  grounding (`/Users/rein/Public/buffr/src/session.ts:43,51,53`). The tool
  passes hit `text` through to the model with no provenance marker
  (`search-knowledge-base-tool.ts:110-116`), so a past user's words can be
  cited as a knowledge-base fact — trust-level blur. The engine's only filter
  is `kind`; it never scopes by `conversationId`
  (`conversation-memory.ts:96-98`), so within one `app_id` every
  conversation's memory is recallable by every other, and isolation rests
  entirely on the store's `WHERE app_id` clause
  (`/Users/rein/Public/buffr/src/pg-vector-store.ts:74`) — there is **no RLS**
  in the schema (`001_agents_schema.sql` defines `app_id` columns + a plain
  index, no row-level-security policy). Same shape as the retrieval `app_id`
  isolation story: enforced by an app-code filter, not the DB. → deep walk in
  `06-conversation-memory-trust-surface.md`.
- **Data exfiltration through tool calls:** bounded — read-only tools can't
  write out, the loop caps tool calls (`run-agent-loop.ts:101`) and tool
  results are truncated to 16K chars (`run-agent-loop.ts:52`). Memory does
  *not* add a write-out path (the `search_memory` tool is read-only), but it
  does add a *persistence* path: anything a user types is durably stored and
  re-readable later (lens 5).

**Red flag check** — agent whose tool set exceeds its task: `rubric-improvement`
is the only one with write access, and it needs it (saving a judgment is the
task). Model output flowing into a sink without a gate: not found — the gate
is the validator. **Buildable move:** re-check the policy allowlist inside
`callTool` (pass the policy to the executor) so enforcement is
defense-in-depth, not omission-only.

---

## 8. Security red-flags audit (capstone)

Consolidated checklist against this repo. `fires` = a real exposure here;
`N/A` = no surface for it in a library/dev-tool.

| Red flag | Status | Location | Severity | One-line fix |
| --- | --- | --- | --- | --- |
| Secret in source | does not fire | keys only in gitignored `.env` | — | — |
| Secret in client bundle | does not fire | no `define`/`VITE_` key in Studio | — | — |
| Secret in committed/published artifact | **fires (latent)** | `artifacts/`, fixtures inlined via `bundledDependencies` (`core/package.json:44`) | high | widen secret-scan + scan staged tarball pre-publish |
| Narrow secret-scan regex | **fires** | `assertions.ts:399` | medium | add generic-token + entropy + PII passes |
| Tool allowlist enforced only by omission | **fires** | `tool-registry.ts:56`, `run-agent-loop.ts:159` | medium | re-check policy in `callTool` |
| Model names tool via parsed prose (Gemma) | **fires (by design)** | `gemma-provider.ts:168` | medium | fail-closed parse mitigates; add policy re-check in `callTool` |
| Unauthenticated/plaintext local-model transport | **fires (latent)** | `gemma-provider.ts:201`, `ollama-embedding-provider.ts:60` | low (loopback) / high (off-loopback) | bind Ollama to loopback or add a shared token before non-local `host` |
| Persistent prompt injection via recalled memory | **fires (latent, buffr)** | `conversation-memory.ts:89-98` (recall replays past turns; no conversation/turn scoping) | high | mark memory provenance + scope recall; mitigations bound effect, not replay |
| Memory rows bypass the secret-scan | **fires (latent, buffr)** | `conversation-memory.ts:84` stores raw Q/A; scan only covers replay artifacts | medium | run `findSecretLikeString` over the formatted turn before upsert |
| Shared-store memory cited as a document fact | **fires (by design, buffr)** | `session.ts:53` shares store; `search-knowledge-base-tool.ts:110` no provenance marker | medium | label memory hits as user-authored / lower-trust |
| Cross-conversation memory leak (no RLS) | **fires (latent)** | recall ignores `conversationId`; `app_id` isolation is a `WHERE` clause, no RLS (`001_agents_schema.sql`) | low (single app_id) / high (multi-tenant) | scope recall + add RLS before multi-tenant |
| Hallucinated model filter wipes retrieval | does not fire | guarded at `search-knowledge-base-tool.ts:101-106` (fail-open) | — | — |
| Mutating tool in an agent grant | **fires (by design)** | `rubric-improvement-agent.ts:22` (`save_judgment`) | low | document it as the one write-capable capability |
| Raw user input into prompt | fires (mitigated) | `query-agent.ts:92` | low | output gate + read-only tools already mitigate |
| Path traversal on file endpoint | does not fire | guarded at `vite.config.ts:1415` | — | — |
| Verbose error to client | does not fire (localhost) | `vite.config.ts:228` | — | — |
| No dependency vuln scan in CI | **fires** | `publish-core.yml` has no `npm audit` | medium | add `npm audit`/`osv-scanner` gate |
| SQL injection | N/A | no database | — | — |
| Missing authn/authz | N/A | no users / no login | — | — |
| CSRF / CORS | N/A | local Vite dev server only | — | — |
| Rate limiting (request) | N/A | no public ingress | — | — |
| Encryption at rest | N/A | no persisted user-data store | — | — |
| Audit logging of access | N/A | no access events | — | — |

**The single worst exposure, ranked first:** the publish path. The
secret-scan guard is the only thing between a leaked credential and the
public npm registry, and it's a two-pattern regex. Harden that before
anything else.
