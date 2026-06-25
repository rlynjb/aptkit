# 04 — Hand-rolled router

**Industry names:** state-based view switch · "router-in-a-`useState`" · conditional-render navigation. **Type:** Project-specific (a deliberate non-use of react-router).

---

## Zoom out — where this lives

The "router" is the top of the tree and nothing more than one piece of state in `App()`.

```
  Where the router sits

  ┌─ UI layer (browser) ──────────────────────────────────────┐
  │  main.tsx App()                                            │
  │    const [view, setView] = useState<StudioView>('home')    │ ← we are here
  │            ★ THIS CONCEPT ★                                │
  │      view==='home'        → <StudioHome onOpen={setView}/> │
  │      view==='recommendation' → <RecommendationWorkspace …/>│
  │      … 8 more branches …                                   │
  │  (no URL, no history, no react-router)                     │
  └────────────────────────────────────────────────────────────┘
```

The question: **how does a 10-view single-user dev tool switch screens without a router library?** You already know `react-router` and what it buys (URL sync, history, nested routes, lazy boundaries). The interesting thing here is the *choice not to use it* — and why that's correct for this app rather than lazy.

## Structure pass

Axis — **"what is the source of truth for which screen is shown?"** — across the candidate designs.

```
  axis: "where does 'current screen' live?"

  ┌─ react-router design ─────────────────────┐
  │  URL (location.pathname) is the truth      │  → browser owns it
  └───────────────────────┬─────────────────────┘
                          │  the seam: who owns navigation state
  ┌─ Studio's design ─────▼─────────────────────┐
  │  a useState in App() is the truth           │  → React owns it
  └───────────────────────────────────────────────┘
```

- **Layers:** there's effectively one — `App()` holds `view`, and rendering branches on it. There is no route table, no matcher, no history layer.
- **The seam that's *missing*** is the URL↔state sync. react-router's whole job is keeping `location` and component tree in agreement; Studio simply doesn't have a URL contract, so there's nothing to sync. Removing that seam is what removes the dependency.
- **What flips by not having it:** deep-linking, back-button, refresh-survival. All become "no" — traced honestly below.

## How it works

### Move 1 — the mental model

A router, stripped to its core, is a function from "where am I" to "what to render." react-router makes "where am I" the URL. Studio makes it a local enum. Same function, cheaper input.

```
  The pattern: view enum → conditional render

         view: 'home' | 'recommendation' | 'monitoring' | …
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
     'home'          'recommendation'   'monitoring'  …
       │                 │                 │
   <StudioHome/>   <RecommendationWS/>  <MonitoringWS/>

   navigation = setView(next)
   "back home" = setView('home')
```

Strategy in one line: **`view` is an enum in state; navigation is `setView`; rendering is a chain of equality checks.**

### Move 2 — the walkthrough

#### Part A — the view enum as the route table

`StudioView` is a ten-member string union (`types.ts:143-153`): `'home' | 'recommendation' | 'monitoring' | 'diagnostic' | 'query' | 'rubric-improvement' | 'rag-query' | 'capabilities' | 'api-docs' | 'user-guide'`. This *is* the route table — the compiler enforces that `setView` only ever receives a known view, which a string-based URL router can't do without runtime parsing. The last two members (`api-docs` / `user-guide`) are doc routes, and they're the one place a single component serves *two* routes: both branches render `<DocPage>` with a different markdown prop (`main.tsx:50-70`) — the route distinguishes content, not component.

What breaks without the union (if `view` were `string`): typos like `setView('reccomendation')` would compile and silently fall through to the `home` default. The union turns the route set into a compile-time contract.

#### Part B — navigation as prop-passed setters

Down-navigation: `StudioHome` receives `onOpen: (view) => void` and each card calls `onOpen('recommendation')` (`StudioHome.tsx:64`). Up-navigation: every workspace receives `onHome: () => void` wired to `() => setView('home')` (`main.tsx:23`). There's no navigation *object* threaded through context — just two callback props.

```
  navigation wiring (pseudocode)

  App:        setView is the only mutator
  → StudioHome onOpen={setView}        // cards call onOpen('query'), etc.
  → Workspace  onHome={()=>setView('home')}  // Home button resets
```

What breaks without passing `onHome` everywhere: a workspace would have no way back, since there's no global navigate(). The tradeoff: navigation is explicit and local (easy to trace) but can't be triggered from arbitrary depth without prop-drilling. At two levels deep, prop-drilling is fine.

#### Part C — the render branch with a default

`App()` is a sequence of `if (view === X) return <X/>` ending in a fallback `return <StudioHome/>` (`main.tsx:22-72`). The fallback is the "404 → home" of this router: any unhandled view lands on home. Because the input is a typed enum, the fallback is only reachable for `'home'` itself — not a real 404, just the base case.

What breaks if you forgot the fallback: a missing branch would render `undefined`, a blank screen. The trailing `return <StudioHome/>` guarantees something always renders.

#### Part D — the HMR root guard (a related platform detail)

Not strictly routing, but it lives in the same file and matters for the SPA mount: `window.__aptkitStudioRoot ??= createRoot(...)` (`main.tsx:75-76`). Vite hot-reloads `main.tsx` on edit; without stashing the root on `window`, each reload would call `createRoot` again on the same DOM node, which React warns about and which can double-mount. The `??=` makes root creation idempotent across HMR.

### Move 2.5 — current vs future state

```
  current (shipped)                future (if multi-user / shareable)
  ────────────────────             ──────────────────────────────────
  view in useState                 view derived from location.hash
  no URL, no deep-link             #/monitoring deep-links + bookmarks
  back-button exits app            popstate listener → setView
  refresh → home                   refresh → same workspace

  migration cost: tiny. Add a useEffect that reads/writes
  location.hash and a popstate listener. The 10 branches in App()
  DON'T change — only the source of `view` does.
```

One nuance the doc routes add: `DocPage` already does fragment-based intra-page navigation. Its TOC renders `#slug` anchor links (`DocPage.tsx:71`) matched to `rehype-slug` heading ids, so jumping within a long doc already uses `location.hash` for *scroll position*. That's orthogonal to the view router — the hash addresses a heading inside the current view, not the view itself — but it means the codebase already touches the exact API (`location.hash`) a future view-router upgrade would lean on.

The takeaway is what *doesn't* change: the entire view-switch stays; you'd only swap where `view` is read from. That's the payoff of keeping the router this thin — upgrading it later is additive, not a rewrite.

### Move 3 — the principle

A router is a function from location to view; the location can be a URL or a local enum, and you pick based on whether anyone needs to *address* a view from outside the running app. No deep-linking requirement, single user, fresh session each time → an enum in state is the honest minimum. Reaching for react-router here would add a dependency and a URL contract to maintain for zero realized benefit. Match the routing machinery to the actual addressing need.

## Primary diagram

```
  Hand-rolled router — the state machine

                    ┌──────────┐
       onHome()     │  'home'  │  setView('home')
    ┌──────────────►│ StudioHome│◄──────────────┐
    │               └────┬─────┘                │
    │      onOpen(view)  │ (one card → one view)│
    │   ┌──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┐
    │   ▼      ▼      ▼      ▼      ▼      ▼      ▼      ▼      ▼
    │ recommend mon  diag  query rubric rag-  capabil api-   user-
    │ Workspace                         query ities   docs   guide
    │                                   WS            └─ DocPage ─┘
    └───┴──────┴──────┴──────┴──────┴──────┴──────┴──── onHome ──┘
        every page's onHome ──► back to 'home'

  source of truth: useState<StudioView> in App()  (main.tsx:20)
  10 views · api-docs + user-guide both render DocPage
  no URL · no history · no back-button · fallback = home
```

## Implementation in codebase

### Use cases

Every screen transition in Studio. Open a capability from the gallery → `onOpen(view)` (`StudioHome.tsx:35,47,59,…`). Return to the gallery → the Home button in `AgentReplayShell`'s topbar (`AgentReplayShell.tsx:193`) or `CapabilitiesWorkspace`'s topbar (`CapabilitiesWorkspace.tsx:159`) calls `onHome`. That's the complete navigation surface — there is no other way to move between screens.

### Code, line by line

```
  apps/studio/src/main.tsx:19-73  — the whole router

  function App() {
    const [view, setView] = React.useState<StudioView>('home');  ← the route table = state

    if (view === 'recommendation')
      return <RecommendationWorkspace onHome={() => setView('home')} />;  ← up-nav prop
    if (view === 'monitoring')      return <MonitoringWorkspace …/>;
    if (view === 'diagnostic')      return <DiagnosticWorkspace …/>;
    if (view === 'query')           return <QueryWorkspace …/>;
    if (view === 'rubric-improvement') return <RubricImprovementWorkspace …/>;
    if (view === 'rag-query')       return <RagQueryWorkspace …/>;   ← custom page, not the shell
    if (view === 'capabilities')    return <CapabilitiesWorkspace …/>;
    if (view === 'api-docs')                                         ← same component,
      return <DocPage title="API Reference" markdown={coreApiMarkdown} …/>;
    if (view === 'user-guide')                                       ← different markdown prop
      return <DocPage title="Studio Guide …" markdown={userGuideMarkdown} …/>;

    return <StudioHome onOpen={setView} />;   ← default branch = 'home'; setView IS the navigate()
  }
       │
       └─ no Routes, no <Link>, no useNavigate. The string-union type on
          `view` (types.ts:143-153) is the compile-time route table; the
          trailing return is the fallback. setView passed directly as
          onOpen means a card click is one setState. The two doc branches
          prove a route is just "(condition → element)" — one component,
          two routes, the markdown prop is the only difference.
```

```
  apps/studio/src/main.tsx:75-77  — idempotent SPA mount (HMR-safe)

  const rootHost = window as Window & { __aptkitStudioRoot?: … };
  rootHost.__aptkitStudioRoot ??= createRoot(document.getElementById('root')!);  ← create once
  rootHost.__aptkitStudioRoot.render(<App />);
       │
       └─ ??= stashes the root on window so Vite HMR reloading main.tsx
          reuses the existing root instead of double-creating it
```

```
  apps/studio/src/StudioHome.tsx:7,35  — down-navigation from the gallery

  export function StudioHome({ onOpen }: { onOpen: (view: StudioView) => void }) {  ← StudioHome.tsx:8
    …
    <CapabilityCard … onOpen={() => onOpen('recommendation')} />   ← :64  card → setView
```

## Elaborate

State-based view switching is the pattern every React app starts with before it grows a routing need; the discipline is recognizing when it's *enough* versus when the app has crossed into needing addressable, shareable, history-aware navigation. The line is usually: do users need to bookmark or share a specific view, deep-link from outside, or expect the back button to work? For a public product the answer is almost always yes (and react-router or the framework router — Next's file routing, etc. — earns its place). For an internal single-user dev tool launched fresh each session, the answer is no, and the enum-in-state is the correct minimum. The migration path stays cheap precisely because the view-switch is decoupled from where `view` comes from — the same reason `01`/`02`/`03` keep their seams clean.

What to read next: `03-shared-replay-shell.md` (what each route renders), then `study-system-design` for how the routing decision fits the overall single-user architecture.

## Interview defense

**Q: Why no react-router?**
Studio is a single-user dev tool, launched fresh each session, with no requirement to deep-link, bookmark, or share a view. react-router's value — URL↔tree sync, history, nested routes — would be a dependency and a URL contract maintained for zero realized benefit. So routing is one `useState<StudioView>` in `App()`, navigation is `setView`, and the string union is the compile-time route table.

```
  view: enum (useState) → if/return branches → fallback 'home'
```
Anchor: `main.tsx:19-73`, type at `types.ts:143-153`.

**Q: What did you give up, and what's the upgrade cost?**
Deep-linking, back-button, refresh-survival. The upgrade is cheap and additive: derive `view` from `location.hash`, add a `popstate` listener, write the hash on navigate. The ten render branches don't change — only the source of `view` does. Keeping the router thin is what keeps that migration small.

**Q: How is this not just a typo waiting to happen?**
The `StudioView` union makes `setView('reccomendation')` a compile error. A string-URL router would only catch that at runtime. The type *is* the route table.

## Validate

1. **Reconstruct:** write `App()` from memory — the `useState<StudioView>`, the branch chain, the fallback. (`main.tsx:19-73`)
2. **Explain:** why is `view` a string union rather than a plain `string`, and what does that catch? (Compile-time route validity; typo'd `setView` calls fail to compile — `types.ts:143`.)
3. **Apply:** make Monitoring deep-linkable at `#/monitoring`. What changes, what doesn't? (Add a hash-read effect + `popstate` listener feeding `setView`, and write hash on navigate; the seven branches are untouched.)
4. **Defend:** a teammate says "just add react-router, it's standard." Argue the call. (No addressing requirement, single user, fresh sessions; the dependency and URL contract buy nothing here, and the enum gives compile-time route safety react-router can't.)

## See also

- `03-shared-replay-shell.md` — what the workspace routes render.
- `00-overview.md` — the component tree the router sits atop.
- Cross-guide: `study-system-design` (single-user architecture fit).
