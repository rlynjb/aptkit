# Build-time inlining, zero runtime fetch

**Industry name:** build-time data inlining / static-site asset embedding · **Type:** Industry standard (frontend build)

The deliberate trade that bakes every fixture and doc into the JS bundle at build time, so the deployed Studio site makes zero data round-trips — paid for with a single 537 kB chunk over Vite's warning line.

---

## Zoom out, then zoom in

Studio has two lives: a dev server (Vite middleware serving live replay routes) and a static GitHub Pages build (no server at all). On Pages there is nothing to fetch *from* — so all the data the demo needs is moved from "fetch at runtime" to "inline at build time."

```
  Zoom out — where the inlining happens

  ┌─ Build time (Vite) ───────────────────────────────────────┐
  │  import fixture from '.../fixtures/*.json'   → JSON inlined │ ← we are here
  │  import md from '../../docs/*.md?raw'         → string inlined│
  │     ▼ bundled into one index-*.js (537 kB)                  │
  └───────────────────────────┬───────────────────────────────┘
                              │ deploy to GitHub Pages (static)
  ┌─ Runtime (browser) ───────▼───────────────────────────────┐
  │  React reads inlined data — NO fetch(), NO API, NO server  │
  └────────────────────────────────────────────────────────────┘
```

The cost axis flips from *network* to *bundle size*: instead of paying a fetch round-trip per data item at runtime, you pay once in first-load JS. For a fixture-only demo on a static host, that is the right side of the trade.

## The structure pass

Trace **the cost axis — "when is the data paid for: build or runtime?"** across the build seam.

```
  Axis: "when is the data cost paid?" — across the build/runtime seam

  ┌─ build time ──────────────────┐  seam   ┌─ runtime (Pages) ───────────┐
  │ import JSON / md?raw           │ ══╪══►  │ data already in the bundle   │
  │ → serialized into the chunk    │ (flips) │ → 0 fetches, 0 server        │
  │ cost: bundle grows (537 kB)    │         │ cost: larger first paint     │
  └───────────────────────────────┘         └──────────────────────────────┘
```

- **Layers:** build (inlines) → bundle (carries) → runtime (reads, never fetches).
- **Axis:** when the data is paid for. The seam moves it from runtime-network to build-time-bundle.
- **Seam:** the Vite `import` (JSON import + `?raw` suffix). Crossing it converts a would-be runtime `fetch` into a compile-time constant.

## How it works

#### Move 1 — the mental model

You know that `import data from './x.json'` gives you the parsed object with no `fetch` — the bundler reads the file at build time and writes its contents into the JS. Build-time inlining is that move applied to *everything the demo needs*: fixtures as JSON imports, markdown docs as raw-string imports. The runtime never asks the network for anything.

```
  Pattern — move the fetch from runtime to build

  RUNTIME FETCH (not used on Pages):     BUILD-TIME INLINE (what Studio does):

   browser ──fetch('/fixture')──► server   build: import fixture from '*.json'
        │                                        │ serialize into chunk
        ▼ wait, parse                            ▼
   render                                   browser: data is already here → render
   (N round-trips, needs a server)          (0 round-trips, no server)
```

#### Move 2 — the step-by-step walkthrough

**Step 1 — fixtures inline as JSON imports.** The Vite config imports every agent fixture directly. Each becomes a compile-time constant baked into the bundle:

```ts
// apps/studio/vite.config.ts  (the fixture imports)
import monitoringFixture from '../../packages/agents/anomaly-monitoring/fixtures/sp-revenue-monitoring.json';
import diagnosticFixture from '../../packages/agents/diagnostic-investigation/fixtures/sp-revenue-diagnostic.json';
import queryFixture      from '../../packages/agents/query/fixtures/revenue-by-state-query.json';
// ... recommendation fixtures (electronics-spike, sp-revenue-drop, voucher-dropoff)
```

These are the recorded `ModelResponse[]` that `FixtureModelProvider` replays. On Pages there is no replay *server* — the fixtures *are* the data, embedded.

**Step 2 — docs inline as raw strings via `?raw`.** The in-app doc pages need the markdown source as a string. The `?raw` suffix tells Vite to import the file's raw text instead of executing it:

```ts
// apps/studio/src/main.tsx:12-13
import coreApiMarkdown from '../../../docs/core-api.md?raw';   // ← whole .md file as a string constant
import userGuideMarkdown from '../../../docs/studio-guide.md?raw';
```

At runtime, `DocPage` renders these strings through react-markdown with no fetch — the markdown ships *inside* `index-*.js`.

**Step 3 — the result: zero-fetch static site.** Because every fixture and doc is a constant in the bundle, the deployed Studio makes no runtime data request. It is a pure client-side app on a static host. There is no API to be slow, no server to provision, no CORS, no cold start.

**Where it breaks — one chunk, over the warning line.** The cost lands as bundle size. The build emits a single JS chunk:

```
  apps/studio/dist/assets/index-C9mrf4h5.js   →  537,310 bytes
```

That is over Vite's default `chunkSizeWarningLimit` of 500 kB, so the build prints the "(!) Some chunks are larger than 500 kB" warning. There is no `manualChunks`, no `chunkSizeWarningLimit` override, no lazy route in the config — everything (React, lucide-react, all six agents' code, every fixture, both docs) is in one chunk. For a static demo that loads once and runs entirely client-side, a 537 kB first load is an accepted cost: the user pays it once, then every interaction is instant with no network. The warning is the closest thing the repo has to a budget signal (`audit.md` Lens 1), and it is firing — acknowledged, not silenced.

#### Move 2.5 — dev vs Pages (the two lives)

The same app behaves differently in its two builds, and that is the point of the pattern:

```
  Phase A: dev (`vite --host`)        Phase B: Pages (`build:pages`)
  ────────────────────────────        ──────────────────────────────
  Vite middleware exposes 5           no server at all
   replay API routes, streams         fixtures + docs inlined at build
   NDJSON traces                      → static files on GitHub Pages
  data fetched live from middleware   → 0 runtime fetch
  can run real Anthropic/OpenAI       fixture-replay only (deterministic)
```

What *doesn't* have to change between them: the React components. They read data the same way; only the *source* of that data moves from "fetched from middleware" (dev) to "inlined constant" (Pages). The inlining is a build-mode concern, not an app-code concern.

#### Move 3 — the principle

When the host is static and the data is fixed at build time, move the fetch into the bundler. You trade a larger first-load payload for zero runtime round-trips and zero server — the right trade when the data is demo-fixed and the host has no backend. The discipline is naming the cost: the 537 kB chunk is over Vite's line and the build says so. An accepted-and-visible cost beats a hidden one.

## Primary diagram

```
  Build-time inlining — full picture

  ┌─ Build (Vite, `build:pages`) ─────────────────────────────────┐
  │  import fixture.json   ──┐                                      │
  │  import doc.md?raw      ──┼──► serialized into ──► index-*.js   │
  │  React + lucide + agents ─┘     one chunk           537,310 B   │
  │                                 (> 500 kB Vite warning, ACCEPTED)│
  └───────────────────────────┬────────────────────────────────────┘
                              │ deploy → GitHub Pages (static host)
  ┌─ Runtime (browser) ───────▼────────────────────────────────────┐
  │  React reads inlined constants                                  │
  │  fixtures → FixtureModelProvider replay                         │
  │  docs     → DocPage react-markdown render                       │
  │  ── 0 fetch, 0 API, 0 server, every interaction instant ──      │
  └──────────────────────────────────────────────────────────────────
```

## Elaborate

Inlining build-time-known data is a standard static-site move — it is what static-site generators do with content, what `import.meta.glob` and `?raw` exist for in Vite. The tradeoff it manages is the classic one: first-load payload vs runtime round-trips. For a fixture-replay demo with no live backend the calculus is one-sided — there is no server to fetch from, so inlining is not even really a choice, it is the only way to ship the data. The single-chunk 537 kB is the honest cost, and the path to shrink it (route-level code-splitting, `manualChunks` to peel out React) is exactly the standard frontend lever — `not yet exercised` because the demo loads once and the cost is paid once.

The rendering and build mechanics live in `study-frontend-engineering`; this file owns only the *performance* trade.

## Interview defense

**Q: Why is your Studio bundle one 537 kB chunk over Vite's warning?**
Deliberate. The Pages build inlines every fixture (JSON imports) and every doc (`?raw` string imports) so the static site makes zero runtime fetches — no server, no API, no cold start. The cost is first-load JS. For a demo that loads once and runs entirely client-side, paying 537 kB once to get zero round-trips forever is the right trade. The Vite warning is firing and I left it visible, not silenced.

```
  build: import json + md?raw → one chunk (537 kB, warns)
  runtime: read constants → 0 fetch, 0 server
```
Anchor: "moved the fetch into the bundler; pay once in JS, never on the network."

**Q: How would you cut the bundle if you needed to?**
Route-level code-splitting (lazy-load the per-agent pages) and `manualChunks` to peel React and lucide into a vendor chunk that caches across deploys. Neither is wired yet — the demo loads once so the cost is paid once. The lever is standard; I just haven't needed to pull it.

Anchor: "split by route, vendor-chunk the framework — standard, not yet needed."

## See also

- `audit.md` — Lens 1 (the Vite warning as the only budget signal), Lens 7 (rendering/bundle), Lens 8 (red flag #6)
- `study-frontend-engineering` — Studio rendering, the Vite build pipeline, dev-middleware replay routes
