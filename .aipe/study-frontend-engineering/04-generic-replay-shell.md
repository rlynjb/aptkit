# 04 — Generic replay shell

**Industry name(s):** headless / render-prop host component, generic over its
data shape. **Type:** Industry-standard (render props + TS generics) applied as
a project-specific agent-workspace chassis.

## Zoom out, then zoom in

Four of the analytics agents — recommendation, monitoring, diagnostic, query —
share one screen chassis: `AgentReplayShell`. It owns the header, fixture
picker, mode switch, run button, provider status, the async run loop, and the
stale-run guard. Each agent injects only its own metrics and panels. Here's
where it sits.

```
  Where the replay shell lives

  ┌─ UI layer (browser) ────────────────────────────────────────┐
  │  RecommendationWorkspace  MonitoringWorkspace  …  (config)   │
  │            │ pass metricItems + renderPanels + runFixture     │
  │            ▼                                                  │
  │  ★ AgentReplayShell<F, M, R> ★   ← here                       │
  │     header · mode switch · fixture select · run loop · trace │
  │            │ runFixture (local)  │ runServer (dev fetch)      │
  └────────────┼──────────────────────┼──────────────────────────┘
               ▼                       ▼
        agent-runners.ts        api.ts (NDJSON stream, dev only)
```

Zoom in: the question is *"how do five near-identical agent screens avoid being
five copies of the same 250-line component?"* The answer is a generic
render-prop host: one component holds all the behavior, the type parameters
`<Fixture, Mode, Result>` let each agent keep its own data shapes, and two
render-prop functions inject the per-agent UI.

## Structure pass

**Layers:** (1) the agent workspace (config + per-agent panels); (2) the shell
(shared state + behavior); (3) the runners (`runFixture` local,
`runServer` streaming).

**Axis — who owns each concern (control/ownership):** trace it across the seam.

```
  axis: who owns this concern?

  ┌ Workspace (per-agent) ┐   OWNS: which fixtures, which panels,
  │ RecommendationWorkspace│         which metrics, mode list
  └──────────┬─────────────┘
             │  injects via props (render-prop callbacks)
  ┌ Shell (shared) ────────┐   OWNS: selected fixture, mode, run loop,
  │ AgentReplayShell<F,M,R>│         provider status, stale-run guard,
  └──────────┬─────────────┘         error/running state, trace plumbing
             │  calls back
  ┌ Runners ──▼────────────┐   OWNS: actually executing the agent
  │ runFixture / runServer │
  └────────────────────────┘
```

**Seam:** the generic boundary `<F, M, R>` plus the two render-prop callbacks.
Control flips here: above it the agent declares *what*; below it the shell
decides *when and how*. The shell never names a concrete agent type — that's
what lets one component serve four.

## How it works

### Move 1 — the mental model

You know the headless-component idea: a component owns logic and hands rendering
to the caller via children-as-a-function or a render prop (think a `<Downshift>`
or a `useTable`-style hook). `AgentReplayShell` is that, with TS generics so the
injected render functions are *typed* to each agent's fixture and result shape.

```
  The kernel — host owns behavior, caller injects render

   <AgentReplayShell
      fixtures, getFixtureId, modes,        ← data the host drives
      runFixture, runServer,                ← how to execute
      metricItems={(ctx) => …},             ← render prop: metrics
      renderPanels={(ctx) => …} />          ← render prop: panels
            │
            ▼  host builds `context` (typed), calls both render props
        header + mode switch + run loop  +  caller's metrics/panels
```

The kernel is: **generic params (`F,M,R`) + a typed `context` object + two
render-prop callbacks**. Strip the generics and you lose type-safety across
agents; strip the render props and the host can't be reused.

### Move 2 — the walkthrough

**The generic signature — three type parameters.**
The shell is generic over fixture `F`, mode-string `M`, and result `R` (which
must extend a common `ReplayResultBase` so the shell can read `trace`,
`evalOk`, `durationMs` generically).

```ts
// apps/studio/src/AgentReplayShell.tsx:48-83 (signature, trimmed)
export function AgentReplayShell<F, M extends string, R extends ReplayResultBase>({
  fixtures, getFixtureId,            // F[] + how to id one
  modes, initialMode,               // M[] + start mode
  metricItems, renderPanels,        // render props receiving typed context
  runFixture,                       // (F) => Promise<R>          — local replay
  runServer,                        // (F, mode, {onEvent}) => Promise<R> — dev stream
  onHome, title, ariaLabel,
}: { /* … */ }) {
```

`R extends ReplayResultBase` (`AgentReplayShell.tsx:16-23`) is the contract that
makes the trace/eval/metrics machinery work for *any* agent without the shell
knowing the agent's specific output.

**The shared state — owned once, for all four agents.**
Everything that's identical across agents lives here as `useState`: selected
fixture, mode, provider status, the current replay, the live streaming trace,
running/error/runId.

```ts
// apps/studio/src/AgentReplayShell.tsx:85-96
const [selectedFixtureId, setSelectedFixtureId] = React.useState(getFixtureId(fixtures[0]));
const [mode, setMode] = React.useState<M>(initialMode);
const [providerStatus, setProviderStatus] = React.useState<ProviderStatus>({ … });
const [replay, setReplay] = React.useState<ReplayStateFor<R> | null>(null);
const [liveTrace, setLiveTrace] = React.useState<CapabilityEvent[]>([]);
const [running, setRunning] = React.useState(false);
const [runId, setRunId] = React.useState(0);
const [error, setError] = React.useState<string | null>(null);
const runCounter = React.useRef(0);    // monotonic — guards stale async writes
```

**The run loop — and the stale-run guard (the subtle bit).**
`startReplay` is the load-bearing function. It bumps a ref counter, then either
runs the fixture locally or streams from the dev server — and it drops any
streamed event whose run is no longer current.

```ts
// apps/studio/src/AgentReplayShell.tsx:104-132 (core)
const startReplay = React.useCallback(async () => {
  const nextRunId = runCounter.current + 1;
  runCounter.current = nextRunId;                      // claim this run
  setRunId(nextRunId); setRunning(true); setError(null);
  setReplay(null); setLiveTrace([]);
  try {
    const onEvent = (event: CapabilityEvent) => {
      setLiveTrace((current) =>
        runCounter.current === nextRunId ? [...current, event] : current);  // ← stale guard
    };
    const result = modeToRun === 'fixture'
      ? await runFixture(fixtureToRun)                 // local, in-browser
      : await runServer(fixtureToRun, modeToRun, { onEvent });  // dev NDJSON stream
    setLiveTrace(result.trace);
    setReplay({ ...result, runId: nextRunId, completedAt: new Date().toLocaleTimeString() });
  } catch (caught) {
    setError(caught instanceof Error ? caught.message : String(caught));
  } finally { setRunning(false); }
}, [runFixture, runServer]);
```

The `runCounter.current === nextRunId` check is the part people forget: without
it, a user who switches fixtures mid-stream would see events from the *abandoned*
run interleave with the new one. The ref (not state) is deliberate — it must be
read at its current value inside the async callback, which a state snapshot
captured in the closure wouldn't give you. This guard is the correctness story
of the shell; note the bespoke `RagQueryWorkspace` (file 03) *lacks* it
(`audit.md` #1).

**Provider status — gated for the static build.**
The shell fetches which providers are live, but only in dev — `STATIC_DEMO`
short-circuits it so the Pages build never calls `/api/model-status`.

```ts
// apps/studio/src/AgentReplayShell.tsx:138-145
React.useEffect(() => {
  if (STATIC_DEMO) return;                      // static build: skip the fetch
  loadProviderStatus().then(setProviderStatus).catch(() => { /* keep defaults */ });
}, []);
```

**The context object — typed, handed to both render props.**
The shell assembles everything the caller needs into one typed `context`
(`AgentReplayShellContext<F, M, R>`) and calls `metricItems(context)` and
`renderPanels(context)`.

```ts
// apps/studio/src/AgentReplayShell.tsx:163-183, 229-233 (assembly + use)
const visibleTrace = replay?.trace ?? liveTrace;
const usage = summarizeUsage(visibleTrace);
const costEstimate = estimateCost(mode, usage, modelName);
const context: AgentReplayShellContext<F, M, R> = { fixture, mode, replay,
  visibleTrace, usage, costEstimate, running, error, startReplay, /* … */ };
// …in JSX:
<section className="metrics">{metricItems(context)}</section>
{renderPanels(context)}
```

**How an agent uses it — ~40 lines of config (layers-and-hops).**
The whole `RecommendationWorkspace` is mostly declaration: hand the shell its
fixtures, modes, runners, and two render functions.

```
  agent → shell, the injection seam

  ┌ RecommendationWorkspace ──────────────────────────────────────┐
  │ <AgentReplayShell                                              │
  │    fixtures={recommendationFixtures}                           │
  │    modes={[fixture, openai]}            (RecommendationWorkspace│
  │    runFixture={runFixtureReplay}         .tsx:28-44)           │
  │    runServer={runServerReplay}                                 │
  │    metricItems={recommendationMetrics}   ← render prop          │
  │    renderPanels={(ctx)=> <RecommendationPanels …/>} /> ← render prop
  └───────────────────────────┬────────────────────────────────────┘
                              ▼ shell drives state, calls back into the props
  ┌ AgentReplayShell ─────────────────────────────────────────────┐
  │  builds context → metricItems(context) + renderPanels(context) │
  └────────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

When N screens share behavior but differ in data shape, push the behavior into
one host and parameterize it — render props for the *what to draw*, generics for
the *type of data drawn*. The payoff is a single place to fix the hard parts
(the stale-run guard, the static-build gate) instead of N copies that drift. The
cost is an abstraction the reader must learn once; it earns that cost at four
consumers and a non-trivial async invariant. (The deep-module argument — does it
hide enough to justify itself — is `study-software-design`'s lens.)

## Primary diagram

```
  Generic replay shell — the complete picture

  ┌─ Workspace (per-agent config) ──────────────────────────────┐
  │  fixtures · modes · runFixture · runServer                   │
  │  metricItems(ctx) · renderPanels(ctx)   ← injected render    │
  └───────────────────────────┬─────────────────────────────────┘
                              ▼  props
  ┌─ AgentReplayShell<F, M extends string, R extends Base> ──────┐
  │  state: fixture · mode · providerStatus · replay · liveTrace │
  │  ref:   runCounter (stale-run guard)                         │
  │  startReplay():                                              │
  │     mode==='fixture' ? runFixture(F)  : runServer(F,mode,…)  │
  │     onEvent drops events where runCounter ≠ thisRun          │
  │  STATIC_DEMO ? skip provider fetch                           │
  │  context = {fixture, replay, visibleTrace, usage, cost, …}   │
  │  render: header · ReplayModeSwitch · fixture <select> · Run  │
  │          metricItems(context)                                │
  │          renderPanels(context)                               │
  └───────────────────────────┬─────────────────────────────────┘
              ▼ fixture (local)        ▼ server (dev NDJSON)
        agent-runners.ts          api.ts runReplayStream
```

## Elaborate

This is the headless-component pattern — own logic, delegate rendering — that
shows up as `useTable`/`useCombobox` hooks and `<Downshift>`-style components in
the React ecosystem. The generic parameters are what make it more than a copy:
each agent's `Fixture` and `Result` types flow through untouched, so the
recommendation panels get a `RecommendationReplayResult` and the query panels a
`QueryReplayResult`, both type-checked, from the same shell. The one agent that
*doesn't* fit — RAG query (file 03) — is the useful counterexample: its run
shape (index a corpus, recover chunks from the trace, dual scoring) doesn't
match the shell's fixture/server-mode contract, so it's a bespoke screen. Knowing
when an abstraction *doesn't* apply is the same skill as building it.

## Interview defense

**Q: Why a render-prop host instead of a base class or copy-paste?**
Four agent screens share ~90% behavior (run loop, mode switch, fixture select,
trace, provider status) but differ in fixture and result shape. A render-prop
host lets the shell own all the behavior once while each agent injects only its
metrics and panels via callbacks, and TS generics `<F, M, R>` keep each agent's
data types intact through the shell. Copy-paste would mean fixing the
stale-run guard in four places.

**Q: What's the trickiest correctness bug the shell handles?**
Out-of-order async runs. If you start a replay, then switch fixtures and start
another before the first finishes, the first run's streamed events could land in
the new run's trace. The shell claims each run with a monotonic `runCounter`
ref and drops any `onEvent` whose `runCounter.current` no longer matches
(`AgentReplayShell.tsx:116`). It's a ref, not state, because the async callback
must read the *current* run id, not the one captured in its closure.

```
  stale-run guard

  run #1 starts (runCounter=1) ─── streaming … ───┐
  user switches fixture → run #2 (runCounter=2)    │ late event from #1
                                                   ▼
  onEvent: runCounter.current(2) === 1 ? no → DROP the stale event
```

**Q: When would you NOT use this shell?**
When the run shape doesn't fit its fixture/server-mode contract — which is
exactly why the RAG Query screen is bespoke. It indexes a corpus, recovers
retrieved chunks from the trace, and runs dual retrieval scoring; forcing that
through the shell's two-mode replay API would bend the abstraction past its
purpose. The shell is for "replay a fixture, optionally against a live provider,
show trace + eval"; RAG query is a different verb.

**Anchor:** *"One generic render-prop host owns the behavior — including the
monotonic-runId stale-run guard — and each agent injects only its panels."*

## See also

- `03-deterministic-in-browser-rag.md` — the agent that deliberately doesn't
  use this shell, and why.
- `05-fixture-as-build-input.md` — where the `fixtures` prop comes from.
- `audit.md` → lens 3 (component architecture), lens 2 (state), #1 (the abort
  gap on the non-shell screen).
- `study-software-design` — the deep-module / information-hiding lens on this
  abstraction. `study-networking` — the NDJSON stream `runServer` consumes.
