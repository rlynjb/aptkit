# 03 — Shared replay shell

**Industry names:** render-prop / slot composition · generic container component · "shell with injected body." **Type:** Industry standard (render props + generics), applied as a project-specific agent-replay container.

---

## Zoom out — where this lives

One component sits between the router and every agent workspace, owning the parts that are identical across all of them.

```
  Where the shell sits

  ┌─ UI layer (browser) ──────────────────────────────────────┐
  │  App (router §04)                                          │
  │    └ RecommendationWorkspace ┐                             │
  │      MonitoringWorkspace ─────┤                            │
  │      DiagnosticWorkspace ─────┼─► AgentReplayShell<F,M,R>  │ ← we are here
  │      QueryWorkspace ──────────┤      ★ THIS CONCEPT ★      │
  │      RubricImprovementWorkspace┘                           │
  │           each = ~25-line config adapter                   │
  │      AgentReplayShell owns: run lifecycle, fixture/mode    │
  │      selectors, provider status, live trace, metrics bar   │
  │      and delegates the body via renderPanels(context)      │
  └────────────────────────────────────────────────────────────┘
```

The question: **five agents have wildly different outputs (recommendations, anomalies, a diagnosis, a prose answer, a rubric score) but an identical run lifecycle — how do you write that lifecycle once?** You know this shape from any layout component you've built: a `<Page>` that owns the header/nav/footer and renders `{children}` for the body. This is that, except the shell also owns *state and behavior*, not just chrome, and it hands the body a typed `context` rather than bare `children`.

## Structure pass

Axis — **"who owns this concern, the shell or the workspace?"** — traced across the layers.

```
  axis: "shell-owned or workspace-owned?"

  ┌─ run lifecycle (start, runId, running, error) ─┐  SHELL owns
  ├─ fixture + mode selection, provider status ────┤  SHELL owns
  ├─ live trace state (§01, §02) ──────────────────┤  SHELL owns
  │              ═══════ the seam ═══════           │
  ├─ what an "output" looks like ──────────────────┤  WORKSPACE owns
  ├─ which metrics to show ────────────────────────┤  WORKSPACE owns
  └─ how to run a fixture / call the server ───────┘  WORKSPACE owns
```

- **Layers:** generic shell (no agent knowledge) → render-prop slots → concrete workspace (all agent knowledge).
- **The seam** is the `AgentReplayShellContext<F, M, R>` object (`AgentReplayShell.tsx:30-46`). It's the contract: the shell promises to hand the workspace `{ fixture, mode, replay, visibleTrace, usage, costEstimate, running, error, startReplay, ... }`; the workspace promises to turn that into JSX. Ownership flips exactly here.
- **The generics `<F, M, R>`** are what make the seam typed rather than `any`: F = fixture type, M = mode union, R = result shape. Each workspace pins them (`RecommendationWorkspace.tsx:17-21`) so the context is fully typed inside `renderPanels`.

## How it works

### Move 1 — the mental model

A render prop is just "pass a function that returns JSX, and call it with data you computed." The shell does all the stateful work, then calls `renderPanels(context)` and `metricItems(context)` to get the body and the metrics bar. The workspace is a function of the run state, not a holder of it.

```
  The pattern: shell computes context, slots render it

   AgentReplayShell
     ├─ owns state: fixture, mode, replay, liveTrace, running…
     ├─ runs lifecycle: startReplay → runFixture | runServer
     ├─ derives: visibleTrace, usage, costEstimate
     │
     ├─ builds context = { …all of the above + setters }
     │
     ├─ <section metrics> { metricItems(context) } </section>   ← slot 1
     └─ { renderPanels(context) }                               ← slot 2
              ▲                         ▲
              │                         │
        workspace supplies        workspace supplies
        a metrics renderer        a panels renderer
```

Strategy in one line: **the shell is a closure over the run state; the workspace is two pure render functions of that state.**

### Move 2 — the walkthrough

#### Part A — the generic signature and the context contract

`AgentReplayShell<F, M extends string, R extends ReplayResultBase>` (`AgentReplayShell.tsx:48`). `R extends ReplayResultBase` is the key constraint: every agent result, whatever else it has, must carry `{ trace, evalOk, evalIssues, modelTurns, durationMs }` (`:15-22`). That shared base is what lets the shell compute `usage`, `costEstimate`, and the metrics bar generically without knowing whether the agent returned recommendations or a diagnosis.

What breaks without the base constraint: the shell couldn't read `result.trace` to derive `visibleTrace` — it'd have to push trace handling down into each workspace, duplicating it five times.

#### Part B — the four injected behaviors

Each workspace injects four things the shell can't know:

```
  injected per workspace (the slots)

  fixtures      F[]            which fixtures populate the <select>
  modes         {mode,label}[] which provider modes are available
  runFixture    (F)=>R         how to run locally (browser, deterministic)
  runServer     (F,mode,{onEvent})=>R   how to stream from the server (§01)
  metricItems   (ctx)=>JSX     the metrics bar contents
  renderPanels  (ctx)=>JSX     the three-column body
```

`runFixture` vs `runServer` is the fixture/provider split (`05-fixture-provider-mode-switch.md`): fixture mode runs the agent *in the browser* against recorded responses (`agent-runners.ts:11`), provider mode *streams from the server* (`api.ts:51`). The shell picks between them in `startReplay` based on `mode === 'fixture'` (`:117-119`) — that's the only place the two paths meet.

What breaks without injecting `runServer`: the shell would need to import every agent's API client and switch on capability id — coupling the generic shell to all five agents.

#### Part C — the mount-and-run effect

The shell runs the replay on mount and re-runs whenever `startReplay`'s identity changes:

```
  useEffect(() => { void startReplay(); }, [startReplay]);
```

Because `startReplay` is a `useCallback` over `[runFixture, runServer]`, it's stable across renders for a given workspace — so the effect fires once on mount, not on every keystroke. Selecting a fixture or mode doesn't re-trigger this effect; those handlers (`selectFixture`, `selectMode`, `:145-159`) clear state and the user re-runs via the Run button.

What breaks if `startReplay` weren't memoized: the effect's dependency would change every render, re-firing the replay in a loop.

#### Part D — derived context, computed every render

```
  derived in render body (AgentReplayShell.tsx:163-181)

  visibleTrace = replay?.trace ?? liveTrace      // final trace, or live one
  usage        = summarizeUsage(visibleTrace)    // pure fn of trace
  modelName    = usage.modelName || providerStatus[providerKey(mode)].model
  costEstimate = estimateCost(mode, usage, modelName)
  context      = { fixture, mode, replay, visibleTrace, usage,
                   costEstimate, running, error, setReplay, startReplay, … }
```

`visibleTrace = replay?.trace ?? liveTrace` is the small clever bit: while running, show the *live* accumulating trace (§01); once done, show the *authoritative* trace from the final result. One expression covers both phases.

What breaks if these were stored in state instead of derived: they'd drift from `visibleTrace` and you'd need an effect to keep them in sync — a classic redundant-state bug. Deriving each render keeps them honest.

### Move 3 — the principle

When N surfaces share a lifecycle but differ in their body, lift the lifecycle into a generic container and inject the body as typed render functions. The container owns state and effects; the surfaces become pure functions of a context object. The generic parameters (`<F, M, R>`) are what keep the injection type-safe instead of an `any`-typed escape hatch — they make the seam a real contract the compiler enforces.

## Primary diagram

```
  Shared replay shell — composition across 5 workspaces

  ┌─ WORKSPACE (config adapter, ~25 lines) ─────────────────────┐
  │ RecommendationWorkspace                                     │
  │   fixtures=…  modes=[fixture,anthropic,openai]              │
  │   runFixture=runFixtureReplay  runServer=runServerReplay    │
  │   metricItems=recommendationMetrics                         │
  │   renderPanels=RecommendationPanels                         │
  └───────────────────────────┬──────────────────────────────────┘
                              │ props
  ┌─ AgentReplayShell<F,M,R> (generic, agent-agnostic) ─────────┐
  │ state: selectedFixtureId, mode, providerStatus, replay,     │
  │        liveTrace, running, runId, error, runCounter(ref §02)│
  │ startReplay: mode==='fixture' ? runFixture : runServer(§01) │
  │ derive: visibleTrace, usage, costEstimate                   │
  │ build context ──────────────┐                               │
  │ <header> selectors + Run </header>                          │
  │ <metrics> metricItems(context) </metrics>     ← slot 1      │
  │ renderPanels(context)                         ← slot 2      │
  └───────────────────────────┬──────────────────────────────────┘
                              │ context: { fixture, replay, visibleTrace, … }
  ┌─ PANELS (presentational, agent-specific) ──────────────────┐
  │ RecommendationPanels: AgentStatusPanel, recommendations,   │
  │ ComparisonPanel, ReviewPanel, TracePanel, EvalPanel,       │
  │ useReplayArtifacts (§06)                                   │
  └────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

### Use cases

Five of the six agent workspaces are shell adapters. The clearest is `RecommendationWorkspace` (`RecommendationWorkspace.tsx:23-47`): pure configuration, no state of its own at the top level except a `resetToken` it bumps on fixture/mode change to reset child panels. `RubricImprovementWorkspace` is the leanest adapter (`RubricImprovementWorkspace.tsx:17-37`) — it doesn't even need a `resetToken` because it has no save/compare panels. Three pages deliberately do *not* use the shell: `CapabilitiesWorkspace` runs four utility previews in `Promise.all` rather than one agent replay (`CapabilitiesWorkspace.tsx:102-220`); `RagQueryWorkspace` runs a deterministic in-browser RAG pipeline with no provider-mode axis (`09-deterministic-in-browser-rag.md`); `DocPage` renders markdown with no agent at all (`08-build-time-markdown-docs.md`). The asymmetry is correct: a page earns the shell only if it replays one agent against a provider mode — otherwise forcing it into `<F, M, R>` would be abstraction theater. All three off-shell pages still reuse the shell's *leaf* components (`Panel`/`Metric`/`TracePanel`/`EvalPanel`), so the sharing happens at the right altitude.

### Code, line by line

```
  apps/studio/src/AgentReplayShell.tsx:48-83  — the generic signature

  export function AgentReplayShell<F, M extends string, R extends ReplayResultBase>({
    fixtures,          ← F[]: populate the fixture <select>
    getFixtureId,      ← (F)=>string: how to key/label a fixture
    initialMode,       ← M: the default mode (always 'fixture')
    metricItems,       ← (ctx)=>ReactNode: slot 1 (metrics bar)
    modes,             ← {mode,label,icon?}[]: which modes to offer
    renderPanels,      ← (ctx)=>ReactNode: slot 2 (the body)
    runFixture,        ← (F)=>Promise<R>: local deterministic run
    runServer,         ← (F,mode,{onEvent})=>Promise<R>: streamed run (§01)
    title, onHome, …
  }) {
       │
       └─ R extends ReplayResultBase is the load-bearing constraint:
          guarantees result.trace exists so the shell can derive
          usage/cost/visibleTrace generically (:15-22)
```

```
  apps/studio/src/AgentReplayShell.tsx:118-126  — the only place
  the fixture/server paths meet

  const result = modeToRun === 'fixture'
    ? await runFixture(fixtureToRun)                       ← browser, recorded
    : await runServer(fixtureToRun, modeToRun, { onEvent });  ← stream, live (§01)
  setLiveTrace(result.trace);                              ← settle to final trace
  setReplay({ ...result, runId: nextRunId, completedAt: new Date().toLocaleTimeString() });
       │
       └─ the shell knows nothing about recommendations vs anomalies;
          it only knows R has a .trace. Everything agent-specific is in
          the injected runFixture/runServer and renderPanels.
```

```
  apps/studio/src/AgentReplayShell.tsx:230-233  — the two slots rendered

  <section className="metrics" aria-label={`${title} summary`}>
    {metricItems(context)}            ← slot 1: workspace supplies metrics
  </section>
  {renderPanels(context)}             ← slot 2: workspace supplies the body
```

```
  apps/studio/src/RecommendationWorkspace.tsx:27-45  — a workspace as config

  <AgentReplayShell
    fixtures={fixtures}
    getFixtureId={(fixture) => fixture.id}
    initialMode="fixture"
    metricItems={recommendationMetrics}        ← (ctx)=>6 <Metric/>s
    modes={[{mode:'fixture',…},{mode:'anthropic',…},{mode:'openai',…}]}
    renderPanels={(context) => <RecommendationPanels context={context} resetToken={resetToken}/>}
    runFixture={runFixtureReplay}              ← agent-runners.ts
    runServer={runServerReplay}                ← api.ts (streams)
    title="Recommendation Agent Replay"
  />
       │
       └─ compare to MonitoringWorkspace.tsx:27-46 — same shape, modes drop
          'anthropic' (2-provider agent), modeClassName collapses the grid
```

The shared base type `ReplayResultBase` (`AgentReplayShell.tsx:16-23`) and the per-agent result types (`ReplayResult`, `MonitoringReplayResult`, etc. in `types.ts`) are the typed contract that makes `<F, M, R>` worth the generics. Module-depth analysis of this as a deep generic module belongs to `study-software-design`.

## Elaborate

Render props were React's pre-hooks answer to logic reuse, and they remain the right tool when the reused thing is *both stateful and renders chrome around injected content* — which a hook alone can't do (a hook gives you state but not a wrapping layout). The modern alternative would be a custom hook (`useReplayRun`) returning the context, with each workspace assembling its own chrome. AptKit's choice — shell-as-component with render-prop slots — is reasonable here because the chrome (topbar, mode switch, fixture select, metrics section) is *also* identical across workspaces, so putting it in the shell avoids repeating it five times. If only the *logic* were shared and the chrome differed, a hook would be cleaner. The `useReplayArtifacts` hook (`06-replay-artifact-hook.md`) is exactly that complementary choice for the save/promote logic, which has no shared chrome.

What to read next: `06-replay-artifact-hook.md` (the hook-shaped sibling of this pattern), `05-fixture-provider-mode-switch.md` (the `runFixture`/`runServer` split), then `study-software-design` for deep-module analysis.

## Interview defense

**Q: Five agents, five different outputs, one lifecycle. How do you avoid copy-pasting the run code?**
A generic shell component, `AgentReplayShell<F, M, R>`, owns the lifecycle — fixture/mode selection, the run, provider status, live trace — and exposes the body via two render-prop slots, `metricItems(ctx)` and `renderPanels(ctx)`. Each workspace is ~25 lines of config: its fixtures, its modes, its two runners, its two render functions. The constraint `R extends ReplayResultBase` guarantees a `.trace` so the shell derives usage and cost generically.

```
  shell owns lifecycle + chrome ──► renderPanels(context) ──► workspace owns body
```
Anchor: `AgentReplayShell.tsx:48,230-233`.

**Q: Why generics instead of `any` on the context?**
So `renderPanels` gets a fully typed `context.replay` — `Recommendation[]` in one workspace, a `Diagnosis` in another — checked at compile time. The generics turn the shell↔workspace seam into a real contract.

**Q: One workspace doesn't use the shell. Why is that not a smell?**
`CapabilitiesWorkspace` runs four parallel previews, not one agent-vs-fixture replay. It doesn't fit `<F, M, R>`, so forcing it in would be abstraction for its own sake. Knowing when *not* to reuse the abstraction is part of the design.

## Validate

1. **Reconstruct:** sketch the `AgentReplayShell` signature with its generics and the two render-prop slots. (`AgentReplayShell.tsx:48-83`)
2. **Explain:** what does `R extends ReplayResultBase` buy the shell? (Guaranteed `.trace` + eval fields, so usage/cost/metrics are computed once, generically — `:16-23,164-166`.)
3. **Apply:** add a sixth agent that returns a `Summary`. List what you'd write. (A result type extending `ReplayResultBase`, a `runFixture`/`runServer` pair, a `metricItems` and `renderPanels`, and a ~25-line workspace adapter — no shell change.)
4. **Defend:** why is `visibleTrace` derived (`replay?.trace ?? liveTrace`) rather than stored in state? (Storing it would let it drift from `liveTrace`/`replay`; deriving each render keeps it consistent across the running→done transition — `:163`.)

## See also

- `01-live-stream-consumption.md` — what `runServer` does.
- `02-stale-run-guard.md` — the `runCounter` ref inside the shell.
- `05-fixture-provider-mode-switch.md` — the `runFixture` vs `runServer` choice.
- `06-replay-artifact-hook.md` — the hook-shaped reuse the panels use.
- Cross-guide: `study-software-design` (deep generic module).
