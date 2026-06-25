# 08 — Build-time markdown docs

**Industry names:** build-time asset inlining (`import x from './f.md?raw'`) · client-side markdown rendering · slug-anchored table of contents. **Type:** Industry standard (the `?raw` suffix is Vite/Rollup-specific; the markdown-render + TOC is a generic pattern).

---

## Zoom out — where this lives

The doc pages are two of the ten routes in the hand-rolled router. The interesting part isn't the route — it's *where the content comes from* and *when*.

```
  Where the doc page sits

  ┌─ Build step (Vite, before any browser exists) ───────────────┐
  │  docs/core-api.md  ──(?raw)──►  coreApiMarkdown: string       │ ★ inlined here
  │  docs/studio-guide.md ─(?raw)─►  userGuideMarkdown: string    │
  │            │ both strings become part of the JS bundle         │
  └────────────┼──────────────────────────────────────────────────┘
               │  ship one static bundle (no /docs/*.md endpoint)
  ┌─ UI layer (browser, client-rendered) ──────────────────────────┐
  │  main.tsx App()   view==='api-docs' → <DocPage markdown={…}/>   │
  │    DocPage.tsx                                                  │
  │      buildToc(markdown)   → TOC of #slug links                 │
  │      <ReactMarkdown rehypePlugins={[rehypeSlug]}>  → React tree │ ← we are here
  └────────────────────────────────────────────────────────────────┘
```

The question this answers: **how do you ship in-app documentation that renders real markdown and still works on a static host with no backend to fetch the `.md` files from?** You already know `react-markdown` turns a string into a React tree. The non-obvious move is getting the string into the bundle *at build time* so there's never a runtime request.

## Structure pass

Axis — **"at what lifecycle phase does the markdown content exist?"** — traced across the candidate designs.

```
  axis: "when does the doc content become available?"

  ┌─ runtime-fetch design ────────────────────────┐
  │  fetch('/docs/core-api.md') at render time     │  → REQUEST phase
  │  needs a server (or static host) serving .md   │     (breaks on Pages: no route)
  └───────────────────────┬─────────────────────────┘
                          │  the seam: where content is resolved
  ┌─ Studio's ?raw design ─▼─────────────────────────┐
  │  import md from '…?raw'  → string in the bundle   │  → BUILD phase
  │  no request, content is already here              │     (works anywhere static)
  └───────────────────────────────────────────────────┘
```

- **Layers:** build-time (Vite reads the file, inlines a string) and runtime (React compiles that string to a tree). The `?raw` import is the seam between them.
- **The axis flips at the import.** Before the build, the content is a file on disk; after, it's a string literal in JS. That flip is what makes the docs survive the static deploy — there's no network hop left to fail.
- **A second, smaller seam** lives inside `DocPage`: the TOC `#slug` ids must match the heading anchor ids `rehype-slug` generates. Two independent slug computations have to agree, or the anchors don't jump. That's the load-bearing detail in Move 2.

## How it works

### Move 1 — the mental model

Think of `?raw` as `JSON.stringify(fileContents)` happening at build time and getting baked into your bundle as a `const`. The file stops being a *resource you fetch* and becomes a *value you import* — same as importing a function, except the value is the file's text. Then `react-markdown` is just `markdownString → React.ReactElement`, a compile you run in the browser on every render.

```
  The pattern: file → build-time string → render-time tree

  docs/core-api.md   (a file on disk)
        │  Vite ?raw  (BUILD TIME — happens once, in CI)
        ▼
  const coreApiMarkdown = "# API…\n## …"   (a string in the bundle)
        │  import into main.tsx, pass as prop
        ▼
  <ReactMarkdown>{markdown}</ReactMarkdown>   (RENDER TIME — in browser)
        │  remark parse → mdast → rehype → hast → React
        ▼
  <h1>API…</h1><h2 id="…">…</h2> …   (a React element tree)
```

Strategy in one line: **inline the markdown as a string at build time, then compile it to a React tree at render time — no fetch ever happens.**

### Move 2 — the walkthrough

#### Part A — the `?raw` import (the build-time inline)

`import coreApiMarkdown from '../../../docs/core-api.md?raw'` (`main.tsx:13`). The `?raw` query suffix tells Vite/Rollup: don't treat this as a module to transform, read the raw bytes and export them as a default string. At build, the literal contents of `docs/core-api.md` are embedded in the JS bundle.

What breaks without `?raw`: a plain `import … from './core-api.md'` would try to *process* the `.md` as a module (no loader → build error), and a runtime `fetch('/docs/core-api.md')` would 404 on the GitHub Pages build, where there is no server and `/docs/` isn't part of the static artifact. The `?raw` is what ties this page to the `STATIC_DEMO` story (`07-static-demo-gated-ui.md`): content already in the bundle = nothing to gate.

```
  Layers-and-hops — why ?raw beats fetch on a static host

  ┌─ Build (CI) ─────────────┐  hop 1: read file, inline string
  │  Vite reads docs/*.md     │ ──────────────────────────────┐
  └──────────────────────────┘                                ▼
                                              ┌─ Bundle (.js) ────────────┐
                                              │  const md = "# API…"       │
                                              └─────────────┬──────────────┘
                                                            │ hop 2: ships as static asset
  ┌─ Static host (GitHub Pages, NO server) ◄────────────────┘
  │  serves index.html + .js — NO /docs/*.md route exists     │
  │  runtime fetch('/docs/…') would 404; ?raw never asks       │
  └────────────────────────────────────────────────────────────┘
```

#### Part B — `react-markdown` + the plugin pipeline (render-time compile)

`<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]}>{markdown}</ReactMarkdown>` (`DocPage.tsx:81-83`). Three libraries each do one job:
- **`react-markdown`** parses the string and emits React elements (not `dangerouslySetInnerHTML` — it builds real elements, so there's no raw-HTML injection surface by default).
- **`remark-gfm`** adds GitHub-flavored markdown at the *mdast* (markdown AST) stage: tables, strikethrough, task lists, autolinks. Without it, a `| col |` table renders as literal pipes.
- **`rehype-slug`** runs at the *hast* (HTML AST) stage and stamps an `id` on every heading, slugged from its text. This is what makes `#some-heading` anchors land.

What breaks if you drop `rehype-slug`: headings render with no `id`, so the TOC links in Part C point at fragments that don't exist — clicking them does nothing.

```
  The render pipeline (one compile per render)

  markdown string
     │  remark parse
     ▼
  mdast  ──[remark-gfm]──►  mdast+tables
     │  remark-rehype
     ▼
  hast   ──[rehype-slug]──►  hast with heading ids
     │  react-markdown
     ▼
  React element tree  → <h2 id="setup">Setup</h2> …
```

#### Part C — the TOC and the slug-must-match invariant

`buildToc(markdown)` (`DocPage.tsx:11-27`) is a `useMemo` (`:41`) that scans the markdown text for H2/H3 lines and produces `{ depth, text, slug }` entries. It renders them as `<a href={`#${entry.slug}`}>` links (`DocPage.tsx:71`). Clicking one uses the browser's native fragment scroll — no JS handler, no router involvement (it doesn't change `view`; see `04-hand-rolled-router.md`).

The load-bearing detail: `buildToc` slugs each heading with **the same library `rehype-slug` uses internally — `github-slugger`** (`DocPage.tsx:5,12`). That's not a coincidence; it's the whole trick. Two independent passes compute slugs — `rehype-slug` on the rendered headings, `buildToc` on the raw source — and they only agree because both call `GithubSlugger`. A fresh `new GithubSlugger()` per call matters too: the slugger is *stateful*, it deduplicates repeats by appending `-1`, `-2`. Reuse one instance across renders and your slugs drift on the second render.

What breaks if the two slug computations disagree (e.g. you hand-roll `buildToc`'s slugger with a naive `lowercase().replace(/ /g,'-')`): headings with punctuation, duplicates, or markdown links in the title get a different id than the anchor, and those TOC entries silently scroll nowhere. `buildToc` even strips inline-link syntax from heading text before slugging (`DocPage.tsx:23`) to match what `rehype-slug` sees.

```
  The invariant: two slug passes must agree

  RAW source heading        RENDERED heading (rehype-slug)
  "## Quick Start"          <h2 id="quick-start">
        │ buildToc                    ▲
        │ github-slugger              │ github-slugger
        ▼                            │
  slug = "quick-start"  ════════════╪═══►  href="#quick-start"
                          (same lib → same slug → anchor lands)

  swap either slugger for a different impl → ids diverge → dead link
```

#### Part D — the empty/short-doc guard

The TOC only renders when `toc.length > 1` (`DocPage.tsx:65`). A doc with zero or one heading shows no sidebar — the `.docLayout` grid collapses to just the article. Small thing, but it keeps a one-section doc from getting a pointless one-item TOC.

### Move 2.5 — current vs future state

```
  current (shipped)                 future (if docs grow / go dynamic)
  ───────────────────              ────────────────────────────────────
  ?raw inline, 2 docs              same — until docs get large enough
  whole md string in bundle        that bundle size matters, then split
  trusts repo-owned content        if EVER rendering fetched/user md →
  (no sanitizer)                   add rehype-sanitize (security seam)

  migration cost: low. Bundle-splitting the docs is a dynamic import;
  sanitizing is one rehype plugin. Neither touches the TOC logic.
```

The takeaway: the `?raw` choice is right *because the docs are small and repo-owned*. The day they're large (bundle bloat) or externally sourced (XSS surface), the calculus flips — but both upgrades are additive.

### Move 3 — the principle

Resolve content as early in the lifecycle as the deploy target allows. A static host has no request phase you can rely on, so anything the page needs must exist at build time. `?raw` moves the markdown from "resource fetched at runtime" to "value inlined at build" — and that single phase-shift is what lets a real markdown-rendering doc page ship inside a backend-less static artifact. The matching-slugger detail is the general lesson in miniature: when two passes must produce the same identifier, share the function, don't reimplement it.

## Primary diagram

```
  Build-time markdown docs — the whole path

  ┌─ BUILD (Vite, CI) ─────────────────────────────────────────┐
  │  docs/core-api.md ──?raw──► coreApiMarkdown (string)        │
  │  docs/studio-guide.md ─?raw─► userGuideMarkdown (string)    │
  │         └─ both literally embedded in the .js bundle         │
  └───────────────────────────┬─────────────────────────────────┘
                              │ ship static artifact
  ┌─ UI layer (browser) ──────▼─────────────────────────────────┐
  │  App() route → <DocPage markdown={coreApiMarkdown}/>         │
  │    DocPage.tsx                                               │
  │    ├─ buildToc(md)  [github-slugger] → [{depth,text,slug}]   │
  │    │     └─ <nav.docToc> <a href="#slug">                    │
  │    └─ <ReactMarkdown                                         │
  │         remarkPlugins={[remark-gfm]}      (tables, etc.)     │
  │         rehypePlugins={[rehype-slug]}>    (heading ids)      │
  │         → <h2 id="slug">…</h2>  ◄── anchors match TOC slugs  │
  └──────────────────────────────────────────────────────────────┘
  no fetch · no /docs route · works on GitHub Pages
```

## Implementation in codebase

### Use cases

The two in-app reference pages reached from the gallery topbar: **API Reference** (`view==='api-docs'`, renders `docs/core-api.md`) and **Studio Guide** (`view==='user-guide'`, renders `docs/studio-guide.md`). Both are opened from `StudioHome`'s topbar buttons (`StudioHome.tsx:24-31`) and routed in `App()` (`main.tsx:50-70`). The pattern exists so a reader on the GitHub Pages demo — where there's no server, no IDE, no repo checkout — can still read the API docs and the output-evaluation guide in-app.

### Code, line by line

```
  apps/studio/src/main.tsx:13-14, 50-70  — the ?raw import + the two routes

  import coreApiMarkdown from '../../../docs/core-api.md?raw';   ← BUILD-TIME inline:
  import userGuideMarkdown from '../../../docs/studio-guide.md?raw';  the .md text
                                                                  becomes a string const
  …
  if (view === 'api-docs')
    return <DocPage title="API Reference"
             markdown={coreApiMarkdown}            ← the inlined string, no fetch
             sourceHref={`${REPO_DOCS}/core-api.md`}
             onHome={() => setView('home')} />;
  if (view === 'user-guide')
    return <DocPage title="Studio Guide …"
             markdown={userGuideMarkdown} … />;    ← same component, different doc
       │
       └─ one DocPage component serves both routes; the route only
          selects which build-time string to hand it (see §04)
```

```
  apps/studio/src/DocPage.tsx:11-27  — buildToc, the slug-matching TOC builder

  function buildToc(markdown: string): TocEntry[] {
    const slugger = new GithubSlugger();     ← SAME lib rehype-slug uses; fresh
    const entries: TocEntry[] = [];             instance so dedup counters reset
    let inFence = false;
    for (const line of markdown.split('\n')) {
      if (/^\s*```/.test(line)) { inFence = !inFence; continue; }  ← skip code fences
      if (inFence) continue;                    so a `## ` inside a ``` block
      const match = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);  isn't taken as a heading
      if (!match) continue;
      const text = match[2].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();  ← strip
      entries.push({ depth: match[1].length, text,    inline-link syntax so the
                     slug: slugger.slug(text) });     slug matches rehype-slug's
    }
    return entries;
  }
       │
       └─ the fence-skip + link-strip + github-slugger are all there to make
          buildToc's slug IDENTICAL to the id rehype-slug stamps on the
          rendered <h2>. Diverge on any of the three → dead anchor links.
```

```
  apps/studio/src/DocPage.tsx:64-84  — the layout: TOC sidebar + rendered article

  <div className="docLayout">                  ← two-col grid (styles.css:71)
    {toc.length > 1 ? (                         ← no sidebar for a 0/1-heading doc
      <nav className="docToc" aria-label="Table of contents">
        {toc.map((entry) => (
          <a className={`docTocLink h${entry.depth}`}  ← .h2/.h3 indent (styles.css:118)
             href={`#${entry.slug}`}>{entry.text}</a>  ← native fragment scroll,
        ))}                                              not a router nav (§04)
      </nav>
    ) : null}
    <article className="docPage">              ← .docPage descendant selectors are the
      <ReactMarkdown                              ONLY styling hook — react-markdown emits
        remarkPlugins={[remarkGfm]}               bare <h2>/<pre>/<table> with no classes
        rehypePlugins={[rehypeSlug]}>             (styles.css:142-217)
        {markdown}
      </ReactMarkdown>
    </article>
  </div>
```

## Elaborate

The `?raw` import is part of a broader Vite/Rollup asset-handling family: `?url` (get the resolved URL of an asset), `?inline` (base64-inline a binary), `?worker` (compile to a Worker). They all answer "how does this non-JS file enter my JS graph," and `?raw` is the "give me the bytes as a string" answer. The general principle — resolve at build what the deploy target can't serve at runtime — is the same one behind SSG, static-site generators inlining content, and `import.meta.glob` for content collections. The markdown-render-with-TOC half is a near-universal docs pattern (every docs site has a "On this page" rail); what's specific here is doing it client-side over a build-inlined string instead of pre-rendering HTML.

What to read next: `07-static-demo-gated-ui.md` (the static-deploy story this pattern serves), then `study-security` for the markdown-sanitization trust boundary if docs ever go dynamic, and `study-performance-engineering` for when inlined-markdown bundle weight starts to matter.

## Interview defense

**Q: How do in-app docs render real markdown on a static host with no backend?**
The markdown is imported with Vite's `?raw` suffix (`main.tsx:13`), so the file's contents are inlined as a string into the JS bundle *at build time*. There's no runtime `fetch` — the content ships inside the bundle, so it works on GitHub Pages where no `/docs/*.md` route exists. At render time `react-markdown` compiles that string to a React element tree.

```
  docs/*.md ──?raw (build)──► string in bundle ──react-markdown (render)──► React tree
  no fetch · survives backend-less static deploy
```
Anchor: `main.tsx:13-14`, `DocPage.tsx:81-83`.

**Q: The TOC links are `#slug` anchors — what makes them actually jump to the right heading?**
The heading ids and the TOC slugs are computed by the *same* library. `rehype-slug` stamps `id`s on the rendered headings; `buildToc` slugs the raw source — and both use `github-slugger` (`DocPage.tsx:5,12`). If you reimplemented the TOC slugger with a naive lowercase-and-dash, headings with punctuation or duplicates would get a different id than the anchor and the links would scroll nowhere. The fresh `new GithubSlugger()` per call also matters — it's stateful (dedups with `-1`/`-2` suffixes), so reusing one instance would drift slugs across renders.

```
  raw "## Quick Start" ─github-slugger─► "quick-start" ─┐
  rendered <h2> ────────github-slugger─► id="quick-start"┘  same lib → anchor lands
```
Anchor: `DocPage.tsx:11-27`.

**Q: Any security concern rendering markdown?**
Not here. `react-markdown` builds real React elements and escapes raw HTML by default (no `rehype-raw`), and the source is a repo-owned build-time import — never user input. If a future page rendered *fetched* or *user-supplied* markdown, sanitization (`rehype-sanitize`) would become load-bearing. Trust-boundary mechanics are `study-security`'s.

## Validate

1. **Reconstruct:** explain what `import x from './f.md?raw'` produces and at what phase. (A string export, inlined at build time — no runtime fetch.)
2. **Explain:** why does `buildToc` use `github-slugger` specifically, and why a fresh instance each call? (To match `rehype-slug`'s heading ids exactly; fresh instance so the stateful dedup counters reset per render.)
3. **Apply:** the API docs page anchors stop working after someone adds two headings titled "Errors". What happened, what fixes it? (`github-slugger` dedups the second to `errors-1`; both passes still use the same slugger so they *should* agree — verify `buildToc` isn't reusing an instance and that the fence/link-strip still matches what `rehype-slug` sees.)
4. **Defend:** a teammate says "just `fetch` the markdown at runtime, it's simpler." Argue the call. (On the static Pages build there's no server to fetch from — `/docs/*.md` 404s; `?raw` inlines it so there's nothing to fetch.)

## See also

- `07-static-demo-gated-ui.md` — the backend-less static deploy this pattern is built to survive.
- `04-hand-rolled-router.md` — the two doc routes (`api-docs`/`user-guide`) and the one-component-two-routes detail; fragment vs view navigation.
- `00-overview.md` — the component tree the doc pages sit in.
- Cross-guide: `study-security` (markdown sanitization trust boundary), `study-performance-engineering` (inlined-content bundle weight).
