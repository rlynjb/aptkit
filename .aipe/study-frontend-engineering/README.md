# Study — Frontend Engineering (AptKit Studio)

The frontend layer of this repo is exactly one app: `apps/studio` — a React 18 + Vite preview/replay UI for the agent capabilities packaged in the monorepo. There is no other frontend. So this guide is a deep read of one well-shaped SPA, not a survey of many surfaces.

What makes Studio worth studying is not the framework choices (vanilla React 18, hooks, CSS-in-file) — those are the boring, correct defaults. What's worth studying is the **handful of patterns it leans on hard**: consuming a chunked NDJSON response in the browser and painting trace events live, a hand-rolled `useState` router, one generic `AgentReplayShell` composed across six panels via render props, and a stale-run guard that keeps an interleaved stream from corrupting the UI.

This is your home turf (7+ years Vue/React). No on-ramp. The files below lead with what's non-obvious in *this* repo.

## Reading order

1. **`00-overview.md`** — one page. Rendering mode in a sentence, the component tree, the stream→state→render data flow, the three highest-leverage patterns named with file paths. Skim only this and you know what Studio is.
2. **`audit.md`** — Pass 1. The 8-lens frontend audit. Every lens named against real `file:line` evidence, with `not yet exercised` called honestly (and there's a lot of it — Studio is a dev tool, not a product surface).
3. The pattern files (Pass 2), in dependency order:
   - **`01-live-stream-consumption.md`** — the load-bearing mechanic. Browser `ReadableStream` → runtime NDJSON decoder → incremental `setState` → live trace render.
   - **`02-stale-run-guard.md`** — the `runCounter` ref that makes the live stream safe under re-runs. The part everyone forgets.
   - **`03-shared-replay-shell.md`** — one generic component (`AgentReplayShell<F, M, R>`) driving five of the six workspaces via render-prop slots.
   - **`04-hand-rolled-router.md`** — routing as a single `useState<StudioView>` switch in `App()`. No react-router. Why that's the right call here.
   - **`05-fixture-provider-mode-switch.md`** — the fixture→anthropic→openai mode state machine and the provider-availability gating that rides on it.
   - **`06-replay-artifact-hook.md`** — `useReplayArtifacts`, the generic hook that owns the save→load→promote server-state lifecycle.
   - **`07-static-demo-gated-ui.md`** — the `STATIC_DEMO` build flag that ships the same bundle to a live dev server and a static GitHub Pages demo, gating every backend-touching button and effect.

## Cross-links to neighboring guides

The partition is sharp. This guide owns the **framework-and-platform layer**. Mechanism-level teaching lives next door:

- **`study-networking`** — the NDJSON wire format, chunked transfer, `content-type: application/x-ndjson`, the `x-accel-buffering: no` header that defeats proxy buffering. The bytes on the wire are theirs; how the browser *consumes* them into UI state is ours (`01-live-stream-consumption.md`).
- **`study-system-design`** — `ndjson-stream-handoff` and `client-stream-handoff` patterns. Where the trace stream originates server-side and the contract across the boundary. We pick it up at `fetch().body`.
- **`study-runtime-systems`** — the `for await...of` async-iterator consumption, the event-loop interleaving of stream chunks with React renders, `TextDecoder` statefulness across chunk boundaries. The execution model is theirs; the UI consequence is ours.
- **`study-performance-engineering`** — bundle size, FCP/LCP as numbers, the re-render cost of `[...current, event]` per trace event.
- **`study-software-design`** — module depth of `AgentReplayShell` and `useReplayArtifacts` as deep generic modules.
- **`study-security`** — the `resolveReplayPath` traversal guard, `.env` key handling. Trust boundaries are theirs.
