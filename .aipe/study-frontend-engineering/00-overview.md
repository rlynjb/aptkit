# Studio — frontend overview (one page)

Studio is a **client-rendered single-page app** (SPA): React 18 mounted once into
`#root` at `apps/studio/src/main.tsx:118-120`, no SSR, no hydration, no framework router.
Everything renders in the browser. The whole job of the frontend is to take recorded
agent fixtures and turn them into readable, scored output — answers, retrieved chunks,
traces, eval verdicts.

There are two deploy shapes from one codebase, switched by one env var:

```
  Two builds, one source — gated by VITE_STATIC_DEMO

  ┌─ dev (npm run dev) ──────────────────────┐   ┌─ pages (build:pages) ───────────────┐
  │ base '/'                                  │   │ base '/aptkit/'                      │
  │ Vite middleware = live /api/* replay      │   │ NO server — middleware doesn't ship  │
  │ Anthropic / OpenAI providers callable     │   │ fixture replay only (in-browser)     │
  │ save / promote artifacts to disk          │   │ network actions show "local dev only"│
  └───────────────────────────────────────────┘   └──────────────────────────────────────┘
        vite.config.ts:196  base = env.VITE_STATIC_DEMO === '1' ? '/aptkit/' : '/'
        env.ts:1            STATIC_DEMO = import.meta.env.VITE_STATIC_DEMO === '1'
```

## State architecture — in one diagram

Studio holds no global store. All state is `useState` local to a view, plus **URL state**
owned by the hash. There is no Redux, Zustand, Context store, react-query, or SWR.

```
  State ownership — who owns what

  ┌─ URL (window.location.hash) ─────────────────────────────┐
  │  the active route + doc section anchor                    │  ← source of truth for
  │  parseHash() → { view, anchor }   main.tsx:34-42          │     "which page am I on"
  └───────────────────────────┬───────────────────────────────┘
                              │ hashchange → setRoute
  ┌─ App component state ─────▼───────────────────────────────┐
  │  route: StudioView   (App, main.tsx:45)                   │
  └───────────────────────────┬───────────────────────────────┘
                              │ renders one view
  ┌─ Per-view local state (useState only) ────────────────────┐
  │  RagQueryWorkspace: selectedId, result, running, error    │  RagQueryWorkspace.tsx:9-14
  │  AgentReplayShell:  replay, liveTrace, mode, runCounter   │  AgentReplayShell.tsx:85-98
  │  DocPage:           toc (useMemo), anchor effect           │  DocPage.tsx:46-56
  └───────────────────────────────────────────────────────────┘
```

No server-state cache exists because there is no long-lived server data — each replay is a
one-shot `fetch` (dev) or a pure in-browser computation (pages). Server-state-as-cache is
`not yet exercised`.

## Network seam — in one diagram

In dev, the network seam is **NDJSON streamed over `fetch`** through Vite middleware. In
pages there is no network at all.

```
  Network seam (dev only) — layers and hops

  ┌─ Browser (React) ─────────────┐ hop1: POST /api/stream/query/replay   ┌─ Vite middleware ─┐
  │ api.ts runReplayStream        │ ─────────────────────────────────────►│ vite.config.ts    │
  │ decodeNdjsonStream over a     │                                        │ runs the real     │
  │ ReadableStream reader         │ hop2: NDJSON lines (event… event…      │ agent + provider  │
  │ onEvent → setLiveTrace        │ ◄───────────────────── result) ◄───────│ streamReplay…     │
  └───────────────────────────────┘                                        └───────────────────┘
        api.ts:119-166                                                       vite.config.ts:386-449
```

## The three highest-leverage frontend patterns

1. **Hash routing with section anchors** (`main.tsx:34-60`) — every view gets a URL, doc
   sections live after a slash (`#api-docs/conversation-memory`), so the static Pages build
   needs no SPA 404-fallback and deep links survive a refresh. → `01-`
2. **Deterministic in-browser RAG** (`agent-runners.ts:146-228`) — a fake keyword-hash
   embedder + `InMemoryVectorStore` run the *real* `@aptkit/retrieval` pipeline with zero
   network, scored with precision@1 / recall@k. The RAG page works on static GitHub Pages.
   → `03-`
3. **Generic trace-replay shell** (`AgentReplayShell.tsx:48-236`) — one generic component
   `<F, M, R>` drives all five analytics-agent pages; a monotonic `runCounter` ref drops
   stale streamed events so a fast re-run can't interleave traces. → `04-`

## What Studio does NOT do (and the audit says so honestly)

No data-fetching/state library (just `useState`), no SSR/SSG/RSC, no design-token system
(theme colors are literal hex, transformed by a build script), no UI unit tests (only a
repo-level Playwright smoke spec), no code-splitting at the route boundary, no service
worker / offline cache. Each is named `not yet exercised` in `audit.md` rather than
papered over.
