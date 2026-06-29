# 00 — Overview: Studio's frontend in one page

## Rendering mode, in one sentence

Studio is a **client-only React 18 SPA built by Vite**, mounted once at
`apps/studio/src/main.tsx:119` (`createRoot(...).render(<App />)`), with **no
SSR, no SSG, no RSC, no hydration** — every byte of UI is produced in the
browser after the JS loads. The production artifact is a static bundle served
from GitHub Pages under `/aptkit/` (`vite.config.ts:196`), so there is no server
at runtime in the deployed demo — only at dev time.

## The whole thing, one diagram

The app is small enough to draw completely. Two render paths diverge at the
router: agent workspaces (left) and doc pages (right).

```
  Studio — the whole frontend

  ┌─ Build (Vite) ─────────────────────────────────────────────┐
  │  docs/*.md  ──?raw──►  inlined string                       │
  │  fixtures/*.json ──import──►  inlined JS object             │
  │  styles.css (rewritten by scripts/*.mjs at author time)     │
  └───────────────────────────┬─────────────────────────────────┘
                              │  one bundle, base=/aptkit/
  ┌─ Browser (SPA) ──────────▼──────────────────────────────────┐
  │  main.tsx App()  —  parseHash() reads window.location.hash   │
  │                     useState(route) + hashchange listener    │
  │            ┌──────────────┴───────────────┐                  │
  │     #rag-query / #recommendation     #api-docs / #user-guide │
  │            ▼                              ▼                   │
  │   Workspace component            DocPage (react-markdown)    │
  │   useState replay state          buildToc + rehype-slug      │
  │            │                              │                  │
  │            ▼ (dev only)                   ▼                  │
  │   fetch /api/stream/*  ──NDJSON──►  (no fetch; all inlined)  │
  └───────────────────────────┬─────────────────────────────────┘
                              │  dev only
  ┌─ Vite dev middleware ────▼──────────────────────────────────┐
  │  /api/model-status · /api/stream/*/replay · /api/replays     │
  │  runs the REAL agents in Node, streams CapabilityEvents      │
  └──────────────────────────────────────────────────────────────┘
```

The diagram carries the whole partition: build inlines data, the browser routes
by hash, and the only network seam (`/api/*`) exists **only in dev** — the
deployed Pages demo replays everything from inlined fixtures.

## State architecture, in one diagram

There is no Redux, no Zustand, no Context for app state, no react-query. State
is **local `useState` per screen**, plus one piece of genuinely global state —
the URL hash — and one custom hook that bundles the artifact-history workflow.

```
  State ownership

  URL hash (#view/anchor)        ← the ONLY global state, owns "which screen"
        │  parseHash()
        ▼
  App route state (useState)     main.tsx:45 — mirror of the hash
        │
        ├─► Workspace screen ─── useState: result | running | error | runId
        │      (RagQueryWorkspace.tsx:9-13, local, thrown away on unmount)
        │
        └─► AgentReplayShell ─── useState: replay | liveTrace | mode | …
               │                  (AgentReplayShell.tsx:85-96)
               └─► useReplayArtifacts ── server-history state, gated by
                     STATIC_DEMO (useReplayArtifacts.ts:14)
```

Source of truth: the hash owns navigation; everything else is ephemeral
component state, recomputed on each run. No cache to invalidate because there's
nothing cached — `runId` is bumped to force a fresh derive
(`RagQueryWorkspace.tsx:13`, `AgentReplayShell.tsx:108`).

## The network seam, in one diagram

The single place server state crosses into client state is the dev-server
streaming endpoints, decoded as NDJSON. In the static Pages build this seam is
*severed* — `STATIC_DEMO` short-circuits every fetch.

```
  Client → dev server, NDJSON over fetch (dev only)

  ┌─ Browser ──────────┐  POST {fixtureId, mode}   ┌─ Vite middleware ─┐
  │ runReplayStream()  │ ─────────────────────────►│ runQueryReplay()  │
  │ api.ts:119         │                            │ real agent, Node  │
  │                    │◄── NDJSON lines ───────────│ encodeNdjson      │
  │ decodeNdjsonStream │   {type:'event', event}…   │ vite.config.ts    │
  │ → onEvent(...)     │   {type:'result', …}       │  :386+            │
  └────────────────────┘                            └───────────────────┘
        live trace streams in event-by-event as the agent runs
```

NDJSON-on-the-wire mechanics belong to `study-networking`; the system boundary
belongs to `study-system-design`. Here it's just: *the only fetch in the app,
and it's dev-only.*

## The three highest-leverage patterns

1. **Hash router, hand-rolled** (`main.tsx:23-60`, `01-…`). 40 lines replace
   react-router. `#view/section` — the slash splits route from doc anchor so
   the same hash both navigates *and* deep-links into a markdown heading. Earns
   its place because the Pages deploy is static (no SPA 404 fallback), so hash
   routing is the *correct* call, not a shortcut.
2. **Deterministic in-browser RAG** (`agent-runners.ts:146-228`,
   `RagQueryWorkspace.tsx`, `03-…`). A fake keyword-hash embedder + the real
   `InMemoryVectorStore` + the real agent loop, all in the browser. The Pages
   demo runs an *actual* retrieval pipeline with zero backend, scored with
   precision@1/recall@k live.
3. **Generic replay shell** (`AgentReplayShell.tsx`, `04-…`). One render-prop
   component, generic over `<Fixture, Mode, Result>`, hosts all four analytics
   agents — header, mode switch, fixture select, run button, trace, metrics —
   so each agent screen is ~40 lines of config.

## What's honestly *not here*

- **No data-fetching framework** — no react-query/SWR/loaders. Raw `fetch` +
  one decode helper (`api.ts`). Fine: there's almost no server state.
- **No client state library** — `useState` only. Fine: no cross-screen shared
  state exists.
- **No SSR / SSG / RSC / hydration** — pure client SPA.
- **No design tokens / CSS variables for theme** — colors are *hardcoded hex*,
  rewritten by author-time scripts (`scripts/*.mjs`). Real limitation; see
  `audit.md` → styling and `06-scripted-theme-transform.md`.
- **No tests for the UI** — one Playwright smoke spec (`tests/studio/`) exists
  at the repo level; component/unit tests for Studio: `not yet exercised`.
- **No responsive breakpoints to speak of**, **no animation system**, **no
  code-splitting** (single chunk) — see `audit.md`.
