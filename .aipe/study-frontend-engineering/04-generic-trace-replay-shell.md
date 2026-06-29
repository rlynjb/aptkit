# Generic trace-replay shell

**Industry name(s):** render-prop / generic container component; stale-response guard via a
monotonic request counter (the "ignore stale results" / latest-request-wins pattern).
**Type:** Industry standard (render props, request-versioning), project-specific in the
`<F, M, R>` shape it carries.

## Zoom out, then zoom in

Five of Studio's six agent pages — recommendation, monitoring, diagnostic, query, rubric —
do the same thing: pick a fixture, pick a provider mode, run a replay, watch a trace stream
in, show metrics + panels + an eval verdict. Rather than five copies of that lifecycle, there
is one generic component they all configure. Here's where the shell (`AgentReplayShell`) sits.

```
  Zoom out — where the replay shell lives

  ┌─ View layer ─────────────────────────────────────────────┐
  │  RecommendationWorkspace  MonitoringWorkspace  Diagnostic… │  ← thin containers
  └───────────────────────────────┬──────────────────────────┘
                                  │ configure via props + render-props
  ┌─ Shell layer (AgentReplayShell.tsx) ─▼───────────────────┐
  │  ★ owns replay lifecycle: mode, run, stream, stale-guard ★│ ← we're here
  └───────────────────────────────┬──────────────────────────┘
                                  │ runFixture / runServer callbacks
  ┌─ Runner + API layer ──────────▼──────────────────────────┐
  │  agent-runners.ts (in-browser)  ·  api.ts (NDJSON stream) │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"how do five pages share one replay lifecycle while each renders
its own agent-specific output and metrics?"* The answer: a generic component
`AgentReplayShell<F, M, R>` owns all the state and the run logic, and calls back into each
page through render props for the parts that differ.

## Structure pass

**Layers:** the container (configures + renders agent-specific UI) → the shell (state +
lifecycle) → the run callbacks (`runFixture` pure/in-browser, `runServer` streamed).

**One axis — *who owns the replay lifecycle state?*** Trace it:

```
  Axis: "who owns replay state — the container or the shell?"

  ┌─ container (e.g. RecommendationWorkspace) ─┐  → owns NOTHING of the lifecycle;
  │                                            │    supplies config + render fns
  └──────────────────┬──────────────────────────┘
                    │ props
  ┌─ shell (AgentReplayShell) ─────────────────┐  → OWNS replay, liveTrace, mode,
  │                                            │    running, runId, runCounter ref
  └──────────────────┬──────────────────────────┘
                    │ context object
  ┌─ render props (metricItems/renderPanels) ──┐  → READ the state, render it;
  │                                            │    can't mutate the lifecycle
  └─────────────────────────────────────────────┘
```

**The seam that matters:** the render-prop boundary — `metricItems(context)` and
`renderPanels(context)` (`AgentReplayShell.tsx:69-76`). Control of *what to render* flips
there: above it the shell decides *when* (lifecycle), below it the container decides *what*
(agent-specific output). The second load-bearing seam is internal: the `runCounter` ref
(`:97`), the boundary that decides which streamed events are still valid.

## How it works

### Move 1 — the mental model

Two patterns you already use, composed. First, render props: the shell is like a `<DataGrid>`
that owns sorting/paging state and lets you pass a `renderRow` — except here the "state" is a
whole replay lifecycle and the render fns get a typed `context`. Second, the stale-guard: it's
the same fix as ignoring a slow `fetch` that resolves *after* a newer one — tag each run with
an incrementing id and ignore any event whose id isn't the latest.

```
  The pattern — shell owns state, container renders it

  container ──config──►  ┌─ AgentReplayShell ─┐
   runFixture/runServer  │ state: replay,     │ ──context──► metricItems(ctx)
   metricItems(ctx) ─────│ liveTrace, mode,   │ ──context──► renderPanels(ctx)
   renderPanels(ctx) ────│ running, runCounter│
                         └────────────────────┘

  stale-guard:  nextRunId = ++runCounter.current
                onEvent: append ONLY if runCounter.current === nextRunId
```

### Move 2 — the step-by-step walkthrough

**The generic signature.** Three type params: `F` the fixture, `M` the mode union (e.g.
`'fixture' | 'openai'`), `R` the result (constrained to carry a trace + eval). The container
binds them concretely; the shell stays agnostic.

```ts
// AgentReplayShell.tsx:48-83 (signature, condensed)
export function AgentReplayShell<F, M extends string, R extends ReplayResultBase>({
  fixtures, getFixtureId, initialMode, modes,
  metricItems,      // (context) => ReactNode   ← render prop: agent-specific metric tiles
  renderPanels,     // (context) => ReactNode   ← render prop: agent-specific panels
  runFixture,       // (fixture) => Promise<R>             ← in-browser deterministic replay
  runServer,        // (fixture, mode, {onEvent}) => Promise<R>  ← streamed live replay
  onHome, title, ariaLabel, …
}) { … }
```

`ReplayResultBase` (`:16-23`) is the contract every agent's result must satisfy — `trace`,
`evalOk`, `evalIssues`, `modelTurns`, `durationMs`. That's what lets the shell render metrics
and the eval verdict without knowing the agent.

**The shell's state.** All lifecycle state lives here, once: `replay`, `liveTrace`, `mode`,
`running`, `runId`, `error`, plus refs for `runCounter`, the selected fixture, and the mode
(`AgentReplayShell.tsx:85-99`). The refs hold the *current* values for use inside async
callbacks without making `startReplay` depend on them.

**The run lifecycle with the stale-guard.** This is the load-bearing mechanism. Each run
claims the next id; the streamed `onEvent` only appends if its id is still the latest.

```ts
// AgentReplayShell.tsx:104-132 (condensed)
const startReplay = React.useCallback(async () => {
  const fixtureToRun = selectedFixtureRef.current;
  const modeToRun = modeRef.current;
  const nextRunId = runCounter.current + 1;
  runCounter.current = nextRunId;          // claim this run's id
  setRunId(nextRunId); setRunning(true); setError(null);
  setReplay(null); setLiveTrace([]);
  try {
    const onEvent = (event: CapabilityEvent) => {
      // append ONLY if this run is still the latest; a newer run bumped runCounter
      setLiveTrace((current) => runCounter.current === nextRunId ? [...current, event] : current);
    };
    const result = modeToRun === 'fixture'
      ? await runFixture(fixtureToRun)
      : await runServer(fixtureToRun, modeToRun as Exclude<M, 'fixture'>, { onEvent });
    setLiveTrace(result.trace);
    setReplay({ ...result, runId: nextRunId, completedAt: new Date().toLocaleTimeString() });
  } catch (caught) {
    setError(caught instanceof Error ? caught.message : String(caught));
  } finally { setRunning(false); }
}, [runFixture, runServer]);
```

The boundary condition this fixes: hit Run twice fast (or switch fixtures mid-stream). The
first run's NDJSON events keep arriving over the network *after* the second run started.
Without the guard, the first run's events would interleave into the second run's trace and
the panel would show a garbled mix. The `runCounter.current === nextRunId` check drops every
late event from a superseded run. That's the line people forget — name it in an interview.

```
  Execution trace — two fast runs, stale events dropped

  step                          runCounter.current   action
  ──────────────────────────────────────────────────────────────────
  Run A starts (nextRunId=1)           1             liveTrace = []
  A event e1 arrives                   1             1===1 → append e1
  Run B starts (nextRunId=2)           2             liveTrace = []  (reset)
  A event e2 arrives (LATE)            2             2≠1   → DROP e2  ✓
  B event e1' arrives                  2             2===2 → append e1'
  B resolves → setReplay(B)            2             shows B's trace only
```

**Why a ref, not state, for the counter.** `runCounter` is a `useRef` (`:97`) because the
`onEvent` closure captures it by reference and must read the *latest* value at event time —
a `useState` would close over a stale snapshot. This is the canonical "read current value
inside an async callback" use of a ref.

**The render-prop handoff.** The shell builds a typed `context` (`:167-183`) — fixture, mode,
the visible trace, computed `usage`/`modelName`/`costEstimate`, running flag, the setters —
and passes it to the container's `metricItems` and `renderPanels`. The container renders
agent-specific tiles and panels from it.

```
  Layers-and-hops — a streamed run, container renders the result

  ┌─ container ─────────┐ hop1: <AgentReplayShell runServer={runServerQueryReplay}
  │ QueryWorkspace      │        metricItems={…} renderPanels={…} />
  └─────────────────────┘ ─────────────────────────────────────────┐
  ┌─ shell ─────────────┐ hop2: startReplay → runServer(…, {onEvent})│
  │ AgentReplayShell    │ ◄──── onEvent(event) per NDJSON line ──────┤ (stale-guarded)
  └─────────────────────┘ hop3: build context, call render props     ▼
  ┌─ render props ──────┐ hop4: metricItems(ctx) → <Metric>; renderPanels(ctx) → <TracePanel>
  │ (container's fns)   │   agent-specific UI, shell-owned state
  └─────────────────────┘
```

### Move 2 variant — the load-bearing skeleton

The kernel is: **one generic state owner + a render-prop seam + a monotonic stale-guard.**

1. **The generic `<F, M, R>` shell owning lifecycle state** — drop the generic and you get
   five copies of the same `useState` block; a bug fix touches five files.
2. **The render-prop seam** (`metricItems`/`renderPanels`) — drop it and the shell would have
   to know every agent's output shape; the abstraction collapses.
3. **The `runCounter` monotonic guard** — drop it and concurrent/superseded runs interleave
   their streamed traces. This is the one part that's about *correctness under async*, not
   reuse.
4. **`ReplayResultBase` as the result contract** — drop it and the shell can't render metrics
   or the eval verdict generically.

The provider-status fetch (`:138-145`), the mode switch, and the `STATIC_DEMO` gate are
hardening on top.

### Move 3 — the principle

When N pages share a lifecycle but differ in their leaves, push the lifecycle into one generic
owner and expose the leaves as render props — the shell decides *when*, the container decides
*what*. And any time a component fires async work that can be superseded (a re-run, a
search-as-you-type, a tab switch), version each request and ignore results that aren't the
latest. The monotonic counter is the smallest correct fix; a ref is how you read it inside the
async closure.

## Primary diagram

```
  Generic trace-replay shell — full picture

  ┌─ Container (one of 5 workspaces) ─────────────────────────────────────┐
  │  <AgentReplayShell<F,M,R>                                              │
  │     fixtures getFixtureId initialMode modes                           │
  │     runFixture   ← agent-runners.ts (in-browser, deterministic)       │
  │     runServer    ← api.ts runReplayStream (NDJSON, dev only)          │
  │     metricItems(ctx)  renderPanels(ctx)  />                           │
  └───────────────────────────────────┬───────────────────────────────────┘
  ┌─ Shell (AgentReplayShell.tsx) ─────▼──────────────────────────────────┐
  │  state: replay · liveTrace · mode · running · runId · error           │
  │  refs:  runCounter · selectedFixture · mode                           │
  │  startReplay: ++runCounter → run → onEvent appends IFF id is latest    │
  │  derived (per render): usage, modelName, costEstimate from visibleTrace│
  │  context = { fixture, mode, visibleTrace, usage, …, setReplay } ──┐    │
  └────────────────────────────────────────────────────────────────────┼──┘
                                                                        │
  ┌─ Render props (container's fns) ◄────────────────────────────────────┘ │
  │  metricItems(ctx) → <Metric …>   renderPanels(ctx) → <Panel>/<TracePanel>│
  └───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The render-prop shell is the deepest module in the frontend — a lot of behavior (mode
switching, provider status, streamed vs in-browser runs, stale-guarding, usage/cost
derivation) behind a small configuration surface. That's a `study-software-design` finding;
this file owns the frontend mechanics. The stale-guard is the same idea as react-query's
query-cancellation or an `AbortController` on a superseded `fetch` — Studio does it by hand
with a counter because it has no query library (`not yet exercised`, audit lens 4). The
`runFixture` vs `runServer` split is the seam between this pattern and the two it composes
with: `runFixture` routes into `03-deterministic-in-browser-rag.md`'s sibling runners,
`runServer` into the NDJSON client in `api.ts` (wire semantics → `study-networking`). The
two off-shell pages (`RagQueryWorkspace`, `DocPage`) deliberately don't use the shell because
their lifecycles differ — a sign the abstraction earned its boundary rather than being forced.

## Interview defense

**Q: How do five pages share a replay lifecycle without duplication?**
A generic `AgentReplayShell<F, M, R>` owns all the lifecycle state and run logic; each page
configures it with props and supplies two render props — `metricItems` and `renderPanels` —
for the agent-specific output. The shell decides when things happen; the container decides
what gets drawn. Result type is constrained to `ReplayResultBase` so the shell can render
metrics and the eval verdict generically.

Anchor: *"shell owns the lifecycle, render props own the leaves."*

**Q: What breaks if a user hits Run twice quickly with a streamed replay?**
Without a guard, the first run's NDJSON events keep arriving after the second run starts and
interleave into its trace. The shell versions each run with a monotonic `runCounter` ref;
`onEvent` only appends if its run id is still the latest (`AgentReplayShell.tsx:107-116`).
Late events from a superseded run are dropped. It's a ref, not state, because the async
closure must read the current value, not a snapshot.

```
  Run A (id 1) ──e1──► append
  Run B (id 2) starts, counter=2
  Run A's e2 (late)  → 2≠1 → dropped ✓
  Run B's e1 (id 2)  → 2=2 → append
```

Anchor: *"version the run, drop events that aren't the latest — and use a ref so the closure
reads the live value."*

## See also

- `03-deterministic-in-browser-rag.md` — the `runFixture` sibling; trace as data
- `05-fixture-as-build-input.md` — where `fixtures`/`getFixtureId` get their data
- `audit.md` — lens 3 (components), red flag #2 (unmemoized derived state in this shell)
- `study-software-design` — is the shell a deep module?
- `study-networking` — the NDJSON stream `runServer` consumes
