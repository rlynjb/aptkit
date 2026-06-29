# Build-time inlining, zero runtime fetch

*Industry names: build-time inlining / asset bundling / static prerender. Type:
Industry standard (Vite `?raw`).*

## Zoom out, then zoom in

The Studio docs pages render markdown files. They could fetch those `.md` files
at runtime — but on a static GitHub Pages deploy there's no server to fetch
from, and a fetch is a round-trip you'd rather not pay. The question this file
answers: **how does Studio show docs with zero runtime fetch, and what does that
cost in bundle size?** The answer: the markdown is inlined into the JS bundle at
build time, paying once at build for a fetch-free load — and the bill is a
537 kB single chunk.

```
  Zoom out — where inlining sits in the client build

  ┌─ Build time (Vite + tsc) ───────────────────────────────────┐
  │  main.tsx: import md from '../../../docs/*.md?raw'           │
  │  → Vite reads the file, inlines its TEXT into the JS bundle  │
  │                                  ★ THIS CONCEPT ★            │ ← we are here
  └───────────────────────────┬──────────────────────────────────┘
                              │  one 537 kB index-*.js (no splitting)
  ┌─ Runtime (browser, GitHub Pages) ▼────────────────────────────┐
  │  DocPage renders the inlined string via react-markdown        │
  │  ZERO fetch for docs — the text is already in the bundle      │
  └───────────────────────────────────────────────────────────────┘

  the trade: a fatter initial download (paid once, cached) for a deploy with no
  server and no runtime doc fetch. right for a static demo, wrong for a big app.
```

The pattern: **move work from runtime to build time.** Instead of "ship a small
bundle, fetch the docs when needed," it's "ship a bigger bundle with the docs
baked in, fetch nothing." The cost moves from per-visit network latency to
one-time bundle weight.

## The structure pass

Trace the **lifecycle** axis (when does the work happen) across the boundary.

```
  One axis (when) traced across the build/runtime seam

  ┌─ build time ───────────────┐  seam   ┌─ runtime ─────────────┐
  │ ?raw import → file text     │ ══════► │ string already present│
  │ inlined into JS bundle      │ (flips) │ render, NO fetch      │
  └─────────────────────────────┘         └───────────────────────┘
         work done ONCE                       work done ZERO times
```

- **Layers:** build (Vite resolves `?raw`) over runtime (browser renders).
- **Axis:** lifecycle — *when* the doc-loading work happens. It flips from
  "every page visit" (fetch model) to "once, at build" (inline model).
- **Seam:** the `?raw` import. That's where a runtime concern (fetching a file)
  becomes a build-time constant (a string literal in the bundle).

## How it works

#### Move 1 — the mental model

You know how `import logo from './logo.svg'` in a bundler doesn't fetch the SVG
at runtime — the bundler resolves it at build, and you just get a URL or the
inlined data? `?raw` is the same move for text: the import resolves to the
file's *contents as a string* at build time.

```
  Pattern — build-time inline vs runtime fetch

  INLINE (this code):              FETCH (the alternative):

  build: read docs/x.md            build: ship a small bundle
         → "## Title\n..."          runtime: fetch('/docs/x.md')
         → bake into bundle                  → await response
  runtime: string is HERE                    → render
           render immediately       (1 round-trip per page, needs a server)
  (0 fetch, bigger bundle)
```

#### Move 2 — the step-by-step walkthrough

**Step 1 — the `?raw` import inlines the file text.** In Studio's entry —
`apps/studio/src/main.tsx:12-13`:

```ts
import coreApiMarkdown from '../../../docs/core-api.md?raw';
import userGuideMarkdown from '../../../docs/studio-guide.md?raw';
```

The `?raw` suffix tells Vite: don't treat this as a module, read the file and
hand me its contents as a string. At build, Vite replaces these imports with
string literals containing the entire markdown text. The `docs/*.md` files
become part of the JS.

**Step 2 — the string renders with no fetch.** `DocPage` takes that string and
runs it through `react-markdown` + `remark-gfm` + a `github-slugger` TOC. There
is no `fetch`, no `await`, no loading state — the content is synchronously
present the moment the component mounts. On GitHub Pages, where `VITE_STATIC_DEMO=1`
sets `base: '/aptkit/'` (`vite.config.ts:196`) and there's no API server, this
is the *only* way the docs could render — there's nothing to fetch from.

**Step 3 — the cost lands as bundle weight.** The price of inlining everything —
markdown, every workspace component, `react-markdown`, `lucide-react` — is one
big chunk. The built artifact: `apps/studio/dist/assets/index-C9mrf4h5.js` at
**537,310 bytes** (and a 27 kB CSS file). That's past Vite's default 500 kB
chunk-size warning, which *fires on every build* and which nothing acts on.

**The boundary condition — there's no code-splitting.** The Vite config
(`vite.config.ts`) sets `base` and the dev middleware but defines **no**
`build.rollupOptions.output.manualChunks`, no dynamic `import()`, no lazy
routes. Every workspace — Recommendation, Monitoring, Diagnostic, Query, Rubric,
RAG, Docs — ships in that single initial download even though a visitor opening
the RAG page never needs the Diagnostic code. The whole app is one chunk because
nothing told the bundler to split it.

```
  Layers-and-hops — what the browser pays on first load

  ┌─ Browser ─────┐ hop 1: GET /aptkit/index.html  ┌─ GitHub Pages ─┐
  │  cold visit   │ ──────────────────────────────► │  static files  │
  │               │ hop 2: GET index-*.js (537 kB) ◄─│  (no server)   │
  └───────┬───────┘                                  └────────────────┘
          │ parse + execute 537 kB (incl. ALL docs + ALL workspaces)
          ▼
     render any page — docs included — with ZERO further fetch
```

#### Move 2 variant — the load-bearing skeleton

The kernel: **(1) resolve the asset at build time, (2) embed it as a constant,
(3) render the constant with no async at runtime.**

- Drop build-time resolution (fetch instead) → you need a server and pay a
  round-trip per page; impossible on pure static hosting.
- Drop the embed (lazy-load the chunk) → you've reintroduced a fetch, trading
  bundle size back for latency — sometimes the right call, but not zero-fetch.
- The *missing* hardening — code-splitting — is what would keep the zero-fetch
  property for docs while shrinking the initial download for everything else.
  Its absence is the load-bearing weakness.

The skeleton is "resolve-at-build + render-sync." Code-splitting and lazy
loading are the hardening this build skips.

#### Move 2.5 — current state vs future state

```
  Phase A (now)                    Phase B (if it grew)
  ─────────────────                ─────────────────────
  one 537 kB chunk                 route-split chunks
  all workspaces inlined           lazy import() per workspace
  all docs inlined (?raw)          docs stay inlined (keep zero-fetch)
  fires Vite 500 kB warning        each chunk under warning
  fine for a demo                  needed if customer-facing

  what DOESN'T change: the ?raw zero-fetch property for docs. Splitting is
  orthogonal — you'd lazy-load WORKSPACES while keeping docs inlined.
```

The migration cost is low and additive: `manualChunks` or `React.lazy` per
route. Nobody's done it because Studio is a dev/demo tool where a one-time
537 kB load over a cached CDN is acceptable — a deliberate "ship it" call, not
an oversight.

#### Move 3 — the principle

Trade runtime work for build-time work when the deploy target can't (or
shouldn't) do the work at runtime — a static host has no server to fetch from,
so inlining isn't an optimization, it's the enabler. The generalizable rule:
**the cheapest fetch is the one you made unnecessary at build time** — but watch
the bundle, because inlining without splitting concentrates all the cost into
one cold-load. Here the docs-inlining is the right call; the missing
code-splitting is the unmeasured cost riding alongside it.

## Primary diagram

```
  Build-time inlining + zero-fetch — the whole trade

  ┌─ BUILD TIME (Vite) ─────────────────────────────────────────┐
  │  import md from 'docs/x.md?raw'  → file text becomes a const │
  │  + all workspace components + react-markdown + lucide        │
  │  ───────────────► one index-*.js  (537 kB, no manualChunks)  │
  │       Vite logs "chunk > 500 kB" warning — unacted-on        │
  └───────────────────────────┬──────────────────────────────────┘
                              │ static deploy to GitHub Pages
  ┌─ RUNTIME (browser) ───────▼──────────────────────────────────┐
  │  cold load: 1× 537 kB JS (cached after)                      │
  │  render any page incl. docs → ZERO runtime fetch             │
  └───────────────────────────────────────────────────────────────┘
       gain: fetch-free static deploy   cost: fat cold load, unmeasured
```

## Elaborate

`?raw` is Vite's mechanism (Webpack has `raw-loader`, the idea predates both);
it's the text equivalent of asset inlining. The deeper context here is the
deploy target: aptkit's Studio ships to GitHub Pages as a fixture-only static
demo (the recent commits "static fixture-only GitHub Pages build" and "Enable
GitHub Pages from the deploy workflow"). On a static host there is no backend to
serve `/docs/core-api.md`, so the choice isn't "inline vs fetch for speed" —
it's "inline or it doesn't work at all." The bundle-size cost is the honest
consequence, and the absent code-splitting is where you'd start if Studio ever
became customer-facing. Read next: `02-linear-scan-vs-ann-tradeoff.md` (the
cosine scan that, in the in-browser RAG demo, runs on this same main thread).

## Interview defense

**Q: Your Studio bundle is 537 kB in one chunk. Defend it.**

Verdict first: it's the right call for what Studio is — a dev/demo tool deployed
static to GitHub Pages — and I can tell you exactly what I'd change if it became
customer-facing. The 537 kB is one chunk because there's no code-splitting, and
the docs are inlined via Vite `?raw` so the static deploy needs zero runtime
fetch — there's no server to fetch from. The trade is a fat one-time cold load
(cached after) for a fetch-free static site. To fix the size without losing the
zero-fetch property: lazy-load the *workspaces* with `React.lazy` / route-level
`import()` while keeping the docs inlined.

```
  sketch while you talk:

  build:  docs/*.md?raw → inlined string   +  all workspaces → 1 chunk (537 kB)
  runtime: render docs, ZERO fetch         ← the property worth keeping
  fix:    React.lazy per workspace → split chunks, docs stay inlined
```

One-line anchor: *"inlining is the enabler for a serverless static deploy, not
just an optimization — and code-splitting is the orthogonal fix for the size."*

**Q: Have you measured the load cost?**

No — and that's the honest gap. No Lighthouse run, no FCP/LCP, no main-thread
profile. The 537 kB is a `ls -la` on the dist artifact, not a measured
load-time impact. First thing I'd do: a Lighthouse pass to see whether the
single chunk actually hurts cold-load on a throttled connection before splitting
on instinct.

## See also

- `audit.md` — lens 7 (rendering/client), red-flag #3.
- `02-linear-scan-vs-ann-tradeoff.md` — the in-browser cosine scan on this main
  thread.
- Cross-guide: `study-frontend-engineering` (bundling, rendering, build).
