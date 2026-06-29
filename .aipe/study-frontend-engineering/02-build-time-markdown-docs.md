# 02 — Build-time markdown docs

**Industry name(s):** static content inlining via `?raw` import + client-side
markdown rendering with slug-anchored TOC. **Type:** Industry-standard pieces
(Vite `?raw`, `react-markdown`, `rehype-slug`) wired into a project-specific
in-app docs viewer.

## Zoom out, then zoom in

The repo's `docs/*.md` files double as in-app pages. There's no CMS, no
`/docs` API route, no fetch — the markdown is *imported as a string at build
time* and rendered in the browser. Here's where it sits.

```
  Where the docs viewer lives

  ┌─ Build (Vite) ──────────────────────────────────────────────┐
  │  docs/core-api.md  ──import …?raw──►  string literal in JS   │
  │  docs/studio-guide.md ──?raw──►       (inlined into bundle)  │
  └───────────────────────────┬─────────────────────────────────┘
                              │  shipped inside the one chunk
  ┌─ UI layer (browser) ─────▼──────────────────────────────────┐
  │  main.tsx passes string → ★ DocPage.tsx ★  ← here            │
  │     ReactMarkdown(remark-gfm, rehype-slug)  +  buildToc()    │
  │     TOC links: #routeToken/<slug>  ──► hash router (file 01) │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"how do you ship browsable, deep-linkable docs in a
zero-backend static demo, reusing the same `.md` files the repo already has?"*
The answer is two moves — inline the source at build, render + index it at
runtime.

## Structure pass

**Layers:** (1) build — Vite turns `?raw` imports into string constants;
(2) parse — `react-markdown` builds an AST and `rehype-slug` stamps ids;
(3) index — `buildToc` produces the sidebar; (4) navigate — TOC links feed the
hash router.

**Axis — *when does the work happen* (lifecycle):**

```
  axis: build-time vs runtime

  ┌ source read ─────┐  BUILD TIME — ?raw inlines the file
  │ docs/core-api.md │  no fetch ever happens
  └────────┬─────────┘
  ┌ parse ─▼─────────┐  RUNTIME — react-markdown parses on render
  │ markdown → AST   │  (re-parsed each mount unless memoized)
  └────────┬─────────┘
  ┌ TOC ───▼─────────┐  RUNTIME — buildToc regex, useMemo'd
  │ headings → links │  (DocPage.tsx:46)
  └──────────────────┘
```

**Seam:** the slug. The TOC builder and the renderer parse the *same string
twice, independently*, and they only agree because both slug headings the same
way (`github-slugger` ≈ `rehype-slug`). That shared-slug contract is the
load-bearing joint — and also the fragility (`audit.md` #4).

## How it works

### Move 1 — the mental model

You know `import logo from './logo.png'` gives you a URL string at build time.
Vite's `?raw` suffix is the same idea for text: `import md from './x.md?raw'`
gives you the file's *contents* as a string, inlined into the bundle. From
there it's a plain markdown render.

```
  The kernel — inline → render → index

   docs/*.md ──(?raw, build)──► string
                                  │
                  ┌───────────────┴───────────────┐
                  ▼                                ▼
         ReactMarkdown(string)            buildToc(string)
         + rehype-slug → <h2 id=slug>     → [{text, slug, depth}]
                  │                                │
                  └──────── same slug ─────────────┘
                            anchors line up
```

### Move 2 — the walkthrough

**Inline the source — Vite `?raw`.**
The markdown enters the app as a string constant, decided at build time.

```ts
// apps/studio/src/main.tsx:12-13
import coreApiMarkdown from '../../../docs/core-api.md?raw';
import userGuideMarkdown from '../../../docs/studio-guide.md?raw';
```

The boundary condition: this is *static* — adding a doc means adding an import
and a route token. There's no dynamic "list all docs" because the bundler needs
each path statically to inline it. That's the cost you pay for needing no
backend.

**Render — `react-markdown` with two plugins.**
`DocPage` renders the string through `react-markdown`, GFM for tables/strikethrough,
`rehype-slug` to stamp `id` attributes on headings.

```tsx
// apps/studio/src/DocPage.tsx:94-98
<article className="docPage">
  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]}>
    {markdown}
  </ReactMarkdown>
</article>
```

`rehype-slug` is the quiet load-bearing plugin: it turns `## Conversation
memory` into `<h2 id="conversation-memory">`, which is the scroll target the
router jumps to. No plugin, no ids, no deep links. Security note: `react-markdown`
does **not** evaluate raw HTML by default and there's no
`dangerouslySetInnerHTML` here, so the markdown render is XSS-safe out of the
box (trust boundary → `study-security`).

**Index — `buildToc`, a hand-rolled heading parser.**
The TOC is built by *re-parsing the same markdown* with a regex, tracking fenced
code blocks so a `## inside a fence` isn't mistaken for a heading.

```ts
// apps/studio/src/DocPage.tsx:11-27
function buildToc(markdown: string): TocEntry[] {
  const slugger = new GithubSlugger();
  const entries: TocEntry[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }  // toggle in/out of code fence
    if (inFence) continue;                                       // skip headings inside code
    const match = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);       // H2/H3 only
    if (!match) continue;
    const text = match[2].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim(); // strip md links
    entries.push({ depth: match[1].length, text, slug: slugger.slug(text) });
  }
  return entries;
}
```

The `inFence` toggle is the part people forget — without it, a `## ` inside a
```` ``` ```` block becomes a phantom TOC entry. The honest weakness: this is a
*second* parser over the same text (`react-markdown` already built an AST), so
the two can drift on exotic headings. The fix is a rehype plugin reading the
shared AST (`audit.md` #4). It's memoized on the markdown string so it runs
once per doc, not per render (`DocPage.tsx:46`).

**Navigate + scroll — the TOC feeds the hash router.**
Each TOC link is a `#routeToken/slug` hash — the exact grammar from file 01 —
so clicking it routes *and* deep-links.

```tsx
// apps/studio/src/DocPage.tsx:85
<a className={`docTocLink h${entry.depth}`} href={`#${routeToken}/${entry.slug}`}>
  {entry.text}
</a>
```

And when an `anchor` arrives in the route, scroll to it *after layout* with rAF
— because the heading element doesn't exist until react-markdown has rendered.

```tsx
// apps/studio/src/DocPage.tsx:50-56
React.useEffect(() => {
  if (!anchor) return;
  const id = window.requestAnimationFrame(() => {
    document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
  });
  return () => window.cancelAnimationFrame(id);
}, [anchor]);
```

The `requestAnimationFrame` is the boundary condition: a synchronous
`getElementById` in the effect would run before the markdown's DOM is painted
and find nothing. rAF defers to the next frame, after layout — the heading
exists, the scroll lands.

### Move 3 — the principle

When content is known at build time and the host has no backend, *inline it*:
turn a fetch into an import and the network round-trip disappears. The cost is
that the content set is static (each doc is an explicit import). The deeper
lesson is the slug contract — two independent passes over the same data only
stay correct if they share the canonical transform; centralize that transform
(`github-slugger` here) or collapse the passes.

## Primary diagram

```
  Build-time docs — the complete picture

  ┌─ BUILD (Vite) ──────────────────────────────────────────────┐
  │  docs/core-api.md  ──?raw──►  const coreApiMarkdown = "…"     │
  └───────────────────────────┬─────────────────────────────────┘
                              ▼  inlined in the one JS chunk
  ┌─ RUNTIME · DocPage.tsx ──────────────────────────────────────┐
  │  buildToc(md) ──► [{text, slug}]   ──► <nav> #token/slug links│
  │       │ (useMemo, same github-slugger)              │         │
  │  ReactMarkdown(remark-gfm, rehype-slug) ──► <h2 id=slug>      │
  │       │                                              │         │
  │  anchor in route? ─► rAF ─► getElementById(anchor).scrollIntoView
  └───────────────────────────┬─────────────────────────────────┘
                              ▼
                   hash router (file 01) updates #token/slug
```

## Elaborate

This is the static-site-generator idea (content compiled in, not fetched) done
at the bundle level instead of with a framework like Next/Astro. The repo gets
it almost free because Vite ships `?raw` and the docs already exist as markdown
for GitHub. The reason it works for the Pages demo specifically: inlining means
the docs viewer needs no server, matching the zero-backend constraint that also
drove the hash router (file 01) and the fixture inlining (`05-…`). Read
`05-fixture-as-build-input.md` next — same build-time-inlining technique applied
to JSON fixtures instead of markdown.

## Interview defense

**Q: Why import the markdown instead of fetching it?**
The deployed demo is a static GitHub Pages bundle with no backend — a fetch to
`/docs/x.md` would need a server or a copied public asset and a network hop.
Vite's `?raw` inlines the file contents as a string at build time, so the docs
ship inside the JS chunk and render with zero requests. Trade-off: the doc set
is static — each doc is an explicit import, no dynamic listing — which is fine
for a fixed handful.

**Q: How do the TOC links land on the right heading?**
Both sides slug headings identically. `rehype-slug` stamps `<h2
id="conversation-memory">` on render; `buildToc` slugs the same heading text
with `github-slugger` for the link `#api-docs/conversation-memory`; even
`StudioHome` pre-slugs with `github-slugger` for its deep links
(`StudioHome.tsx:10`). One canonical slug function on every side = anchors match.

```
  the slug contract — three call sites, one transform

  rehype-slug   →  <h2 id="conversation-memory">     (the target)
  buildToc      →  href="#api-docs/conversation-memory"  (the TOC link)
  StudioHome    →  apiAnchor(heading)                 (the home deep link)
        all three: github-slugger(headingText)
```

**Q: Why the requestAnimationFrame around the scroll?**
The heading element doesn't exist until react-markdown renders the DOM. A
synchronous `getElementById` in the effect runs before paint and returns null.
rAF defers the scroll to the next frame — after layout — so the element is
there. It's cleaned up with `cancelAnimationFrame` to avoid scrolling after
unmount.

**Anchor:** *"Turn the fetch into an import; keep one canonical slug function so
the renderer and the TOC agree on anchors."*

## See also

- `01-hash-router-with-section-anchors.md` — the `#token/slug` grammar this
  feeds, and the receiving scroll.
- `05-fixture-as-build-input.md` — same inlining technique, JSON not markdown.
- `audit.md` → lens 5 (deep-linking), lens 6 (styling of doc pages), #4
  (the double-parse fragility).
- `study-security` — why `react-markdown`'s default sanitization matters here.
