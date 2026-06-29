# Frontend audit — `apps/studio/`

Pass 1 of the audit-style output: the 8 frontend-engineering lenses, each walked
against real `file:line` evidence. Where the repo doesn't exercise a lens, it
says `not yet exercised` — no invented patterns. Significant findings cross-link
to their Pass-2 pattern file.

The subject is **Studio** (`apps/studio/`): React `^18.3.1`, Vite `^8.0.16`,
`@vitejs/plugin-react` `^6`, TypeScript, ESM. UI deps are deliberately tiny:
`lucide-react` (icons), `react-markdown` + `remark-gfm` + `rehype-slug` +
`github-slugger` (docs). No router, state, or data-fetching libraries.

---

## 1. rendering-and-reactivity

**Mode: client-only SPA. Virtual-DOM, synchronous default reactivity. No SSR /
SSG / RSC / hydration / concurrent features.**

- Single mount: `createRoot(document.getElementById('root')!).render(<App />)`
  at `main.tsx:119`. The root is memoized onto `window.__aptkitStudioRoot`
  (`main.tsx:118`) so Vite HMR re-renders into the same root instead of
  creating a second one — a small, deliberate HMR-correctness touch.
- `index.html` is a bare shell — `<div id="root">` + `<script type="module"
  src="/src/main.tsx">`. Everything renders client-side after JS executes.
- Reconciliation is stock React 18 virtual-DOM diffing. No `startTransition`,
  no `useDeferredValue`, no `Suspense` anywhere (grep: zero hits). No
  `useMemo`/`useCallback` micro-tuning beyond two spots:
  `DocPage.tsx:46` memoizes the TOC parse, and `AgentReplayShell.tsx:104`
  wraps `startReplay` in `useCallback` because it's an effect dependency.
- Work happens on **mount and on state-set**: each workspace kicks a replay
  either on a button click or, for the shell agents, on mount via
  `useEffect(() => { void startReplay(); }, [startReplay])`
  (`AgentReplayShell.tsx:134`).
- Runtime event-loop / scheduling mechanics → `study-runtime-systems`.

`not yet exercised`: SSR, streaming SSR, islands, server components, resumability,
concurrent rendering, transitions.

---

## 2. state-architecture

**Local `useState` per screen + one global state (the URL hash) + one custom
workflow hook. No store, no Context for app data, no server-state cache.**

The full state graph is drawn in `00-overview.md`. By category:

- **URL state (the only global):** `parseHash()` (`main.tsx:34-42`) is the
  source of truth for *which screen*; `App` mirrors it into
  `useState(parseHash)` (`main.tsx:45`) and resubscribes via a `hashchange`
  listener (`main.tsx:47-51`). → `01-hash-router-with-section-anchors.md`.
- **Local component state:** every workspace owns its own ephemeral run state.
  `RagQueryWorkspace.tsx:9-13`: `selectedId / result / running / error /
  runId`. Thrown away on unmount; no lifting, no persistence.
- **Shared shell state:** `AgentReplayShell.tsx:85-96` holds `selectedFixtureId
  / mode / providerStatus / replay / liveTrace / running / runId / error` for
  the four analytics agents. Refs (`runCounter`, `selectedFixtureRef`,
  `modeRef`, `lines 97-99`) guard against stale closures when async replays
  land out of order — the one genuinely subtle bit of state handling here
  (`AgentReplayShell.tsx:116` drops trace events whose `runId` is stale).
- **Server-history state:** `useReplayArtifacts.ts` (`:14`) is the only hook
  that owns server-derived state (saved replays, promoted fixtures). Every
  effect in it is gated `if (STATIC_DEMO) return;` (`:77, :94, :100, :120`) so
  the static Pages demo never touches the network.
- **Derived state:** computed inline, not stored — `precisionLabel`
  (`RagQueryWorkspace.tsx:32`), `usage`/`modelName`/`costEstimate`
  (`AgentReplayShell.tsx:164-166`). Recomputed each render; cheap.
- **Source-of-truth enforcement:** `runId`/`runCounter` is the discipline —
  bump a counter, force a fresh derive, ignore late async writes.

System-level state ownership (the fixture/promote loop, where data persists) →
`study-system-design`.

`not yet exercised`: global store (Redux/Zustand/Jotai), Context for app data,
server-state cache library (react-query/SWR), form-state library, optimistic
updates with rollback, URL *query-param* state (only the hash is used).

---

## 3. component-architecture

**Container-vs-presentational split, plus one render-prop "headless" host. Modest
but real composition discipline.**

- **Presentational primitives** live in `components.tsx`: `Metric` (`:8`),
  `Panel` (`:68`), `ModeButton` (`:18`), `ReplayModeSwitch` (`:39`),
  `TracePanel` (`:131`), `EvalPanel` (`:184`), `AgentStatusPanel` (`:80`),
  `PromptPackagePanel` (`:211`). Pure props-in, JSX-out. `Panel` is the
  layout atom every workspace composes from.
- **Container components** are the workspaces (`RecommendationWorkspace`,
  `MonitoringWorkspace`, `DiagnosticWorkspace`, `QueryWorkspace`,
  `RubricImprovementWorkspace`, `RagQueryWorkspace`) — each owns state and
  data flow, delegates rendering to the primitives.
- **The headless/render-prop host:** `AgentReplayShell` (`AgentReplayShell.tsx:48`)
  is generic over `<F, M extends string, R extends ReplayResultBase>` and takes
  `metricItems` and `renderPanels` as render-prop functions receiving a typed
  `context`. It owns *all* the shared behavior (run loop, mode switch, fixture
  select, provider status, stale-run guarding) and lets each agent inject only
  its own panels. This is the closest thing to a compound/headless pattern in
  the repo. → `04-generic-replay-shell.md`. Module-depth argument →
  `study-software-design`.
- **Boundary placement:** panel files are split by agent
  (`recommendation-panels.tsx`, `monitoring-panels.tsx`) when they got large
  (470 / 436 lines) — a pragmatic split, not a design-system layer.
- `CapabilityCard` (`StudioHome.tsx:196`) is a presentational card with
  keyboard handling (`role="button"`, `tabIndex={0}`, Enter/Space →
  `onOpen`, `:211-216`) — accessibility done by hand since it's a `<article>`,
  not a `<button>`.

`not yet exercised`: slot/children-composition beyond `Panel`'s `children`,
true compound-component APIs (`<Tabs.Item>`), context-based component
coordination, a published/shared design-system package.

---

## 4. data-fetching-and-cache

**Raw `fetch` + one NDJSON decode helper. No query library. The only fetches are
dev-only and severed in the static build.**

- All network code is in `api.ts`. Reads: `loadProviderStatus` (`:10`),
  `loadSavedReplays` (`:206`), `loadPromotedFixtures` (`:294`), and siblings.
  Writes: `saveReplayArtifact` (`:193`), `promoteReplay` (`:242`).
- **Streaming reads** go through `runReplayStream` (`api.ts:119`): POST
  `{fixtureId, mode}`, then iterate `decodeNdjsonStream(...)` over the response
  body, dispatching `{type:'event'}` records to an `onEvent` callback so the
  trace renders **line-by-line as the agent runs** (`api.ts:138-161`). The
  browser `ReadableStream` is adapted to the runtime's async-iterable decoder
  by `responseBodyChunks` (`api.ts:169`). Wire semantics → `study-networking`.
- **Error handling:** every fetch checks `response.ok` and throws
  `payload?.error ?? '<fallback>'`; callers catch into local `error` state.
  No retry, no backoff, no timeout, no abort/`AbortController`.
- **Cache:** none. There is no client cache to invalidate; each run recomputes.
  History is re-fetched explicitly via `refreshReplayHistory`
  (`useReplayArtifacts.ts:64`) after a save.
- **The static-demo cut:** in the Pages build `STATIC_DEMO` is `true`
  (`env.ts:1`), so `useReplayArtifacts` skips all fetch effects and the
  RagQuery / shell screens replay from inlined fixtures instead. The deployed
  app makes **zero network calls**.

`not yet exercised`: react-query/SWR, route loaders, optimistic mutations,
cache invalidation strategy, request dedup, retry/backoff, `AbortController`
cancellation, pagination/infinite-scroll.

---

## 5. routing-and-navigation

**Hand-rolled hash router, ~40 lines, no library. Deep-links into doc sections
via a `view/section` hash grammar.**

- `parseHash()` (`main.tsx:34`) strips `#`/`#/`, splits on the first `/` into
  `{view, anchor}`. `navigate()` (`main.tsx:53`) writes `window.location.hash`,
  which fires `hashchange` → `setRoute`. The `view` is validated against a
  `VIEW_TOKENS` allowlist (`main.tsx:23-32`); anything unknown falls to
  `'home'`. → `01-hash-router-with-section-anchors.md`.
- **Why hash and not history API:** the GitHub Pages deploy is static with no
  SPA 404 fallback and is served under `/aptkit/` — a real path router would
  404 on refresh. The comment at `main.tsx:18-22` states this explicitly. This
  is the *right* call, not a shortcut.
- **Deep-linking:** the `section` after the slash
  (`#api-docs/conversation-memory`) is a markdown heading slug.
  `DocPage` scrolls to it after layout via `requestAnimationFrame`
  (`DocPage.tsx:50-56`), and `StudioHome` deep-links into doc sections by
  slugging headings the same way `rehype-slug` does (`StudioHome.tsx:10`,
  `:181`). → `02-build-time-markdown-docs.md`.
- **Navigation lifecycle:** instant — no prefetch, no transitions, no route
  suspense. Swapping `view` swaps the rendered component synchronously
  (`main.tsx:65-115`).
- **Scroll restoration:** only the deep-link scroll-into-view; no general
  scroll restoration across navigations.

`not yet exercised`: route-level code-splitting (single chunk — see lens 7),
nested/layout routes, route guards/redirects, prefetch-on-hover, view
transitions, query-param routing.

---

## 6. styling-and-design-system

**One hand-written `styles.css` (~1180 lines), reincodes-style monochrome dark
theme. Colors are hardcoded hex, transformed by author-time scripts. No design
tokens, no CSS variables.**

- **Architecture:** a single global stylesheet (`src/styles.css`) imported once
  (`main.tsx:14`). Class names are conventional BEM-ish camelCase (`.shell`,
  `.topbar`, `.capabilityCard`, `.ragChunk`). No CSS Modules, no CSS-in-JS, no
  utility framework.
- **Theme:** monochrome dark — `#0a0a0a` bg, `#ededed` text
  (`styles.css:6-12`), **purple titles `#a78bfa`** (`:191, :461, :511, :606`),
  **red accent `#ef4444`** for hover/error (`:14, :104`). `color-scheme: dark`
  set on `html` (`:1`).
- **The interesting bit — theming is a *script*, not tokens:** there are **zero
  CSS custom properties** (grep `var(--`: 0). The palette was produced by
  running `scripts/darkify-theme.mjs` (invert lightness, keep hue) then
  `scripts/reincodes-theme.mjs` (desaturate everything except red) which
  *rewrite the hex literals in `styles.css` in place*. → `06-scripted-theme-transform.md`.
  Consequence: runtime theme switching is impossible without re-running a
  script and rebuilding; this is a build/author-time theme, not a runtime one.
- **Full-bleed sticky header:** `.topbar` is `position: sticky` with negative
  margins to bleed to the shell edge (`styles.css:51-64`), plus a
  `::before` pseudo-element at `width: 100vw; left: 50%; translateX(-50%)`
  (`:68-78`) to paint the black bar edge-to-edge behind container-aligned
  content. `html { overflow-x: hidden }` (`:3`) prevents the 100vw bleed from
  causing horizontal scroll. → `06-…` (covered as a sibling technique).
- **Layout widths:** `.shellNarrow` 720px (home), `.shellDoc` 1120px (docs),
  full-width otherwise (`styles.css:39-49`) — the reincodes column layout.
- **Responsive:** only **3 `@media` queries** in the whole stylesheet. Largely
  a desktop-first fixed-column layout; mobile is not a first-class target.
- **Animation:** **zero** `transition`/`@keyframes`/`animation` rules. Static UI.

`not yet exercised`: design tokens, CSS variables, runtime theme switching,
container queries, fluid type, an animation system, a component style library,
dark/light toggle (it's dark-only).

---

## 7. browser-platform-and-build

**Web APIs touched: `location.hash` + `hashchange`, `requestAnimationFrame`,
`navigator.clipboard`, `fetch` + `ReadableStream`. Bundler: Vite. Single chunk,
no code-splitting.**

- **Platform APIs actually used:**
  - `window.location.hash` + `hashchange` — routing (`main.tsx`).
  - `requestAnimationFrame` / `cancelAnimationFrame` — scroll-after-layout in
    `DocPage.tsx:52-55`.
  - `navigator.clipboard.writeText` — copy-command buttons
    (`recommendation-panels.tsx:292`, `MonitoringWorkspace.tsx:242`). Used
    *without* a fallback or permission check — minor red flag (lens 8).
  - `fetch` + `ReadableStream` reader — streaming replay (`api.ts:126, :169`),
    dev-only.
  - `performance.now()` — duration timing (`agent-runners.ts:14, :168`).
- **Build:** `vite build` (`tsc -b && vite build`, `package.json`). Two modes:
  default (`base: '/'`, dev middleware) and `--mode pages` which loads
  `.env.pages` (`VITE_STATIC_DEMO=1`) → `base: '/aptkit/'`
  (`vite.config.ts:196`) and severs all server calls.
- **Fixtures are build input:** agent fixtures (`fixtures.ts:2-8`) and docs
  (`main.tsx:12-13` via `?raw`) are *imported*, so Vite inlines them into the
  bundle at build time — that's what makes the zero-backend Pages demo
  possible. → `05-fixture-as-build-input.md`, `02-build-time-markdown-docs.md`.
- **Dev-only API:** a Vite plugin (`vite.config.ts:197+`) registers
  `/api/model-status`, `/api/stream/*/replay`, `/api/replays`,
  `/api/*/promote` middleware that run the real agents in Node and stream
  NDJSON. None of this ships to Pages.
- **Output shape:** a single JS chunk + single CSS file (`dist/assets/` →
  `index-*.js`, `index-*.css`). **No code-splitting, no lazy chunks** (grep:
  no `React.lazy`, no `import(`). Fine at this size; named as a limitation.
- Bundle-size *measurement* (FCP/LCP/TTI as numbers) → `study-performance-engineering`.

`not yet exercised`: Web Workers, Service Workers / offline, IndexedDB,
`localStorage`/`sessionStorage`, WebSocket, `EventSource`, MediaRecorder,
`IntersectionObserver`, code-splitting, prefetch, route-level lazy loading.

---

## 8. frontend-red-flags-audit

Ranked by user-visible / correctness consequence. Each grounded; each with the
move.

1. **No `AbortController` on streaming replays — late runs can clobber the UI.**
   `runReplayStream` (`api.ts:119`) has no cancellation. The *shell* defends
   against this with a `runCounter` ref that drops stale trace events
   (`AgentReplayShell.tsx:116`), but the standalone `RagQueryWorkspace`
   (`:17-30`) has no such guard — fire two runs fast and the slower one's
   result can land last. Low real-world impact (deterministic, fast), but it's
   a correctness gap. **Move:** thread an `AbortController` through `fetch` and
   abort on new run / unmount; or apply the same `runId` guard the shell uses.

2. **`navigator.clipboard` used without a fallback.** `recommendation-panels.tsx:292`
   and `MonitoringWorkspace.tsx:242` call `navigator.clipboard.writeText`
   directly. On insecure contexts or older browsers `navigator.clipboard` is
   `undefined` and the click throws unhandled. **Move:** guard
   `navigator.clipboard?.writeText` and fall back to a `document.execCommand`
   or a "copy this" textarea, or at least catch.

3. **Theme can't change at runtime — colors are baked hex.** Zero CSS variables
   (lens 6); the palette is rewritten into `styles.css` by a script. A
   light-mode toggle or per-user theme is impossible without a rebuild. **Move:**
   promote the palette to CSS custom properties on `:root` so the scripts set
   variables once and runtime theming becomes a class swap. Acceptable today —
   it's a single-theme demo — but it's the ceiling on the styling layer.

4. **`buildToc` is a hand-rolled markdown-heading regex parser.**
   `DocPage.tsx:11-27` re-parses the markdown with a regex (tracking fenced
   code blocks by hand at `:16-19`) to build the TOC, *separately* from
   `react-markdown`'s own parse. Two parsers over the same string can drift;
   an edge-case heading (setext `===`, headings inside HTML) is parsed by one
   and not the other. **Move:** derive the TOC from a `rehype` plugin that
   walks the same AST `react-markdown` already builds, so there's one parse.

5. **Single bundle blocks first paint with everything.** No code-splitting
   (lens 7) means the docs markdown, all six workspaces, and every panel ship
   in one chunk even when the user only opens home. Small today; grows linearly
   with each new agent. **Move:** `React.lazy` the workspace + DocPage modules
   behind the router so home paints with a minimal chunk. Measure first —
   → `study-performance-engineering`.

6. **`CapabilityCard` is a clickable `<article>`, not a `<button>`.**
   `StudioHome.tsx:218-225` adds `role="button"`, `tabIndex={0}`, and manual
   Enter/Space handling — correct, but reimplements what a native button gives
   free, and the inner `<h2>` inside a `role="button"` is a minor a11y smell.
   **Move:** a real `<button>` wrapping the card content. (Full a11y pass →
   `audit-frontend-a11y`.)

`not yet exercised` as risks (because the feature isn't there): XSS via
`dangerouslySetInnerHTML` (none — `react-markdown` sanitizes by default, grep
confirms no `dangerouslySetInnerHTML`); token storage in `localStorage` (no
auth in the client); re-render storms from un-memoized context (no context).
Security trust boundaries → `study-security`.
