# 00 — Studio frontend in one page

## Rendering mode, in one sentence

Studio is a **client-rendered SPA**: a single `createRoot().render()` in `apps/studio/src/main.tsx:44-45`, no SSR, no hydration, no router library — React 18 + Vite, all rendering happens in the browser after the bundle loads.

That's the whole story for rendering. The interesting part is everything downstream of the first paint: how server work streams back into the UI.

## The component tree

The app is shallow and wide. One root, a `useState` switch picking one of seven views, and below each workspace a three-column panel layout. Five of the six workspaces are driven by **the same generic shell**.

```
  Studio component tree (apps/studio/src)

  ┌─ UI layer (browser, client-rendered) ───────────────────────────┐
  │                                                                  │
  │  App()                          main.tsx:13   useState<StudioView>│
  │   │  (hand-rolled router — §04)                                  │
  │   ├─ StudioHome ────────────────  StudioHome.tsx   gallery cards  │
  │   │                                                              │
  │   ├─ RecommendationWorkspace ─┐                                  │
  │   ├─ MonitoringWorkspace ─────┤                                  │
  │   ├─ DiagnosticWorkspace ─────┼─► AgentReplayShell<F,M,R>  §03    │
  │   ├─ QueryWorkspace ──────────┤    AgentReplayShell.tsx:48        │
  │   ├─ RubricImprovementWorkspace┘    │                            │
  │   │                                  ├─ metricItems(ctx)  slot    │
  │   │                                  └─ renderPanels(ctx) slot    │
  │   │                                       │                       │
  │   │                                       ├─ Panel / Metric       │
  │   │                                       ├─ TracePanel  §01       │
  │   │                                       ├─ EvalPanel            │
  │   │                                       ├─ ProviderStatusPanel  │
  │   │                                       └─ ReviewPanel / History │
  │   │                                          (useReplayArtifacts §06)│
  │   │                                                              │
  │   └─ CapabilitiesWorkspace ──── (the one that does NOT use the   │
  │                                   shell — runs 4 previews in      │
  │                                   Promise.all, CapabilitiesWorkspace.tsx:118)│
  └──────────────────────────────────────────────────────────────────┘
```

Note the asymmetry: `CapabilitiesWorkspace` is the odd one out. It doesn't replay an agent against a fixture/provider mode, so it skips the shell entirely and runs four utility previews in parallel. That's the right call — forcing it into the shell's `F/M/R` generics would have been abstraction for its own sake.

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

  App                 view: StudioView          (the router)
   └ AgentReplayShell  selectedFixtureId, mode, providerStatus,
                       replay, liveTrace, running, runId, error
                       runCounter (ref, not state — §02)
      └ *Panels        comparison state (workspace-local)
         └ useReplayArtifacts  savedReplays, promotedFixtures,
                               saving, promoting, selectedReviewPath
                               (server-state-as-client-state — §06)
      └ TracePanel     filter: 'all'|'model'|'tools'|'warnings' (UI-only)
```

Server state (saved replays, promoted fixtures, provider availability) is fetched imperatively in `useEffect`, stored in `useState`, and manually re-fetched after mutations. No cache library. That's a deliberate fit for a single-user dev tool — covered in `audit.md` lens 4.

One build-mode wrinkle rides on top of all this network state: Studio ships in two shapes — the live dev server, and a **fixture-only static demo for GitHub Pages** (`npm run build:pages`). A compile-time flag `STATIC_DEMO` (`src/env.ts`) gates every fetch effect and mutation so the static build never calls an `/api/*` route that isn't there. It's woven through the shell, the artifact hook, and nine components — see `07-static-demo-gated-ui.md`.

## The three highest-leverage patterns

1. **Live stream consumption** (`01-live-stream-consumption.md`) — `apps/studio/src/api.ts:119-180`. Strip it out and the trace panel goes from a live ticker to a spinner that dumps everything at the end. This is the most interesting frontend mechanic in the repo.
2. **The shared replay shell** (`03-shared-replay-shell.md`) — `apps/studio/src/AgentReplayShell.tsx:48-254`. One generic component over `<F, M, R>` carries the run lifecycle, provider status, fixture/mode selectors, and the live-trace state for five workspaces. Strip it out and you'd hand-copy that lifecycle five times.
3. **The stale-run guard** (`02-stale-run-guard.md`) — `apps/studio/src/AgentReplayShell.tsx:97,107-116`. A `useRef` counter that discards stream events from a superseded run. Strip it out and re-running mid-stream interleaves two runs' trace events into one corrupted list.

## What Studio does NOT do (honest gaps)

SSR / RSC, react-router, any state library (Redux/Zustand/Jotai), React Query / SWR, CSS framework / CSS Modules / CSS-in-JS, route-level code-splitting, dark mode / theming tokens, and a deliberate accessibility pass are all **not yet exercised**. Most are correct omissions for a single-user local dev tool; `audit.md` lens 8 ranks the few that actually bite.

One more honest note about scope: the repo grew a new **`rag-query` agent** (`packages/agents/rag-query`) plus a retrieval package and a Gemma provider in the most recent work, but that capability has **no Studio page yet** — there's no `RagQueryWorkspace`, no fixtures wired into `vite.config.ts`, no card on `StudioHome`. It's **not yet exercised in the UI**. When it gets a Studio surface it will almost certainly drop into the same `AgentReplayShell` the other five agents share (`03-shared-replay-shell.md`), so this guide's patterns already cover it — there's just nothing frontend to study about it today.
