# 01 — Hash router with section anchors

**Industry name(s):** client-side hash routing / fragment routing with a
nested anchor grammar. **Type:** Project-specific (a 40-line hand-roll of a
standard idea).

## Zoom out, then zoom in

You've reached for `react-router` a hundred times. Studio doesn't — and that's
the interesting choice. The whole router is one function, one `useState`, and
one event listener in `main.tsx`. Here's where it sits.

```
  Where the router lives

  ┌─ UI layer (browser SPA) ────────────────────────────────────┐
  │  index.html  →  main.tsx  ★ App() + parseHash() ★  ← here    │
  │                    │                                          │
  │         window.location.hash  ◄── the single source of truth │
  │                    │                                          │
  │     ┌──────────────┴───────────────┐                          │
  │  Workspace components          DocPage (deep-link target)     │
  └──────────────────────────────────────────────────────────────┘
                       │  no server hop — hash never leaves browser
  ┌─ Static host (GitHub Pages, /aptkit/) ──────────────────────┐
  │  serves index.html + one JS chunk; NO SPA 404 fallback       │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the question this answers is *"which screen is showing, and which doc
section should we scroll to — in a way that survives a refresh on a static
host?"* The trick is the hash grammar `#view/section`: the part before the
slash is the route, the part after is a markdown heading slug. One string does
navigation *and* deep-linking.

## Structure pass

**Layers:** (1) the URL hash — the durable, global state; (2) `App`'s route
`useState` — a render-time mirror of the hash; (3) the rendered screen.

**Axis — who owns "which screen is showing":** trace it down.

```
  axis: who is the source of truth for the current view?

  ┌ URL hash ────────────┐  the hash WINS — durable, shareable
  │ #rag-query/...        │  survives refresh, back/forward
  └──────────┬───────────┘
             │  parseHash() reads it; hashchange re-reads it
  ┌ App state ▼──────────┐  a MIRROR, never the truth
  │ useState(parseHash)  │  only exists to trigger re-render
  └──────────┬───────────┘
  ┌ Screen ───▼──────────┐  pure function of route — no own nav state
  │ <RagQueryWorkspace/> │
  └──────────────────────┘
```

**Seam:** the load-bearing boundary is *hash ↔ React state*. The axis flips
there — above it the browser owns truth (and persists it); below it React owns
a disposable copy. Every navigation has to cross this seam exactly once, in one
direction, or you get the classic double-update bug. That seam is the whole
lesson here.

## How it works

### Move 1 — the mental model

You already know the `fetch()` loading/success/error shape: one piece of state,
re-derived when an event fires. A hash router is that, where the "event" is
`hashchange` and the "state" is the parsed route. The browser is the store; you
just subscribe to it.

```
  The kernel — subscribe-to-the-URL loop

   user clicks ──► navigate() ──► set window.location.hash
                                        │
                                        ▼  browser fires
                                   'hashchange' event
                                        │
                                        ▼
                          listener ──► setRoute(parseHash())
                                        │
                                        ▼
                                  App re-renders the matched view
```

The kernel is: **a pure parser (`parseHash`) + a subscription (`hashchange` →
`setState`) + a writer (`navigate`)**. Drop any one and it breaks — that's the
load-bearing skeleton.

### Move 2 — the walkthrough

**The parser — `parseHash()` turns a string into `{view, anchor}`.**
This is the pure function at the center. It strips the `#` (or `#/`), splits on
the *first* slash, validates the view against an allowlist, and treats the rest
as the doc anchor.

```ts
// apps/studio/src/main.tsx:34-42
function parseHash(): { view: StudioView; anchor?: string } {
  const raw = window.location.hash.replace(/^#\/?/, '');       // "#rag-query" → "rag-query"
  if (!raw) return { view: 'home' };                            // empty hash → home
  const slash = raw.indexOf('/');                               // split point
  const token = slash === -1 ? raw : raw.slice(0, slash);       // before / = route
  const anchor = slash === -1 ? undefined : raw.slice(slash + 1) || undefined; // after / = section
  const view = (VIEW_TOKENS as string[]).includes(token)        // allowlist guard…
    ? (token as StudioView) : 'home';                           // …unknown → home, never crashes
  return { view, anchor: view === 'home' ? undefined : anchor };
}
```

The allowlist (`VIEW_TOKENS`, `main.tsx:23-32`) is the boundary condition: a
hand-typed `#nonsense` can't render an undefined component — it falls to home.
That's the "and here's where it breaks if you skip it" guard.

**The subscription — `hashchange` drives `setRoute`.**
`App` seeds state from the parser, then listens. This is the only effect in the
router.

```ts
// apps/studio/src/main.tsx:45-51
const [route, setRoute] = React.useState(parseHash);      // seed from current URL
React.useEffect(() => {
  const onHashChange = () => setRoute(parseHash());        // re-parse on every hash change
  window.addEventListener('hashchange', onHashChange);
  return () => window.removeEventListener('hashchange', onHashChange);
}, []);
```

Because the listener re-parses, **back/forward buttons just work** — the browser
changes the hash, fires the event, the route re-derives. You got history
navigation for free by making the URL the source of truth.

**The writer — `navigate()` and the double-update guard.**
The subtle part. Normally you set the hash and let `hashchange` update state.
But if you navigate to the hash you're *already* on, the browser fires no event
— so state would never sync. `navigate` handles both cases.

```ts
// apps/studio/src/main.tsx:53-60
const navigate = (next: StudioView, anchor?: string) => {
  const hash = next === 'home' ? '' : anchor ? `${next}/${anchor}` : next;
  if (window.location.hash.replace(/^#\/?/, '') === hash) {
    setRoute(parseHash());   // SAME hash → no hashchange will fire → sync state manually
    return;
  }
  window.location.hash = hash;  // DIFFERENT hash → fires hashchange → setRoute runs
};
```

This is the seam from the structure pass, in code: the write crosses hash →
state in exactly one direction, and the `if` handles the one case where the
browser won't bounce the event back. Miss it and clicking the doc link you're
already viewing silently does nothing.

**The render — a flat match, no nested route tree.**
`App` is a straight `if`-ladder over `view` (`main.tsx:65-115`). The two
`DocPage` views pass the `anchor` straight through plus a `routeToken` so the
TOC can build same-grammar links (`main.tsx:89-113`). No `<Routes>`,
no `<Outlet>` — at six screens, a ladder is clearer than a route config.

**Crossing into the doc anchor (layers-and-hops).**
The slash grammar's payoff: a single hash threads from a click all the way to a
scroll inside rendered markdown.

```
  One hash, two layers — route + doc-section deep link

  ┌ Home (UI) ─────────┐ onOpen('api-docs', apiAnchor(heading))
  │ StudioHome.tsx:181 │ ──────────────────────────────────────►
  └────────────────────┘ hop 1: write hash "api-docs/conversation-memory"
                                          │
  ┌ Router (main.tsx) ─────────────────────▼─────────────────────┐
  │ parseHash → {view:'api-docs', anchor:'conversation-memory'}   │
  │ hop 2: render <DocPage routeToken="api-docs" anchor=…/>       │
  └────────────────────────────┬──────────────────────────────────┘
  ┌ DocPage (UI) ──────────────▼──────────────────────────────────┐
  │ hop 3: rAF → getElementById('conversation-memory')            │
  │        .scrollIntoView()   (DocPage.tsx:50-56)                │
  └────────────────────────────────────────────────────────────────┘
```

The anchor slug is produced by `github-slugger` on *both* ends —
`StudioHome.tsx:10` slugs the heading the same way `rehype-slug` will
(`02-build-time-markdown-docs.md`) — so the id always matches. Same string,
two responsibilities, no collision.

### Move 3 — the principle

Make the URL the single source of truth and a router collapses to *parse +
subscribe + write*. A library is worth it when you have nested layouts, loaders,
and code-split boundaries; until then, 40 lines that you fully understand beat a
dependency you partly do. The non-obvious win is correctness, not size: because
the hash is durable, refresh-survival and back/forward come for free — the
exact things a static host (no SPA fallback) would otherwise break.

## Primary diagram

```
  Hash router — the complete picture

  ┌─ Browser URL ─────────────────────────────────────────────┐
  │  #api-docs/conversation-memory   ← durable global state    │
  └───────────┬──────────────────────────────▲─────────────────┘
              │ hashchange                    │ navigate() writes
              ▼                               │
  ┌─ main.tsx App() ──────────────────────────┴─────────────────┐
  │  parseHash() ─► {view, anchor}                               │
  │  useState(route) + useEffect(hashchange listener)            │
  │  if-ladder on view:                                          │
  │   home │ recommendation │ … │ rag-query │ api-docs │ guide   │
  └───────────┬───────────────────────────────┬─────────────────┘
              ▼                                ▼
   <Workspace onHome={…}/>          <DocPage anchor routeToken/>
                                     rAF → scrollIntoView(anchor)
```

## Elaborate

Hash routing predates the History API — it's the original SPA navigation trick,
because the fragment never triggers a server request. The History API
(`pushState`) gave clean paths but *requires* a server (or host) that serves the
SPA shell for every path. GitHub Pages doesn't, and serves under a subpath
(`/aptkit/`), so the older technique is the correct one here, not a fallback.
The `view/section` grammar is the repo-specific twist: most hash routers route
on the whole fragment; Studio reserves the first segment for the route and
hands the rest to the doc layer. Read `02-build-time-markdown-docs.md` next for
the receiving end of that anchor.

## Interview defense

**Q: Why hand-roll a router instead of react-router?**
The deploy is static GitHub Pages with no SPA 404 fallback, under a subpath.
A path router (`pushState`) 404s on refresh there; a hash router can't, because
the fragment never hits the server. At six flat screens with no nested layouts
or loaders, the library's value (nested routes, code-split boundaries, data
APIs) isn't being used — so it'd be 40 lines of my code vs a dependency I'd
only partly exercise. I'd switch the moment I needed nested layouts or
route-level data loading.

```
  path router on static host        hash router on static host
  /aptkit/rag-query  → 404          #rag-query → always serves index.html
  (no fallback configured)          (fragment never leaves the browser)
```

**Q: What's the bug everyone hits writing this?**
Navigating to the hash you're already on. The browser fires `hashchange` only
when the hash *changes*, so re-clicking the current link updates nothing. The
guard at `main.tsx:55` detects the same-hash case and calls `setRoute` directly
instead of relying on the event. That's the load-bearing line people forget.

```
  navigate() decision

  same hash?  ── yes ──► setRoute(parseHash())   // event won't fire; sync now
              ── no  ──► location.hash = next     // event fires; listener syncs
```

**Q: How do back/forward and refresh survive?**
They survive because the URL hash *is* the state, not a copy of it. Refresh →
`useState(parseHash)` re-seeds from the live hash. Back/forward → the browser
mutates the hash → `hashchange` → re-parse. I never persist route state myself;
the browser does.

**Anchor:** *"The URL is the store; the router is just parse + subscribe +
write — and the one line that matters is the same-hash guard."*

## See also

- `02-build-time-markdown-docs.md` — the doc-anchor receiving end (rAF scroll,
  shared slugger).
- `00-overview.md` — where the router sits in the whole app.
- `audit.md` → lens 5 (routing) and lens 8 #1 (no `AbortController`).
- `study-system-design` — the static-host deploy constraint that forces this.
