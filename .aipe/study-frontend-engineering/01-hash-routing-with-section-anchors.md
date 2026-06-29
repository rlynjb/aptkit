# Hash routing with section anchors

**Industry name(s):** client-side hash routing / fragment-based routing, with deep-linking
to in-page anchors. **Type:** Industry standard (the routing pattern); project-specific in
its `#view/section` grammar.

## Zoom out, then zoom in

Studio is a static SPA with no server to answer arbitrary paths — so the router can't use
the History API (`/api-docs` would 404 on refresh against GitHub Pages). It uses the URL
fragment instead. Here's where the router (the hash router in `main.tsx`) sits.

```
  Zoom out — where the router lives

  ┌─ URL / Platform layer ───────────────────────────────────┐
  │  window.location.hash   ──hashchange event──►             │
  └───────────────────────────────┬──────────────────────────┘
                                  │
  ┌─ App layer (main.tsx) ────────▼──────────────────────────┐
  │  ★ parseHash → navigate → App if-ladder ★   ← we're here │
  └───────────────────────────────┬──────────────────────────┘
                                  │ renders one view
  ┌─ View layer ──────────────────▼──────────────────────────┐
  │  StudioHome · 5 agent workspaces · RagQuery · DocPage     │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the question this answers is *"which page is showing, and which section of it,
expressed as a single bookmarkable URL that survives a refresh on a static host?"* The
answer is a fragment grammar: `#view` for a page, `#view/section` for a page scrolled to an
anchor. No router library — about 25 lines of code.

## Structure pass

**Layers:** the platform (`window.location.hash` + the `hashchange` event) → the App
(`parseHash`, `navigate`, the route `useState`) → the views.

**One axis — *who owns the current route?*** Trace it down:

```
  Axis: "who is the source of truth for the active route?"

  ┌─ platform: window.location.hash ─┐   → THE URL owns it (canonical)
  └──────────────┬───────────────────┘
                │ hashchange
  ┌─ App: route useState ────────────┐   → React MIRRORS the URL (derived copy)
  └──────────────┬───────────────────┘
                │ props
  ┌─ View: onOpen / onHome ──────────┐   → views REQUEST a change, never own it
  └───────────────────────────────────┘
```

**The seam that matters:** the `hashchange` listener (`main.tsx:47-51`). That's where
control flips — above it the URL is the authority; below it React state is just a synced
mirror. Every navigation, whether from a click or the browser back button, funnels through
that one event. Map that seam and the whole router is obvious.

## How it works

### Move 1 — the mental model

You already know the shape: it's a controlled input, but the "input" is the URL. The URL is
the value, `hashchange` is the `onChange`, and `setRoute` is the state setter that mirrors
it back. You never set React state *and* the URL independently — you write the URL, and the
URL tells React what to render. That one-way discipline is the whole trick.

```
  The pattern — URL as the controlled value

         write hash                         hashchange fires
   navigate() ───────► window.location.hash ───────────────► setRoute(parseHash())
        ▲                                                          │
        │                                                          ▼
   view calls onOpen                                        App re-renders the view
        └──────────────────── round trip ────────────────────────┘

   back/forward button ──► (same hashchange) ──► setRoute   ← free history, no extra code
```

### Move 2 — the step-by-step walkthrough

**The route grammar — `#view/section`.** A bare token is a page; everything after the first
slash is an in-page anchor. This is reached for whenever a doc page needs to deep-link to a
heading without the anchor colliding with the route name.

```ts
// main.tsx:34-42
function parseHash(): { view: StudioView; anchor?: string } {
  const raw = window.location.hash.replace(/^#\/?/, '');   // strip "#" and optional "#/"
  if (!raw) return { view: 'home' };                       // empty hash → home
  const slash = raw.indexOf('/');
  const token = slash === -1 ? raw : raw.slice(0, slash);  // before "/" = view
  const anchor = slash === -1 ? undefined : raw.slice(slash + 1) || undefined; // after = section
  const view = (VIEW_TOKENS as string[]).includes(token) ? (token as StudioView) : 'home';
  return { view, anchor: view === 'home' ? undefined : anchor };
}
```

The boundary condition: an unknown token falls back to `home` (`:40`) — so a stale or
mistyped URL never renders a blank screen. Note the anchor is *not* validated (red flag #3
in `audit.md`): `#api-docs/bogus` is a valid route that simply scrolls nowhere.

**Subscribing to the URL.** The `hashchange` listener is the single seam where the URL
drives React. Mount once, clean up on unmount.

```ts
// main.tsx:47-51
React.useEffect(() => {
  const onHashChange = () => setRoute(parseHash());
  window.addEventListener('hashchange', onHashChange);
  return () => window.removeEventListener('hashchange', onHashChange);
}, []);
```

This is what gives you back/forward navigation for free — the browser updates the hash, the
event fires, React re-renders. You wrote zero history code.

**Navigating — write the URL, not the state.** `navigate` builds the hash string and assigns
it. Assigning a *different* hash fires `hashchange` (which calls `setRoute`); assigning the
*same* hash fires nothing, so there's an explicit guard that syncs state directly.

```ts
// main.tsx:53-60
const navigate = (next: StudioView, anchor?: string) => {
  const hash = next === 'home' ? '' : anchor ? `${next}/${anchor}` : next;
  if (window.location.hash.replace(/^#\/?/, '') === hash) {
    setRoute(parseHash());   // already on this hash → no hashchange will fire; sync manually
    return;
  }
  window.location.hash = hash;   // fires hashchange → setRoute
};
```

That same-hash guard is the part people forget. Without it, clicking a link to the page
you're already on does nothing — the event never fires, so a re-click of "API Reference →
same section" would feel dead.

**Dispatching to a view.** `App` is a flat if-ladder over the parsed view
(`main.tsx:65-115`). Doc views thread the `anchor` and a `routeToken` down so `DocPage` can
both scroll to the section and build section links in the same grammar.

```
  Layers-and-hops — a deep-link click to a doc section

  ┌─ StudioHome ─────────┐ hop1: onOpen('api-docs', apiAnchor('6. Retrieval (RAG)'))
  │ packageItem button   │ ──────────────────────────────────────────────┐
  └──────────────────────┘                                                ▼
  ┌─ App.navigate ───────┐ hop2: window.location.hash = 'api-docs/6-retrieval-rag'
  │ builds #view/section │ ───────────────────────────────────────────────┐
  └──────────────────────┘                                                 ▼
  ┌─ DocPage ────────────┐ hop3: rAF → getElementById('6-retrieval-rag').scrollIntoView
  │ anchor effect        │   (rehype-slug gave the heading that exact id)
  └──────────────────────┘
```

The slug on both ends must match, which is why `StudioHome` uses the *same* slugger as the
renderer (`StudioHome.tsx:9-10`):

```ts
// StudioHome.tsx:9-10 — slug a heading the same way rehype-slug does in DocPage
const apiAnchor = (heading: string) => new GithubSlugger().slug(heading);
```

### Move 2 variant — the load-bearing skeleton

Strip the router to its kernel and three parts survive:

1. **A parser** (`parseHash`) — URL string → `{ view, anchor }`. Drop it and you can't
   render the right page from a cold load or a refresh.
2. **A subscriber** (the `hashchange` effect) — drop it and back/forward and any external
   hash change stop updating the UI; the URL and the screen drift apart.
3. **A writer with a same-hash guard** (`navigate`) — drop the guard and same-page
   navigations silently no-op.

Everything else — the `VIEW_TOKENS` allowlist, the `home` fallback, the `routeToken`
threading — is hardening, not skeleton. The allowlist is what keeps a garbage token from
reaching a view; the fallback is what keeps the screen from going blank.

### Move 3 — the principle

Make the URL the single source of truth and treat React state as its mirror. The moment you
let a click set component state *and* the URL on two separate paths, the back button breaks
and deep links rot. One direction — write the URL, read it back — and history, refresh, and
bookmarking all come for free.

## Primary diagram

```
  Hash routing with section anchors — full picture

  ┌─ Platform ────────────────────────────────────────────────────────────┐
  │  window.location.hash = "api-docs/6-retrieval-rag"                      │
  │        ▲ navigate() writes                  │ hashchange fires          │
  └────────┼─────────────────────────────────────┼───────────────────────┘
           │                                      ▼
  ┌─ App (main.tsx) ──────────────────────────────────────────────────────┐
  │  parseHash() → { view:'api-docs', anchor:'6-retrieval-rag' }            │
  │  setRoute(...)  → if-ladder → <DocPage routeToken anchor … />           │
  └───────────────────────────────────┬───────────────────────────────────┘
                                      │ props: anchor, routeToken
  ┌─ DocPage (view) ──────────────────▼───────────────────────────────────┐
  │  buildToc() slugs headings ──┐  rAF → getElementById(anchor).scrollIntoView│
  │  TOC links href=#routeToken/slug ┘  (same github-slugger as StudioHome) │
  └───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

Hash routing predates the History API; it's the original SPA routing trick precisely because
the fragment never hits the server — the browser keeps it client-side. React Router and
TanStack Router default to History-API routing now, which needs a server (or host) that
rewrites unknown paths to `index.html`. GitHub Pages doesn't do that rewrite, so hash
routing is the *right* call here, not a legacy one — the comment at `main.tsx:18-22` says
exactly this. The `#view/section` grammar is a small extension: it reuses the fragment for
two jobs (route + scroll target) by splitting on the first slash, which works because
`rehype-slug` already gives every heading a stable id. Read next:
`02-build-time-markdown-docs.md` for how those headings/anchors are produced.

## Interview defense

**Q: Why hash routing instead of the History API / a router library?**
The deploy target is static GitHub Pages under `/aptkit/` with no SPA fallback — a
History-API route would 404 on refresh. The fragment stays client-side, so refresh and deep
links work with zero server config. A library would add a dependency for ~25 lines I don't
need.

```
  /api-docs   (History API)  → GET /aptkit/api-docs → 404 (no such file)
  #api-docs   (hash)         → GET /aptkit/         → 200, JS reads the fragment ✓
```

Anchor: *"the fragment never hits the server — that's why it survives a static host."*

**Q: What's the part of a hand-rolled router people get wrong?**
The same-hash guard. Assigning `location.hash` to its current value fires no `hashchange`,
so a navigation to the page you're already on does nothing unless you sync state manually
(`main.tsx:55-57`).

Anchor: *"write the URL, read it back — except when the URL didn't change, then sync by hand."*

## See also

- `00-overview.md` — the state-ownership diagram (URL state)
- `02-build-time-markdown-docs.md` — where the slug anchors come from
- `audit.md` — lens 5 (routing) and red flag #3 (unchecked anchor)
- `study-runtime-systems` — `hashchange` as an event source; rAF scheduling
