# Frontend audit — AptKit Studio (Pass 1)

The 8-lens frontend audit of `apps/studio/`. Each lens names what Studio actually does,
grounded in `file:line`, or emits `not yet exercised`. Significant patterns cross-link to
their Pass 2 file. This is home turf — findings are stated directly, no on-ramp.

The whole frontend is one app: `apps/studio/`, React `^18.3.1` + Vite `^8.0.16` +
TypeScript, mounted once at `src/main.tsx:118-120`. Dependencies that matter to this audit:
`react-markdown ^9.1.0`, `remark-gfm ^4.0.1`, `rehype-slug ^6.0.0`, `github-slugger ^2.0.0`,
`lucide-react ^0.468.0` (`apps/studio/package.json`).

---

## 1. rendering-and-reactivity

**Verdict: pure client-rendered SPA, virtual-DOM diffing, synchronous (no concurrent
features).** React 18 is on the `createRoot` API (`main.tsx:119`) but nothing uses
`startTransition`, `useDeferredValue`, `Suspense`, or `useTransition`. Reconciliation is
the default virtual-DOM diff; work happens on mount and on `setState`.

One detail worth naming: the root is cached on `window` to survive Vite HMR without
double-mounting —

```ts
// main.tsx:118-120
const rootHost = window as Window & { __aptkitStudioRoot?: ReturnType<typeof createRoot> };
rootHost.__aptkitStudioRoot ??= createRoot(document.getElementById('root')!);
rootHost.__aptkitStudioRoot.render(<App />);
```

The one place rendering interacts with the browser's layout/paint timing is `DocPage`:
after the markdown renders, an effect uses `requestAnimationFrame` to scroll to the target
heading once layout has settled (`DocPage.tsx:50-56`). That rAF is the only scheduling
primitive in the app — cross-link the event-loop / rAF mechanism to `study-runtime-systems`.

- **SSR / SSG / RSC / hydration / islands:** `not yet exercised`. The Pages build is a
  static SPA bundle, not server-rendered HTML.
- **Concurrent / suspending rendering:** `not yet exercised`.

---

## 2. state-architecture

**Verdict: `useState` everywhere, plus URL state in the hash. No global store, no derived-
state library, no server-state cache.** This is the most opinionated choice in the frontend
and it holds up — Studio has no cross-page shared state to justify a store.

The state graph, by category:

- **URL state (the source of truth for navigation):** the active view + doc anchor live in
  `window.location.hash`. `parseHash()` (`main.tsx:34-42`) decodes `#view/section` into
  `{ view, anchor }`; a `hashchange` listener pushes it into React state
  (`main.tsx:47-51`). → see `01-hash-routing-with-section-anchors.md`.
- **Lifted route state:** `App` holds `route` (`main.tsx:45`) and passes `navigate` down to
  every view as `onOpen` / `onHome`. One level of lifting, no Context.
- **Local component state:** each workspace owns its own `useState` — e.g.
  `RagQueryWorkspace` holds `selectedId`, `result`, `running`, `error`, `runId`
  (`RagQueryWorkspace.tsx:9-14`); `AgentReplayShell` holds `replay`, `liveTrace`, `mode`,
  `running`, `error`, plus refs (`AgentReplayShell.tsx:85-99`).
- **Derived state:** computed inline at render, not stored — `usage`, `modelName`,
  `costEstimate` are recomputed from `visibleTrace` every render
  (`AgentReplayShell.tsx:163-166`); `DocPage`'s TOC is the one memoized derivation
  (`useMemo`, `DocPage.tsx:46`).
- **Reusable stateful logic:** `useReplayArtifacts` (`useReplayArtifacts.ts:14-164`) is a
  custom hook bundling save/promote/history state for the dev-only artifact workflow.

- **Global store (Redux / Zustand / Context store):** `not yet exercised`.
- **Server-state cache (react-query / SWR):** `not yet exercised` — every replay is one-shot.
- **Form state library:** `not yet exercised` — the only inputs are `<select>` dropdowns
  bound to `useState`.

---

## 3. component-architecture

**Verdict: container/presentational split, with one genuinely deep generic component
carrying the analytics agents.** The five analytics-agent pages
(`RecommendationWorkspace`, `MonitoringWorkspace`, `DiagnosticWorkspace`,
`QueryWorkspace`, `RubricImprovementWorkspace`) are thin containers that configure one
generic shell, `AgentReplayShell<F, M, R>` (`AgentReplayShell.tsx:48`). The shell owns all
the replay lifecycle state and calls back into the container via **render props** —
`metricItems(context)` and `renderPanels(context)` (`AgentReplayShell.tsx:69-76`). That is
the deepest abstraction in the frontend. → see `04-generic-trace-replay-shell.md`.

Presentational primitives live in `components.tsx` (`Metric`, `Panel`, `TracePanel`,
`EvalPanel`, `ReplayModeSwitch`, `ProviderStatusPanel`, etc. — `components.tsx:8-455`).
`TracePanel` is the one with real local state: a filter (`components.tsx:131-132`).

Two pages deliberately sit **off the shell** because their lifecycle differs:
`RagQueryWorkspace` (no provider modes, no save/promote — `RagQueryWorkspace.tsx:8`) and
`DocPage` (renders markdown, not a replay — `DocPage.tsx:30`). The home page
(`StudioHome.tsx:59`) and `CapabilityCard` (`StudioHome.tsx:196`) are pure presentational.

- **Headless / compound / slots / children-as-config:** the render-prop shell is the only
  advanced composition pattern. Compound components (`<Tabs><Tab/></Tabs>`-style) are
  `not yet exercised`.

Cross-link module/interface depth (is the shell a *deep* module?) to `study-software-design`.

---

## 4. data-fetching-and-cache

**Verdict: one-shot `fetch` to a same-origin dev middleware, streamed as NDJSON; no query
library, no cache, no optimistic updates.** All network code lives in `api.ts`. The two
shapes:

1. **JSON request/response** — `loadProviderStatus()` GETs `/api/model-status`
   (`api.ts:10-17`); `saveReplayArtifact` / `promoteReplay` / `loadSavedReplays` /
   `loadPromotedFixtures` are POST/GET JSON calls (`api.ts:193-328`).
2. **NDJSON streaming** — `runReplayStream` POSTs to `/api/stream/<agent>/replay`, then
   reads the `ReadableStream` body line-by-line through the runtime's `decodeNdjsonStream`,
   firing `onEvent` per trace event and capturing the final `result` record
   (`api.ts:119-180`). `responseBodyChunks` (`api.ts:169-180`) adapts the browser
   `ReadableStream` to the runtime decoder's async-iterable input. Wire semantics belong to
   `study-networking`.

The server side is **Vite middleware**, not a separate backend — `configureServer` mounts
~17 `/api/*` routes (`vite.config.ts:201-526`). This is why the Pages build, which has no
server, gates every network action behind `STATIC_DEMO` (`useReplayArtifacts.ts:77,94,100`;
`AgentReplayShell.tsx:139`).

- **Route loaders / RSC streaming:** `not yet exercised`.
- **Mutations + optimistic updates + rollback:** `not yet exercised` — save/promote are
  fire-and-refetch (`useReplayArtifacts.ts:98-117`), no optimistic UI.
- **Cache invalidation:** `not yet exercised` — there is no cache; after a mutation the code
  refetches the whole list (`refreshReplayHistory`, `useReplayArtifacts.ts:64-74`).

---

## 5. routing-and-navigation

**Verdict: a hand-rolled hash router, ~25 lines, no library.** `parseHash` /
`navigate` / a `hashchange` listener (`main.tsx:34-60`) are the entire router. Routes are a
fixed config array `VIEW_TOKENS` (`main.tsx:23-32`); `App` is an if-ladder mapping each
token to a view (`main.tsx:65-115`). Hash-based specifically so the static Pages deploy
(no SPA 404 fallback, served under `/aptkit/`) just works, and so doc sections deep-link via
`#view/section` without colliding with the route. → see
`01-hash-routing-with-section-anchors.md`.

Deep-linking and scroll restoration both exist:

- **Deep-linking:** `StudioHome`'s building-blocks list links straight into an API-reference
  section by slugging the heading the same way `rehype-slug` does
  (`StudioHome.tsx:9-10,181`), so the link lands on the right anchor.
- **Scroll-to-anchor:** `DocPage` scrolls to the target heading after render via rAF
  (`DocPage.tsx:50-56`).

- **Code-splitting at the route boundary:** `not yet exercised` — no `React.lazy` /
  dynamic `import()`; every view ships in the main chunk.
- **Route guards / redirects / loaders / prefetch / transitions:** `not yet exercised`. The
  only "redirect" is the fallback to `home` for an unknown token (`main.tsx:40`).

---

## 6. styling-and-design-system

**Verdict: one hand-written global stylesheet, no tokens, no CSS-in-JS, no utility
framework — and the theme is produced by a one-shot build script that rewrites the hex
literals.** Styling is a single 2260-line `styles.css` (`src/styles.css`) imported once in
`main.tsx:14`, addressed by semantic class names (`.shell`, `.topbar`, `.capabilityCard`,
`.ragChunk`). No CSS Modules, no Tailwind, no styled-components.

The reincodes theme is monochrome `#0a0a0a` bg / `#ededed` text, purple titles `#a78bfa`,
red accent `#ef4444` (`styles.css:7-8,15,191,516`). These are written as **literal hex,
repeated** — there are no CSS custom properties / design tokens. Instead, two Node scripts
rewrite the stylesheet in place: `darkify-theme.mjs` (invert lightness, keep hue) and
`reincodes-theme.mjs` (desaturate every hue to gray except red, preserving lightness).
→ see `06-scripted-theme-transform.md`.

One notable CSS technique: the sticky header bleeds black edge-to-edge using a
`::before` pseudo-element at `width: 100vw; left: 50%; translateX(-50%)`
(`styles.css:68-78`) so the bar spans the window while its content stays aligned to the
720px / 1120px content column (`.shellNarrow` / `.shellDoc`, `styles.css:39-49`).

- **Design tokens (CSS variables):** `not yet exercised` — colors are literal hex; a token
  system would compose, the codemod approach doesn't.
- **Dark/light theme toggle:** `not yet exercised` — dark is the only theme; there is no
  runtime switch, the script bakes it in once.
- **Responsive strategy:** present but minimal — two `@media (max-width: 760px)` /
  `1180px` breakpoints (`styles.css:176,2187,2199`). No container queries, no fluid type.
- **Animation system:** `not yet exercised` beyond a few CSS transitions.

---

## 7. browser-platform-and-build

**Verdict: a small, deliberate set of Web APIs; Vite bundler with a fixtures-embedded
static artifact.** Platform APIs Studio actually touches:

- **`window.location.hash` + `hashchange` event** — the router (`main.tsx:34-60`).
- **`fetch` + `ReadableStream` reader** — NDJSON streaming (`api.ts:126,169-180`).
- **`requestAnimationFrame` / `cancelAnimationFrame`** — scroll-to-anchor (`DocPage.tsx:52-55`).
- **`window` object property cache** — the HMR-safe root (`main.tsx:118`).
- **`performance.now()`** — in-browser RAG timing (`agent-runners.ts:168,224`).

Build: Vite. `npm run build` for the dev-shaped artifact; `npm run build:pages` runs
`tsc -b && vite build --mode pages`, which loads `.env.pages` (`VITE_STATIC_DEMO=1`) →
`base: '/aptkit/'` (`vite.config.ts:196`). Docs and fixtures are **build inputs**: markdown
is inlined via Vite's `?raw` import (`main.tsx:12-13`), and the analytics fixtures are
imported as JSON modules straight into `vite.config.ts:53-59` and the runners. →
see `02-build-time-markdown-docs.md` and `05-fixture-as-build-input.md`. CI deploys the
Pages artifact via `.github/workflows/deploy-studio-pages.yml`.

- **Code splitting / lazy chunks:** `not yet exercised` (single bundle).
- **Storage / Worker / ServiceWorker / IndexedDB / WebSocket / EventSource / MediaRecorder:**
  `not yet exercised`. Note specifically: streaming uses `fetch`+NDJSON, **not** WebSocket
  or `EventSource`.
- **Tree-shaking / sourcemaps / polyfills:** Vite defaults; not configured explicitly.

---

## 8. frontend-red-flags-audit

Ranked by user-visible consequence, each grounded in evidence. None are severe — Studio is
small and the risks are mostly "won't scale past its current shape," which is honest given
its purpose.

1. **No code-splitting → every page (and all embedded fixtures + both doc markdown files)
   ships in one chunk** (`main.tsx:12-13`, no `React.lazy` anywhere). Today the corpus is
   tiny so the bundle is small. The day a fixture set or a doc grows large, first paint
   carries weight it doesn't need. *Move:* lazy-load `DocPage` and the heavy workspaces at
   the route boundary in `App` (`main.tsx:65-115`). Bundle-size *measurement* is
   `study-performance-engineering`.

2. **Derived values recomputed every render in the replay shell** —
   `summarizeUsage(visibleTrace)` + `estimateCost(...)` run on every render of
   `AgentReplayShell` (`AgentReplayShell.tsx:164-166`), not memoized. `visibleTrace` can be
   a long array during a live stream (it grows per event). Under React's default behavior
   this re-scans the whole trace on every `setLiveTrace`. *Move:* `useMemo` on `usage` keyed
   to `visibleTrace`. Low severity today (traces are short); names the seam.

3. **The if-ladder router has no notion of an unknown sub-route, only an unknown view** —
   `parseHash` validates the view token against `VIEW_TOKENS` but passes any `anchor`
   through unchecked (`main.tsx:38-41`); a bogus `#api-docs/nonexistent` silently scrolls
   nowhere (`DocPage.tsx:53` no-ops on a missing element). User-invisible, but a missing
   doc section gives no feedback. *Move:* validate the anchor against the built TOC.

4. **Theme colors are literal hex with no token layer** (`styles.css`, ~hundreds of hex
   occurrences; `reincodes-theme.mjs:57` rewrites them by regex). A new component must
   hand-copy `#a78bfa` / `#ef4444`; nothing enforces palette consistency, and a palette
   change means re-running the codemod rather than editing one variable. *Move:* promote the
   palette to `:root` CSS custom properties. → `06-scripted-theme-transform.md`.

5. **`react-markdown` renders repo-authored docs with no sanitizer plugin**
   (`DocPage.tsx:95-97` — `remarkGfm` + `rehypeSlug`, no `rehype-sanitize`). The markdown is
   trusted (it's the repo's own `docs/*.md`, inlined at build), so this is acceptable
   *today*. It becomes a real XSS surface the moment any user-supplied markdown is rendered
   through this component. Flagging the assumption; trust-boundary analysis is
   `study-security`.
