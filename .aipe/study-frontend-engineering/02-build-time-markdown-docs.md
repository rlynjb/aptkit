# Build-time markdown docs

**Industry name(s):** import-as-string / raw asset import; markdown-as-content rendered
client-side with a generated table of contents. **Type:** Industry standard (the bundler
`?raw` import; `react-markdown` rendering), project-specific in how it threads anchors into
the hash router.

## Zoom out, then zoom in

Studio ships its own documentation *inside* the app — the API Reference and the Studio Guide
are `docs/*.md` files rendered as in-app pages, not external links. They have to render on
static GitHub Pages with no server, so the markdown is pulled in at **build time** as a
string. Here's where the doc renderer (a `DocPage`) sits.

```
  Zoom out — where build-time docs live

  ┌─ Build layer (Vite) ─────────────────────────────────────┐
  │  docs/core-api.md  ──?raw──►  inlined as a JS string       │  ← happens at build
  └───────────────────────────────┬──────────────────────────┘
                                  │ import coreApiMarkdown
  ┌─ App layer (main.tsx) ────────▼──────────────────────────┐
  │  <DocPage markdown={coreApiMarkdown} … />                 │
  └───────────────────────────────┬──────────────────────────┘
                                  │
  ┌─ View layer (DocPage.tsx) ────▼──────────────────────────┐
  │  ★ buildToc + react-markdown + rehype-slug ★  ← we're here│
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"how does a markdown file in `docs/` become a navigable in-app
page — with a sidebar TOC and deep-linkable sections — on a host with no backend?"* The
answer: inline the file as a string at build, render it with `react-markdown`, and derive
the TOC from the same headings the renderer slugs.

## Structure pass

**Layers:** Vite (inlines the file) → `main.tsx` (passes the string + a `routeToken`) →
`DocPage` (parses TOC, renders, scrolls).

**One axis — *when does the markdown content exist?*** Trace it:

```
  Axis: "when is the doc content resolved?"

  ┌─ build: import '...md?raw' ──────┐   → BUILD time (string baked into the bundle)
  └──────────────┬───────────────────┘
                │
  ┌─ render: react-markdown ─────────┐   → RENDER time (string → DOM, every mount)
  └──────────────┬───────────────────┘
                │
  ┌─ post-render: rAF scrollIntoView ┐   → AFTER layout (one frame later)
  └───────────────────────────────────┘
```

**The seam that matters:** the `?raw` import (`main.tsx:12-13`). That's where a filesystem
path turns into a static string with no runtime `fetch`. Everything downstream is pure
string→DOM. Because the content is resolved at build, the Pages bundle is fully
self-contained — no `/docs/*.md` request ever leaves the browser.

## How it works

### Move 1 — the mental model

You've imported a CSS file or a JSON fixture and had the bundler turn it into a module. `?raw`
is the same move for a `.md` file: instead of parsing or transforming it, Vite hands you its
*text* as the default export. From React's point of view it's just a string prop — no fetch,
no loading state, no error state.

```
  The pattern — file becomes a string at build

  docs/core-api.md ──Vite ?raw──► const coreApiMarkdown = "# AptKit Core API\n..."
                                            │ prop
                                            ▼
                            <DocPage markdown={coreApiMarkdown} />
                                            │
                            ┌───────────────┴───────────────┐
                            ▼                               ▼
                   buildToc(markdown)              react-markdown(markdown)
                   (H2/H3 → slugged TOC)           (string → DOM, rehype-slug ids)
```

### Move 2 — the step-by-step walkthrough

**Inlining the file.** The `?raw` suffix is a Vite import query — it short-circuits the
normal module pipeline and gives you the file's contents as a string. Reached for whenever
content should be a build input rather than a runtime fetch.

```ts
// main.tsx:12-13
import coreApiMarkdown from '../../../docs/core-api.md?raw';
import userGuideMarkdown from '../../../docs/studio-guide.md?raw';
```

The boundary condition: this couples the build to the repo layout — the relative path
reaches three levels up into `docs/`. Move the file and the build breaks at compile time
(which is the good kind of break). The cost is that doc content is frozen at build; editing
a doc requires a rebuild. For a deploy artifact, that's the right trade.

**Deriving the TOC from the source, not the DOM.** Rather than walking the rendered DOM for
headings, `buildToc` parses the markdown text directly — and crucially it slugs each heading
with the *same* `github-slugger` that `rehype-slug` uses on the rendered output, so TOC link
targets line up with the real element ids.

```ts
// DocPage.tsx:11-27
function buildToc(markdown: string): TocEntry[] {
  const slugger = new GithubSlugger();
  const entries: TocEntry[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }   // skip code fences
    if (inFence) continue;                                        // ...so ```# foo``` isn't a heading
    const match = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);        // H2 / H3 only
    if (!match) continue;
    const text = match[2].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();  // strip link syntax
    entries.push({ depth: match[1].length, text, slug: slugger.slug(text) });
  }
  return entries;
}
```

The `inFence` toggle is the part that's easy to miss: without it a `#` inside a fenced code
block (very common in an API doc) would be parsed as a heading and pollute the TOC. That's
the boundary condition the code handles explicitly. `buildToc` is wrapped in `useMemo`
keyed to `markdown` (`DocPage.tsx:46`) — it's the one memoized derivation in the app.

**Rendering with the slug plugin.** `react-markdown` with `remark-gfm` (tables, strikethrough)
and `rehype-slug` (adds `id` to every heading). No sanitizer plugin — acceptable because the
markdown is repo-authored and trusted (audit red flag #5; trust analysis is `study-security`).

```tsx
// DocPage.tsx:95-97
<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]}>
  {markdown}
</ReactMarkdown>
```

**Scrolling to the anchor after layout.** When the route carries a section
(`#api-docs/conversation-memory`), the heading element doesn't exist until after
`react-markdown` renders. So the scroll is deferred one frame with `requestAnimationFrame`.

```tsx
// DocPage.tsx:50-56
React.useEffect(() => {
  if (!anchor) return;
  const id = window.requestAnimationFrame(() => {
    document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
  });
  return () => window.cancelAnimationFrame(id);
}, [anchor]);
```

The rAF is doing real work: schedule the scroll for *after* the browser has laid out the
freshly-rendered markdown, so `getElementById` finds a positioned element. Scroll on the
same tick and you'd target an element with no layout yet. The optional-chaining
(`?.scrollIntoView`) is the boundary guard — a bad anchor scrolls nowhere instead of
throwing.

```
  Layers-and-hops — section deep-link lands on a heading

  ┌─ App ────────────┐ hop1: anchor='conversation-memory' prop
  │ <DocPage anchor/>│ ─────────────────────────────────────────┐
  └──────────────────┘                                           ▼
  ┌─ react-markdown ─┐ hop2: render → <h3 id="conversation-memory">…</h3>
  │ + rehype-slug    │   (rehype-slug computed the id from the heading text)
  └──────────────────┘                                           │
  ┌─ anchor effect ──┐ hop3: rAF (one frame later) → scrollIntoView
  │ DocPage.tsx:50   │   (element now has layout)
  └──────────────────┘
```

### Move 2 variant — the load-bearing skeleton

Three parts make this the pattern:

1. **Build-time inlining** (`?raw`) — drop it and you're back to a runtime `fetch('/docs/...')`
   that fails on the static host or adds a loading state. This is the part that makes the
   Pages build self-contained.
2. **Slug parity** (same `github-slugger` in `buildToc` and `rehype-slug`) — drop it and TOC
   links point at ids that don't exist; every sidebar click scrolls nowhere.
3. **Post-render scroll scheduling** (rAF) — drop it and deep-linking to a section races the
   render and usually lands at the top of the page.

The code-fence skip and the link-syntax stripping in `buildToc` are hardening — they make
the TOC clean, but the pattern works without them.

### Move 3 — the principle

Content that doesn't change between deploys is a build input, not a runtime fetch. Inlining
it removes a network round trip, a loading state, and an error state — three things you'd
otherwise have to design. The cost you accept is that updating content means rebuilding,
which for a deploy artifact is exactly the right coupling.

## Primary diagram

```
  Build-time markdown docs — full picture

  ┌─ Build (Vite) ───────────────────────────────────────────────────────┐
  │  docs/core-api.md ──?raw──► coreApiMarkdown : string  (baked in bundle)│
  └───────────────────────────────────┬───────────────────────────────────┘
                                      │ prop
  ┌─ DocPage (DocPage.tsx) ───────────▼───────────────────────────────────┐
  │  buildToc(markdown) ──useMemo──► [{depth, text, slug}]                  │
  │       │ slugger = GithubSlugger (SAME as rehype-slug)                   │
  │       ▼                                                                 │
  │  <nav> TOC links href=#routeToken/slug ──────────────┐                 │
  │  <ReactMarkdown remark-gfm + rehype-slug>  → headings get id=slug       │
  │  anchor effect: rAF → getElementById(anchor).scrollIntoView ◄──────────┘│
  └───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the same family of trick as `05-fixture-as-build-input.md` — both turn a repo file
into a build-time module instead of a runtime resource. The `?raw` query is Vite's
spelling; Webpack's `raw-loader` / `asset/source` and esbuild's `text` loader do the same
thing. Rendering markdown client-side with `react-markdown` is the lightweight alternative to
a static-site generator (MDX, Docusaurus) — you trade build-time HTML generation for a small
runtime parse, which is fine for two docs but wouldn't scale to hundreds of pages (you'd want
SSG and route-level code-splitting then; both `not yet exercised` here). The slug-parity
detail is the non-obvious glue that makes the in-app TOC and the hash router agree — read
`01-hash-routing-with-section-anchors.md` for the routing half.

## Interview defense

**Q: Why inline the docs at build instead of fetching them?**
The deploy is static GitHub Pages with no server to serve `/docs/*.md`. Inlining via `?raw`
makes the bundle self-contained — no fetch, no loading/error state — and a missing doc fails
at build, not at runtime. The cost is that doc edits need a rebuild; for a deploy artifact
that's the correct coupling.

Anchor: *"content that's frozen per deploy is a build input, not a fetch."*

**Q: How do the sidebar links land on the right heading?**
Both ends use the same `github-slugger`. `buildToc` slugs the heading text for the link
target; `rehype-slug` slugs the same text into the rendered heading's `id`. Same input, same
algorithm, same string — so the link finds the element. The scroll itself is deferred one
rAF so the element has layout before `scrollIntoView` runs.

Anchor: *"slug parity on both ends, then scroll one frame late."*

## See also

- `01-hash-routing-with-section-anchors.md` — the `#view/section` grammar these links use
- `05-fixture-as-build-input.md` — the sibling build-time-import pattern
- `audit.md` — lens 7 (build) and red flag #5 (markdown sanitization)
- `study-security` — the `react-markdown` trust boundary
