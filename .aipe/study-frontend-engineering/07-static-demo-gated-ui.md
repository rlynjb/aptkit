# 07 — Static-demo gated UI

**Industry name(s):** build-time feature flag / environment-gated capability degradation (graceful read-only fallback). **Type:** Project-specific.

## Zoom out, then zoom in

Studio has two lives. In local dev it's a full agent runner: the Vite middleware mounts ~20 API routes, and you can fire live model replays, save artifacts to disk, and promote them to fixtures. But it also ships as a **static fixture-only demo on GitHub Pages** — pure HTML/JS/CSS on a CDN, no Node process behind it, no `/api/*` routes to call. Same React bundle, two radically different backends: one real, one absent.

The frontend has to know which world it's in, because in the Pages world every button that would hit `/api/*` is a button that fires a request into the void. The flag that carries this is `STATIC_DEMO`, and it sits right at the UI seam.

```
  Zoom out — where the static-demo flag lives

  ┌─ Build layer (Vite) ─────────────────────────────────────┐
  │  vite build --mode pages   →   VITE_STATIC_DEMO=1         │
  │  base: '/aptkit/'   (vite.config.ts:196)                 │
  └──────────────────────────┬────────────────────────────────┘
                             │  import.meta.env.VITE_STATIC_DEMO
  ┌─ UI layer (browser) ─────▼────────────────────────────────┐
  │  ★ env.ts: STATIC_DEMO = (… === '1') ★   ← we are here    │
  │     │                                                     │
  │     ├─ AgentReplayShell  → skip provider-status fetch     │
  │     ├─ useReplayArtifacts → skip history/promoted fetch   │
  │     └─ every panel       → disable run/save/promote btns  │
  └──────────────────────────┬────────────────────────────────┘
                             │  /api/* calls that DON'T happen
  ┌─ Network boundary ───────▼────────────────────────────────┐
  │  GitHub Pages CDN — static files only, no API routes      │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: `STATIC_DEMO` is a **single boolean read once from `import.meta.env`** that the UI checks at every point it would otherwise touch the network. It's a compile-time constant — Vite inlines it — so the dead branches are eliminated from the Pages bundle. The question it answers: *"is there a backend behind me, or am I a museum exhibit?"*

## Structure pass

**Layers.** Three: the build (which sets the env var per mode), the flag module (`env.ts`, one line), and the consumers (the shell, the hook, and nine panel/workspace components that each gate a button or an effect).

**Axis — trace `capability` (can this UI element actually do its job?) down the layers:**

```
  One question down the layers: "can this element reach a backend?"

  ┌─ build mode = pages ──────────────┐
  │   VITE_STATIC_DEMO = '1'          │   → capability: OFF (decided here)
  └─────────────────┬─────────────────┘
        ┌───────────▼───────────────┐
        │ env.ts: STATIC_DEMO=true  │   → capability: reads as false
        └───────────┬───────────────┘
            ┌───────▼─────────────────┐
            │ button disabled={…||SD} │   → capability: visibly OFF + note
            └─────────────────────────┘

  the same flag flips every network-touching element to read-only
```

**Seam.** The load-bearing boundary is `env.ts` — the one place the raw `import.meta.env.VITE_STATIC_DEMO` string is turned into a typed boolean. Everything downstream imports `STATIC_DEMO`, never the raw env. That's the contract: consumers don't know about Vite modes, they know "am I static." If you ever changed how the mode is detected (a different env name, a runtime check), you'd change `env.ts` and nothing else.

The axis flips hard across that seam: above it you're talking about build configuration; below it you're talking about whether a click does anything.

## How it works

### Move 1 — the mental model

You know the pattern where a `disabled` prop on a button is derived from "is this action currently possible?" — `disabled={!hasSelection}`, `disabled={saving}`. This is that, with one extra term OR'd into every such expression: a global "the backend doesn't exist" term.

```
  The shape: one global term OR'd into every capability gate

  normal gate:     disabled = saving || !canPromote
  static-demo gate: disabled = saving || !canPromote || STATIC_DEMO
                                                        └─ same const
                                                           in every gate

  effects:  useEffect(() => { if (STATIC_DEMO) return; fetch(...) })
                              └─ early-return guard, fetch never fires

  mutations: function save() { if (STATIC_DEMO) { setErr(NOTE); return } … }
                              └─ short-circuit with a user-facing note
```

It shows up in three syntactic forms depending on what it's gating: an extra `|| STATIC_DEMO` in a `disabled` expression, an early `if (STATIC_DEMO) return` at the top of a fetch effect, and an `if (STATIC_DEMO) { set…Error(NOTE); return }` short-circuit inside a mutation.

### Move 2 — the walkthrough

**Part 1 — the flag is read once, typed once.** `env.ts` is two lines: `STATIC_DEMO` and a shared `STATIC_DEMO_NOTE` string. Bridge from what you know: this is the standard "wrap `process.env`/`import.meta.env` in a typed module so the rest of the app imports a boolean, not a stringly-typed env lookup" move. The win is that the string comparison (`=== '1'`) lives in exactly one place. Break it — sprinkle `import.meta.env.VITE_STATIC_DEMO === '1'` across nine files — and a typo in one (`=== 1`, number vs string) silently breaks one screen while the rest work.

```
  Single source of truth for the flag

  ┌─ env.ts ──────────────────────────────────────────┐
  │  STATIC_DEMO = import.meta.env.VITE_STATIC_DEMO    │
  │                === '1'      ← the only comparison  │
  │  STATIC_DEMO_NOTE = 'Available in local dev only.' │
  └───────────────────┬───────────────────────────────┘
                      │ imported by
        ┌─────────────┼──────────────┬──────────────┐
        ▼             ▼              ▼              ▼
   AgentReplayShell  useReplay   *Workspace×5   *panels×3
                     Artifacts                  components.tsx
```

**Part 2 — effects skip the fetch.** In dev, the shell fetches provider status on mount and the hook fetches saved-replay history and promoted fixtures. In static mode, all three start with `if (STATIC_DEMO) return;` — the fetch never fires (`AgentReplayShell.tsx:139`, `useReplayArtifacts.ts:77`, `useReplayArtifacts.ts:94`). Bridge: this is the same early-return-in-effect you'd write to skip a fetch when an id is missing, except the condition is "the server doesn't exist." Break it — let the provider-status fetch run on Pages — and you get a failed request to `/api/model-status` on every page load, a console error, and `providerStatus` left at its default.

```
  Effect-gating — the fetch that doesn't happen

  ┌─ UI layer (Pages build) ─────────────────────────┐
  │  useEffect(() => {                               │
  │    if (STATIC_DEMO) return;   ◄── stops here     │
  │    loadProviderStatus().then(setProviderStatus)  │ ✗ never runs
  │  }, [])                                          │
  └──────────────────────────────────────────────────┘
       (no hop to the network boundary at all)
```

**Part 3 — mutations short-circuit with a visible note.** `saveCurrentReplay` and `promoteSavedReplay` don't just no-op — they set an error slot to `STATIC_DEMO_NOTE` so the user sees *why* nothing happened (`useReplayArtifacts.ts:100-102, 120-122`). Bridge: it's the same "guard at the top of the handler" you'd write for an unauthenticated user, but instead of redirecting it surfaces an inline explanation. Break it — return silently — and the static demo's save button looks broken rather than intentionally disabled.

**Part 4 — buttons render disabled with the note beside them.** Every run/save/promote/refresh button OR's `STATIC_DEMO` into its `disabled` and renders `{STATIC_DEMO ? <div className="errorState compact">{STATIC_DEMO_NOTE}</div> : null}` next to it (e.g. `recommendation-panels.tsx:43,48`; `monitoring-panels.tsx:105,110`; `components.tsx:118,123`). Belt and suspenders: even if a handler's short-circuit failed, the button can't be clicked. This is defense in depth — the effect guard, the mutation guard, and the disabled attribute all enforce the same invariant from three angles.

### Move 3 — the principle

The principle is **derive capability from environment at the seam, then enforce it at every exit point.** One typed flag, read once, OR'd into every gate and early-returned in every effect that would cross the now-absent network boundary. It's the frontend half of a deployment decision (ship the same bundle to two backends) made legible in the UI. The reason it's three layers of enforcement and not one: a disabled button alone is bypassable (re-enable it in devtools and the silent fetch fails ugly); the effect guard and the mutation short-circuit make the read-only contract hold even when the visual gate is defeated.

## Primary diagram

The whole flag, from build mode to the three enforcement points.

```
  Static-demo gating — build mode → flag → three enforcement points

  ┌─ Build (Vite) ────────────────────────────────────────────┐
  │  vite build --mode pages  →  VITE_STATIC_DEMO=1            │
  └───────────────────────────┬────────────────────────────────┘
                              │ inlined by Vite
  ┌─ env.ts (the seam) ───────▼────────────────────────────────┐
  │  STATIC_DEMO: boolean    STATIC_DEMO_NOTE: string          │
  └───┬───────────────────────┬───────────────────────┬────────┘
      │ enforcement 1         │ enforcement 2         │ enforcement 3
      ▼                       ▼                       ▼
  ┌─ effects ────────┐  ┌─ mutations ──────┐  ┌─ buttons ────────┐
  │ if(SD) return    │  │ if(SD){setErr;   │  │ disabled={…||SD} │
  │  → no fetch      │  │   return}        │  │ + inline NOTE    │
  └──────────────────┘  └──────────────────┘  └──────────────────┘
        │                      │                      │
        └──────────────────────┴──────────────────────┘
                  all uphold: "no /api/* on Pages"
```

## Implementation in codebase

**Use cases.** Exactly one trigger: building Studio for GitHub Pages. `npm run build:pages` runs `vite build --mode pages` (`apps/studio/package.json:9`), which loads `VITE_STATIC_DEMO=1` from `.env.pages` (`apps/studio/.env.pages`) and sets the bundle's `base` to `/aptkit/` so asset URLs resolve under the project-pages path (`vite.config.ts:196`). The deployed demo lets anyone browse recorded fixtures and replay them deterministically client-side, with every live-backend affordance switched off. In normal `npm run dev`, `VITE_STATIC_DEMO` is unset, `STATIC_DEMO` is `false`, and the dead branches above never execute.

**Code side by side.**

```
  apps/studio/src/env.ts  (lines 1–2)

  export const STATIC_DEMO =
    import.meta.env.VITE_STATIC_DEMO === '1';   ← the only comparison;
                                                   Vite inlines it to a
                                                   literal at build time
  export const STATIC_DEMO_NOTE =
    'Available in local dev only.';             ← one string reused at
                                                   every disabled button
       │
       └─ everything downstream imports these two names, never the raw
          import.meta.env — that's the seam (change detection here only)
```

```
  apps/studio/src/useReplayArtifacts.ts  (lines 76–79, 98–103)

  React.useEffect(() => {
    if (STATIC_DEMO) return;        ← Pages build: history fetch never fires
    void refreshReplayHistory();    ← dev only: GET /api/replays
  }, [refreshReplayHistory]);

  const saveCurrentReplay = React.useCallback(async () => {
    if (!replay) return;
    if (STATIC_DEMO) {
      setSaveError(STATIC_DEMO_NOTE); ← visible "why nothing happened"
      return;                          ← short-circuit before any POST
    }
    …
       │
       └─ effect guard + mutation guard enforce the read-only contract
          independently of the disabled button (defense in depth)
```

```
  apps/studio/src/recommendation-panels.tsx  (lines 43–48)

  <button … onClick={onRun}
    disabled={running || !openaiAvailable || STATIC_DEMO}>  ← 3rd enforcement
    Run
  </button>
  {STATIC_DEMO
    ? <div className="errorState compact">{STATIC_DEMO_NOTE}</div>  ← inline note
    : null}
       │
       └─ same shape repeats for save/promote/refresh across
          monitoring-panels.tsx, components.tsx, and all five workspaces
```

## Elaborate

This is a build-time feature flag — the cheapest kind, because the flag is a compile-time constant and the unused branches get tree-shaken out of the Pages bundle entirely (no runtime cost, no dead code shipped). It's the frontend complement to a deployment decision that lives mostly in `study-system-design` (one app, two deploy targets — dev server with a live Node backend vs. a static CDN artifact). The pattern generalizes to any "demo mode," "read-only mode," or "offline mode" where the same UI must degrade gracefully when a capability isn't present. The discipline that makes it safe is the single seam (`env.ts`) plus multi-point enforcement — flags scattered as raw env reads, or enforced at only one layer, are how demo modes ship broken buttons.

## Interview defense

**Q: You ship the same React bundle to a live dev server and a static CDN. How does the UI avoid firing API calls that 404 on the CDN?**

```
  one flag, read at the seam, enforced three ways

  env.ts ──► STATIC_DEMO ──┬─► effect: if(SD) return  (no fetch)
                           ├─► mutation: short-circuit + note
                           └─► button: disabled + inline note
```

Answer: a single build-time flag (`VITE_STATIC_DEMO`, surfaced as `STATIC_DEMO` in `env.ts`), inlined by Vite per `--mode`. It's enforced at three points — fetch effects early-return, mutations short-circuit with a user-facing note, and every network-touching button is `disabled` with the note rendered beside it. **Anchor:** the seam is `env.ts`; the three enforcement points are the load-bearing detail.

**Q: Why three enforcement layers and not just disabling the button?**

Answer: a disabled button is a UI affordance, not a guarantee — re-enable it in devtools and the underlying fetch fires against a backend that isn't there, giving an ugly unhandled rejection. The effect guard and the mutation short-circuit make the read-only contract hold regardless of the visual state. Defense in depth for the same invariant. **Anchor:** "the button is the affordance; the effect and mutation guards are the contract."

## Validate

1. **Reconstruct:** from memory, name the one file that turns the env var into a boolean and the three syntactic forms the flag takes downstream. (Answer: `env.ts`; `|| STATIC_DEMO` in `disabled`, `if (STATIC_DEMO) return` in effects, `if (STATIC_DEMO) { setErr(NOTE); return }` in mutations.)
2. **Explain:** why does `saveCurrentReplay` set an error string instead of just returning? (`useReplayArtifacts.ts:100-102` — so the static demo explains itself rather than looking broken.)
3. **Apply:** you add a new "export replay as CSV" button that calls `/api/export`. What three things must you wire so it behaves on Pages? (Effect/handler guard, `|| STATIC_DEMO` in its `disabled`, and the inline `STATIC_DEMO_NOTE`.)
4. **Defend:** someone proposes reading `import.meta.env.VITE_STATIC_DEMO` directly in each component to "avoid the import." Why is `env.ts` better? (Single comparison, single source of truth; a stringly-typed comparison duplicated nine times is nine chances for a `=== 1` vs `=== '1'` bug.)

## See also

- `00-overview.md` — the build-mode line and the component tree this rides on.
- `audit.md` — lens 7 (browser-platform-and-build) names the `pages` mode and `base: '/aptkit/'`; lens 2/4 note the effect-guard short-circuits.
- `06-replay-artifact-hook.md` — the save/load/promote lifecycle that this flag gates in static mode.
- `05-fixture-provider-mode-switch.md` — provider availability gating, which `STATIC_DEMO` overrides (no status fetch on Pages).
- Cross-guide: `study-system-design` (one app, two deploy targets — dev Node server vs. static CDN artifact).
