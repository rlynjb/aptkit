# Security overview — one page

Before any lens, the whole picture. AptKit has exactly one trust boundary
that matters, two assets worth protecting, and four controls that guard
them. Everything else in a standard security checklist is `not yet
exercised` because the repo has no surface for it — and saying so plainly is
half the audit.

## The system as trust bands

The same monorepo, x-rayed along the trust axis: what can each side see,
reach, or tamper with?

```
  AptKit along the trust axis — what each band can reach

  ┌─ Developer machine (TRUSTED) ───────────────────────────────────┐
  │  .env  ──►  provider adapters  ──►  agent loop (runs tool calls) │
  │  keys      (read process.env)        ▲          │               │
  │                                      │          ▼               │
  │                            tool schemas    InMemoryToolRegistry │
  │                            (filtered)       (holds ALL handlers)│
  └──────────────────────────────────────┬──────────────────────────┘
                                          │  request (system+messages+tools)
  ┌─ Model provider (UNTRUSTED) ──────────▼──────────────────────────┐
  │  Anthropic / OpenAI — returns text + tool_use blocks             │
  │  this output is NOT trusted: it's parsed, validated, gated       │
  └──────────────────────────────────────┬──────────────────────────┘
                                          │  NDJSON trace (no secrets)
  ┌─ Studio browser tab (localhost) ──────▼──────────────────────────┐
  │  React UI renders trace + outputs — never receives a key         │
  └───────────────────────────────────────────────────────────────────┘
                                          │  git push / npm publish
  ┌─ Public surface (HOSTILE) ────────────▼──────────────────────────┐
  │  GitHub repo + @rlynjb/aptkit-core tarball — anything that       │
  │  leaked into a committed artifact is now world-readable          │
  └───────────────────────────────────────────────────────────────────┘
```

## The two assets

- **API keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, plus their `_MODEL`
  names) — live only in `.env`, gitignored. Compromise = someone runs up your
  provider bill or impersonates you to the provider.
- **Artifacts and fixtures** — JSON recorded from real runs
  (`artifacts/replays/*.json`, `packages/agents/*/fixtures/`). Committed to
  git and **inlined into the published npm bundle** via `bundledDependencies`.
  Compromise = a stray secret or sensitive workspace datum ships to the
  public registry.

## The four controls (the Pass-2 pattern files)

| Control | Guards | Where |
| --- | --- | --- |
| Tool-policy filtering | LLM least-privilege | `01-tool-policy-enforcement-by-omission.md` |
| Secret-scan guard | artifact/fixture data-exposure | `02-secret-scan-guard.md` |
| Server-side key boundary | key confidentiality + path traversal | `03-server-side-key-boundary.md` |
| Validated output gate | untrusted model output | `04-validated-model-output-gate.md` |

## What's deliberately out of scope

These are `not yet exercised` — not gaps to fix, structural facts of a
library/dev-tool with no deployed multi-user surface:

- **Authentication / authorization** — no login, no sessions, no users. The
  only "caller" is the developer running it locally.
- **CSRF / CORS hardening** — the Studio API is a local Vite dev server on
  `localhost:4187`, reachable only from the dev's own machine.
- **Rate limiting** — bounded by the agent loop's turn/tool-call budgets for
  cost, not by a request limiter; there's no public ingress to limit.
- **SQL injection** — no database. "Data" is files and NDJSON streams.
- **Encryption at rest / audit logging of access** — no persisted user data
  store, no access events to log.

The full per-lens walk, with the constructive move for each real gap, is in
`audit.md`.
