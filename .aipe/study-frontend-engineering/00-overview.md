# 00 — Studio frontend in one page

## Rendering mode, in one sentence

Studio is a **client-rendered SPA**: a single `createRoot().render()` in `apps/studio/src/main.tsx:76-77`, no SSR, no hydration, no router library — React 18 + Vite, all rendering happens in the browser after the bundle loads.

That's the whole story for rendering. The interesting part is everything downstream of the first paint: how server work streams back into the UI.

## The component tree

The app is shallow and wide. One root, a `useState` switch picking one of ten views, and below each workspace a three-column panel layout. **Five of the six agent workspaces** are driven by **the same generic shell**; three pages (`CapabilitiesWorkspace`, `RagQueryWorkspace`, `DocPage`) sit off-shell on purpose.

```
  Studio component tree (apps/studio/src)

  ┌─ UI layer (browser, client-rendered) ───────────────────────────┐
  │                                                                  │
  │  App()                          main.tsx:19   useState<StudioView>│
  │   │  (hand-rolled router — §04, 10 views)                        │
  │   ├─ StudioHome ────────────────  StudioHome.tsx   gallery cards  │
  │   │                                                              │
  │   ├─ RecommendationWorkspace ─┐                                  │
  │   ├─ MonitoringWorkspace ─────┤                                  │
  │   ├─ DiagnosticWorkspace ─────┼─► AgentReplayShell<F,M,R>  §03    │
  │   ├─ QueryWorkspace ──────────┤    AgentReplayShell.tsx:48        │
  │   ├─ RubricImprovementWorkspace┘    │                            │
  │   │                                  ├─ metricItems(ctx)  slot    │
  │   │                                  └─ renderPanels(ctx) slot    │
  │   │                                       ├─ Panel / Metric       │
  │   │                                       ├─ TracePanel  §01       │
  │   │                                       ├─ EvalPanel            │
  │   │                                       ├─ ProviderStatusPanel  │
  │   │                                       └─ ReviewPanel / History │
  │   │                                          (useReplayArtifacts §06)│
  │   │  ── off-shell pages (own layout, reuse leaf panels) ──        │
  │   ├─ CapabilitiesWorkspace ──── 4 previews in Promise.all         │
  │   │                              (CapabilitiesWorkspace.tsx:118)  │
  │   ├─ RagQueryWorkspace ──────── in-browser RAG replay  §09        │
  │   │                              (RagQueryWorkspace.tsx:8) reuses  │
  │   │                              Panel/Metric/TracePanel/EvalPanel │
  │   └─ DocPage ────────────────── api-docs + user-guide  §08        │
  │                                  (DocPage.tsx:30) react-markdown   │
  │                                  over a ?raw build-time string     │
  └──────────────────────────────────────────────────────────────────┘
```

Note the asymmetry: three pages skip the shell. The rule is simple — **a page uses the shell only if it replays one agent against a fixture/provider mode.** `CapabilitiesWorkspace` runs four utility previews in `Promise.all` (no single agent). `RagQueryWorkspace` replays a fixture but has no anthropic/openai mode axis — it runs a *deterministic in-browser* RAG pipeline (§09). `DocPage` renders markdown, no agent at all (§08). All three reuse the shell's *leaf* presentational components (`Panel`, `Metric`, `TracePanel`, `EvalPanel`) without inheriting its `F/M/R` run-lifecycle generics. Sharing the leaves while skipping the shell is the correct boundary, not abstraction for its own sake.

## The data flow that matters: stream → state → render

This is the mechanic to understand. When you click "Run" in a workspace, the browser opens a POST, the server streams NDJSON trace records back, and the UI paints each event as it arrives — before the final result exists.

```
  Live replay data flow (the load-bearing seam)

  ┌─ UI layer (browser) ──────────────────────────────────────────┐
  │  startReplay()                       AgentReplayShell.tsx:104   │
  │    runServer(fixture, mode, {onEvent}) ─────────┐              │
  └──────────────────────────────────────────────────┼────────────┘
                                                      │ POST /api/stream/<agent>/replay
  ┌─ Network boundary (HTTP, chunked) ◄───────────────┼────────────┐
  │  content-type: application/x-ndjson               │            │
  │  {"type":"event","event":{...}}\n   ← per trace event          │
  │  {"type":"event","event":{...}}\n                              │
  │  {"type":"result","result":{...}}\n  ← final, last line        │
  └──────────────────────────────────────────────────┬────────────┘
                                                      │ response.body (ReadableStream)
  ┌─ UI layer: api.ts ◄───────────────────────────────┼────────────┐
  │  responseBodyChunks(body)            api.ts:169    │            │
  │    reader.read() loop → yields Uint8Array          │            │
  │  decodeNdjsonStream(chunks)          api.ts:138    │ (runtime pkg)│
  │    for await (record of …)                         │            │
  │      type==='event'  → options.onEvent(event) ─────┘            │
  │      type==='result' → finalPayload = result                   │
  │      type==='error'  → throw                                   │
  └──────────────────────────────────────────────────┬────────────┘
                                                      │ onEvent callback
  ┌─ UI layer: React state ◄──────────────────────────┼────────────┐
  │  setLiveTrace(c => [...c, event])    AgentReplayShell.tsx:116   │
  │    (guarded by runCounter === nextRunId  §02)                  │
  │  visibleTrace = replay?.trace ?? liveTrace   :163              │
  │  <TracePanel trace={visibleTrace}/>  → repaints each event     │
  └────────────────────────────────────────────────────────────────┘
```

The full deep walk is in `01-live-stream-consumption.md`. The thing to carry: the UI does not wait for the response to finish. Each `\n`-delimited record that crosses the network boundary becomes a `setState` call, and React repaints the trace list incrementally.

## State architecture, in one diagram

There is no Redux, no Zustand, no Context store. State is entirely **local component state + one generic hook**, lifted no higher than the workspace.

```
  State ownership (who owns what)

  App                 view: StudioView          (the router, 10 views)
   ├ AgentReplayShell  selectedFixtureId, mode, providerStatus,
   │                   replay, liveTrace, running, runId, error
   │                   runCounter (ref, not state — §02)
   │   └ *Panels        comparison state (workspace-local)
   │      └ useReplayArtifacts  savedReplays, promotedFixtures,
   │                            saving, promoting, selectedReviewPath
   │                            (server-state-as-client-state — §06)
   │      └ TracePanel  filter: 'all'|'model'|'tools'|'warnings' (UI-only)
   ├ RagQueryWorkspace  selectedId, result, running, error, runId
   │                    (one in-browser run → one setResult — §09)
   └ DocPage            toc (useMemo over the ?raw markdown — §08)
```

Server state (saved replays, promoted fixtures, provider availability) is fetched imperatively in `useEffect`, stored in `useState`, and manually re-fetched after mutations. No cache library. That's a deliberate fit for a single-user dev tool — covered in `audit.md` lens 4.

One build-mode wrinkle rides on top of all this network state: Studio ships in two shapes — the live dev server, and a **fixture-only static demo for GitHub Pages** (`npm run build:pages`). A compile-time flag `STATIC_DEMO` (`src/env.ts`) gates every fetch effect and mutation so the static build never calls an `/api/*` route that isn't there. It's woven through the shell, the artifact hook, and nine components — see `07-static-demo-gated-ui.md`.

## The three highest-leverage patterns

1. **Live stream consumption** (`01-live-stream-consumption.md`) — `apps/studio/src/api.ts:119-180`. Strip it out and the trace panel goes from a live ticker to a spinner that dumps everything at the end. This is the most interesting frontend mechanic in the repo.
2. **The shared replay shell** (`03-shared-replay-shell.md`) — `apps/studio/src/AgentReplayShell.tsx:48-254`. One generic component over `<F, M, R>` carries the run lifecycle, provider status, fixture/mode selectors, and the live-trace state for five workspaces. Strip it out and you'd hand-copy that lifecycle five times.
3. **The stale-run guard** (`02-stale-run-guard.md`) — `apps/studio/src/AgentReplayShell.tsx:97,107-116`. A `useRef` counter that discards stream events from a superseded run. Strip it out and re-running mid-stream interleaves two runs' trace events into one corrupted list.

## What Studio does NOT do (honest gaps)

SSR / RSC, react-router, any state library (Redux/Zustand/Jotai), React Query / SWR, CSS framework / CSS Modules / CSS-in-JS, route-level code-splitting, dark mode / theming tokens, and a deliberate accessibility pass are all **not yet exercised**. Most are correct omissions for a single-user local dev tool; `audit.md` lens 8 ranks the few that actually bite.

## Two new surfaces this session

The `rag-query` agent now **has a Studio page** — and it took a different shape than this guide previously predicted. Rather than dropping into `AgentReplayShell`, `RagQueryWorkspace` (`RagQueryWorkspace.tsx`) is a **custom page** running a *deterministic in-browser RAG replay*: a keyword-hash fake embedder plus `InMemoryVectorStore` index a fixture corpus client-side, recorded Gemma responses drive the search→answer loop, and the page shows the answer, retrieved chunks (relevant ones highlighted), live precision@k / recall@k, the trace, and the eval. It skips the shell because it has no provider-mode axis. This is the first place Studio runs real `@aptkit/retrieval` + `@aptkit/evals` logic *in the browser*. Full walk: `09-deterministic-in-browser-rag.md`.

Studio also grew **in-app documentation pages**. `DocPage` (`DocPage.tsx`) renders `docs/*.md` through `react-markdown` + `remark-gfm` + `rehype-slug`, with a sticky github-slugger table-of-contents sidebar. The markdown is imported via Vite's `?raw` suffix (`main.tsx:13-14`), so it **inlines into the static bundle** — which is exactly why the docs work in the `STATIC_DEMO` GitHub Pages build with no backend to fetch from. Full walk: `08-build-time-markdown-docs.md`.
