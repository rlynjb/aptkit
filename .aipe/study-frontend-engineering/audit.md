# audit.md — the 8-lens frontend audit

One pass over `apps/studio` (the repo's only frontend) against the frontend-engineering lens inventory. Every lens gets a verdict grounded in `file:line`, or an honest `not yet exercised`. Significant patterns cross-link to their Pass-2 file.

---

## 1. rendering-and-reactivity

**SPA, client-rendered, no SSR/SSG/RSC, no hydration.** One root mount: `createRoot(document.getElementById('root')!).render(<App/>)` at `apps/studio/src/main.tsx:44-45`. `index.html` ships an empty `<div id="root">` and a single module script (`index.html:9-10`) — everything is painted by React in the browser after the bundle loads.

Reconciliation is **stock React 18 virtual-DOM diffing**, synchronous default scheduling. No `startTransition`, no `useDeferredValue`, no Suspense boundaries anywhere in `src/`. Work happens at mount (each workspace fires `startReplay` in a mount `useEffect`, `AgentReplayShell.tsx:134-136`) and on update (every streamed trace event triggers a `setLiveTrace`, re-rendering the trace list).

The one reactivity subtlety worth naming: the live trace re-renders on **every** streamed event via `setLiveTrace((current) => [...current, event])` (`AgentReplayShell.tsx:116`). Each event allocates a new array and re-renders `TracePanel` and its filter. For traces of ~10-50 events this is invisible; it would matter at thousands. Cross-link the event-loop interleaving to `study-runtime-systems`; the per-event re-render *cost* to `study-performance-engineering`. The browser-consumption mechanism is `01-live-stream-consumption.md`.

## 2. state-architecture

**All local `useState`, lifted to the workspace, plus one generic hook. No global store.** The state graph:

- **Router state** — `view: StudioView` in `App()` (`main.tsx:14`). URL state is *not* used (see lens 5).
- **Shell run state** — `selectedFixtureId`, `mode`, `providerStatus`, `replay`, `liveTrace`, `running`, `runId`, `error` all in `AgentReplayShell` (`AgentReplayShell.tsx:85-96`). This is the source of truth for a replay; it's lifted exactly as high as it needs to be (the shell) and no higher.
- **Run- identity** — `runCounter` is a `useRef`, deliberately *not* state (`AgentReplayShell.tsx:97`). It's mutated synchronously and read in callbacks; making it state would cause spurious renders and stale closures. This is the load-bearing detail — see `02-stale-run-guard.md`.
- **Server state as client state** — `useReplayArtifacts` (`useReplayArtifacts.ts:13`) owns `savedReplays`, `promotedFixtures`, and their loading/error flags. Fetched in `useEffect`, manually invalidated by calling `refreshReplayHistory()` after a save (`useReplayArtifacts.ts:111`). See `06-replay-artifact-hook.md`.
- **Build-mode capability gate** — `STATIC_DEMO` (`env.ts:1`) is a compile-time boolean read from `import.meta.env.VITE_STATIC_DEMO`. It's not React state, it's a build-time constant, but it short-circuits state-mutating effects and handlers: the provider-status fetch (`AgentReplayShell.tsx:139`), the history/promoted fetches (`useReplayArtifacts.ts:77,94`), and the save/promote mutations (`useReplayArtifacts.ts:100,120`) all early-return when it's set. The fixture-only Pages build thus never reaches for the absent backend. See `07-static-demo-gated-ui.md`.
- **Derived state** — computed inline, not stored: `visibleTrace = replay?.trace ?? liveTrace` (`AgentReplayShell.tsx:163`), `usage = summarizeUsage(visibleTrace)` (`:164`), `costEstimate` (`:166`). Correct — these are pure functions of state, so they're recomputed each render rather than duplicated into state.
- **Form/URL state** — none. The fixture `<select>` (`AgentReplayShell.tsx:211`) is a controlled input bound to `selectedFixtureId`, the only form element of note.

Source-of-truth discipline is clean: the shell owns the run, the hook owns the artifact history, panels are mostly presentational. Cross-link system-level state ownership to `study-system-design`.

## 3. component-architecture

**Render-prop composition over one deep generic shell.** The defining pattern: `AgentReplayShell<F, M, R extends ReplayResultBase>` (`AgentReplayShell.tsx:48`) is parameterized over fixture, mode, and result types, and takes two render-prop slots — `metricItems(context)` and `renderPanels(context)` (`:70, :76`) — plus two runner callbacks `runFixture` / `runServer` (`:77-83`). Each workspace is a thin adapter: `RecommendationWorkspace` is ~25 lines of config (`RecommendationWorkspace.tsx:23-47`) that hands the shell its fixtures, modes, metric renderer, and panel renderer. Five workspaces share this. See `03-shared-replay-shell.md`.

Below the shell, components are **presentational and small**: `Panel`, `Metric`, `ModeButton`, `ReplayModeSwitch`, `AgentStatusPanel`, `TracePanel`, `EvalPanel`, `ProviderStatusPanel` all live in `components.tsx`. `Panel` (`components.tsx:67`) is the universal container (title + icon + children, optional `wide`). `ReplayModeSwitch` (`components.tsx:38`) is a small generic-over-`M` headless-ish selector. Workspace-specific panels split into `recommendation-panels.tsx` and `monitoring-panels.tsx`.

Container-vs-presentational discipline holds: workspaces and the shell are containers (own state, fire effects); `components.tsx` is presentational (props in, JSX out). The one leak: panels reach into `navigator.clipboard.writeText` directly (`MonitoringWorkspace.tsx:241`, `recommendation-panels.tsx:289`) — a platform side-effect inside a render component rather than a passed handler. Minor. Cross-link module/interface depth to `study-software-design`.

## 4. data-fetching-and-cache

**Hand-rolled `fetch` wrappers, no query library, manual invalidation.** All network access is in `api.ts`. Two shapes:

1. **JSON request/response** — `loadProviderStatus`, `loadSavedReplays`, `promoteReplay`, `saveReplayArtifact`, etc. (`api.ts:10-17, 193-328`). Plain `fetch` → `response.json()` → throw on `!response.ok`. No retry, no dedup, no cache.
2. **Streaming NDJSON** — `runReplayStream` (`api.ts:119-166`), the interesting one. POST, read `response.body` as a `ReadableStream`, decode incrementally. See lens 1 and `01-live-stream-consumption.md`.

**Cache strategy: none, by design.** Server state is fetched into `useState` and re-fetched after mutations. After a save, `saveCurrentReplay` calls `await refreshReplayHistory()` (`useReplayArtifacts.ts:111`); after a promote, it refreshes the same way. This is manual cache invalidation — correct for a single-user local tool where there's no second client to go stale against, and a query library (React Query / SWR) would be ceremony. **`react-query` / `SWR` / route loaders / RSC streaming: not yet exercised.** The entire fetch path is also gated by the `STATIC_DEMO` build flag — in the Pages build, `saveCurrentReplay`/`promoteSavedReplay` short-circuit to a "local dev only" note (`useReplayArtifacts.ts:100,120`) instead of POSTing to an `/api/*` route that doesn't exist there (lens 7; `07-static-demo-gated-ui.md`).

No optimistic updates and no rollback — mutations show a `saving`/`promoting` flag, await the server, then refetch (`06-replay-artifact-hook.md`). Error behavior is per-call try/catch into an error-string state slot (`useReplayArtifacts.ts:105-108`). Cross-link wire semantics to `study-networking`, cache-as-architecture to `study-system-design`.

## 5. routing-and-navigation

**Hand-rolled router: a single `useState<StudioView>` switch. No react-router, no URL, no history.** `App()` holds `const [view, setView] = useState<StudioView>('home')` and returns one of seven components based on `view` (`main.tsx:13-41`). Navigation is `onOpen(view)` / `onHome(() => setView('home'))` passed as props. See `04-hand-rolled-router.md`.

Consequences, named honestly: **no deep-linking** (you always land on `home`, can't bookmark a workspace), **no back-button** integration (browser back leaves the app), **no scroll restoration**, **no route guards**. For a 7-view single-user dev tool launched fresh each session, this is the right call — react-router would add a dependency and a URL contract for zero benefit. **react-router / nested routes / route-level code-splitting / prefetch / route loaders: not yet exercised.** There is no `React.lazy` anywhere, so every workspace's code is in the initial bundle (lens 7).

## 6. styling-and-design-system

**Single hand-written CSS file, BEM-ish flat class names, no framework.** `apps/studio/src/styles.css` (1840 lines) is imported once at `main.tsx:11` and applies globally. Class names are semantic and flat: `.shell`, `.topbar`, `.modeSwitch`, `.metric`, `.panel`, `.traceItem`, `.reviewBanner` — referenced as string literals in `className` throughout. No CSS Modules (no `styles.x`), no CSS-in-JS, no Tailwind utility classes, no `clsx`.

There are a few **hardcoded design tokens by repetition, not by variable**: the palette (`#1d2420`, `#f5f7f4`, `#cfd8d1`, etc.) is set in `:root` (`styles.css:1-9`) for the base colors, but most component colors are inlined per-rule rather than pulled from CSS custom properties. So the "design system" is convention, not enforced tokens — changing the accent color is a find-and-replace, not a one-line variable edit.

Responsive strategy is minimal: `min-width: 320px` on `body` (`styles.css:17`), grid layouts with `minmax()` (`.modeSwitch` at `:46`), and the three-column `.layout` is the dominant structure. Conditional layout via `modeClassName` — e.g. two-provider workspaces pass `monitoringModeSwitch` to collapse the mode grid from 3 to 2 columns (`MonitoringWorkspace.tsx:34`, `styles.css:55-57`). **Dark mode / brand theming / design tokens / container queries / animation system: not yet exercised.** Theming scales by convention only — fine at this size, would not scale to dozens of contributors. Cross-link bundle-size *measurement* to `study-performance-engineering`.

## 7. browser-platform-and-build

**Web APIs actually touched:**
- **`fetch` + `ReadableStream` + `reader.getReader()`** — the streaming consumer (`api.ts:170-179`). The most load-bearing platform API in the app.
- **`TextDecoder`** — decodes `Uint8Array` chunks to text across chunk boundaries inside the runtime decoder (`packages/runtime/src/ndjson-stream.ts:107,113`).
- **`navigator.clipboard.writeText`** — copy-command buttons (`recommendation-panels.tsx:289`, `MonitoringWorkspace.tsx:241`). No fallback if the API is absent or the page is non-secure-context — a minor gap (lens 8).
- **`window.setTimeout`** — the "copied" toast reset (`recommendation-panels.tsx:291`).
- **`performance.now()`** — client-side fixture-replay timing (`agent-runners.ts:12`).
- **`window.__aptkitStudioRoot`** — an HMR guard stashing the root on `window` so Vite hot-reload doesn't double-mount (`main.tsx:43-44`). Nice touch.

**No `localStorage` / `sessionStorage` / `IndexedDB` / `Worker` / `ServiceWorker` / `WebSocket` / `EventSource`.** Notable: the live stream uses chunked `fetch` + NDJSON, *not* `EventSource`/SSE — a deliberate choice because the transport is a POST with a JSON body, which `EventSource` (GET-only) can't do. Cross-link to `study-networking`.

**Build: Vite 8 + `@vitejs/plugin-react` 6.** `package.json:35-36`. `build` is `tsc -b && vite build` (`package.json:8`). The single most interesting build detail is the **custom Vite plugin `aptkit-studio-api`** (`vite.config.ts:199-527`): a `configureServer` middleware that mounts ~20 dev-only API routes — the streaming replay endpoints, save/promote, fixture listing — running the actual agent packages in the Vite Node process. So in dev, the "backend" is the Vite server. React 18.3, lucide-react 0.468 for icons. **Code-splitting / tree-shaking config / polyfills / sourcemap config: not explicitly configured** — defaults only; no `build.rollupOptions`, no `React.lazy`, so the bundle is monolithic.

**Two deploy targets, one bundle.** There *is* a non-dev build target now: a fixture-only static demo for GitHub Pages. `build:pages` runs `vite build --mode pages` (`package.json:9`), which loads `VITE_STATIC_DEMO=1` from `.env.pages` and sets `base: '/aptkit/'` so asset URLs resolve under the project-pages path (`vite.config.ts:196`). There's still no production *server* — the Pages artifact is pure static files with no `/api/*` routes behind it. The UI handles the missing backend through a build-time flag (`STATIC_DEMO`, `src/env.ts`) that gates every network-touching button and effect; see `07-static-demo-gated-ui.md`. The `configureServer` middleware is dev-only and does not ship in either build.

## 8. frontend-red-flags-audit

Ranked by user-visible consequence. Studio is a single-user dev tool, so several "red flags" are deliberate non-issues — flagged as such.

1. **`navigator.clipboard` with no fallback** (`recommendation-panels.tsx:289`, `MonitoringWorkspace.tsx:241`). If the API is unavailable (non-secure context, older browser) the copy button throws an unhandled rejection — the `void copyCommand(...)` swallows it silently and the toast never fires, leaving no feedback. Low impact (localhost is a secure context) but a real silent failure. **Fix:** guard `navigator.clipboard?.writeText` and fall back to a `document.execCommand` or a visible "copy manually" state.
2. **Per-event trace re-render is unbounded** (`AgentReplayShell.tsx:116`). `setLiveTrace(c => [...c, event])` re-renders the full trace list on every streamed event. Fine at tens of events; if an agent ever streamed thousands, the UI would jank. Currently a non-issue given fixture sizes. **Fix if it bites:** batch events per animation frame, or virtualize the trace list.
3. **No URL state / deep-linking** (lens 5). You can't share or bookmark a workspace, and browser-back exits the app. Deliberate for a dev tool, but the cheapest future upgrade if Studio ever gets multiple users — hang `view` off `location.hash`.
4. **Design tokens by repetition, not variables** (lens 6). Color values are inlined across 1840 lines of CSS rather than centralized in custom properties. A theme change is a risky find-and-replace. Non-issue at one contributor; debt if the team grows.
5. **No accessibility pass.** Cards use `role="button"` + `tabIndex={0}` + Enter/Space handlers (`StudioHome.tsx:117-131`) — that part is done right. But the live trace region has no `aria-live` (`aria-label` only, `components.tsx:137`), so streamed events are invisible to screen readers. The fixture `<select>` and metric regions are labeled. Partial, not absent. **a11y audit: not yet exercised** as a deliberate pass. (For the dedicated audit, see `aipe:audit-frontend-a11y`.)

None of these are correctness bugs in the run/replay path. The run lifecycle, the stream consumption, and the stale-run guard are solid.
