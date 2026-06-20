# 02 — Stale-run guard

**Industry names:** stale-closure / out-of-order response guard · request-sequence token · "last write wins by run id." **Type:** Industry standard (the React `useRef`-counter idiom for discarding superseded async work), project-specific application to a trace stream.

---

## Zoom out — where this lives

This is a tiny piece of code — one ref, one comparison — sitting directly on top of the live stream consumer. It exists for exactly one reason: a stream takes time, and the user can start a *new* run before the old one finishes.

```
  Where the guard sits

  ┌─ UI layer (browser) ─────────────────────────────────────┐
  │  AgentReplayShell                                         │
  │    runCounter (useRef)        ◄── ★ THIS CONCEPT ★        │ ← we are here
  │    startReplay() bumps it; onEvent reads it               │
  │       │                                                   │
  │       ▼ guards every setLiveTrace from a streamed event   │
  │  api.ts runReplayStream → onEvent(event)  (§01)           │
  └────────────────────────────────────────────────────────────┘
```

The question: **when run #2 starts while run #1's stream is still arriving, how do you stop run #1's late events from appending into run #2's trace?** You've hit this exact bug with debounced search-as-you-type — a slow earlier request resolves *after* a faster later one and clobbers the fresh results. Same shape, different transport.

## Structure pass

One axis — **"which run does this event belong to?"** — and one seam where it flips.

```
  axis: "which run owns this streamed event?"

  ┌─ without the guard ───────────────────────┐
  │  every onEvent appends, no questions asked │  → events from ANY run
  └───────────────────────┬─────────────────────┘
                          │  the guard inserts a seam here
  ┌─ with the guard ──────▼─────────────────────┐
  │  append ONLY if event.run === current run    │  → events from THIS run
  └───────────────────────────────────────────────┘
```

- **Layers:** user click → `startReplay` (assigns a run id) → async stream → `onEvent` (must prove it's still the current run) → `setState`.
- **The seam** is the `onEvent` closure. It closes over a run id captured *at start time*; by the time it fires, the "current" run id may have moved on. The guard compares the two.
- **Why a ref, not state:** the comparison must read the *latest* current run id synchronously inside an old closure. `useState` would freeze the value in the closure (stale closure); `useRef.current` always reads the live value. That choice is the whole pattern.

## How it works

### Move 1 — the mental model

Picture two stopwatches. When a run starts, you stamp it with the next integer and remember that integer as "the current one." Every event that arrives carries (implicitly, via closure) the integer of the run that produced it. Before you let an event mutate state, you check: *is my stamp still the current stamp?* If a newer run started, the current stamp moved past yours, and you drop the event on the floor.

```
  The pattern: a monotonic run id + a "still current?" check

   click ──► nextRunId = ++runCounter.current     // stamp this run
             (runCounter.current is now nextRunId)
                       │
       ┌───────────────┼─────────── stream events arrive over time
       ▼               ▼                ▼
    onEvent         onEvent          onEvent
      │ guard:        │ guard:          │ guard:
      │ counter===id? │ counter===id?   │ counter===id?
      ▼ yes → append  ▼ yes → append    ▼ NO (run 2 started) → drop
```

The kernel in one line: **a run is "current" iff `runCounter.current === nextRunId`; only current runs may write state.**

### Move 2 — the load-bearing skeleton

The kernel is three parts. Name each by what breaks when it's gone.

#### Part 1 — the monotonic counter (a ref, not state)

`runCounter = useRef(0)`. On each `startReplay`, `nextRunId = runCounter.current + 1; runCounter.current = nextRunId`.

What breaks without "monotonic": if you reused or reset ids, an old event could match a new run's id by accident and slip through. Strictly increasing guarantees each run's id is unique for the session.

What breaks if it's `useState` instead of `useRef`: the `onEvent` closure captures `nextRunId` at start; if "current" lived in state, the closure would read the *render-time* value, which is stale — the guard would compare against the wrong "current" and either always pass or always fail. **A ref is mandatory here** because you need an old closure to read a value that's mutated after the closure was created. This is the single most important detail in the file.

#### Part 2 — the captured local `nextRunId`

`startReplay` computes `nextRunId` once and the `onEvent` closure closes over *that local*, not over `runCounter.current`.

```
  capture (pseudocode)

  function startReplay():
     nextRunId = runCounter.current + 1     // local, frozen for this run
     runCounter.current = nextRunId          // ref advances to "current"
     onEvent = (event) =>
        setLiveTrace(c => runCounter.current === nextRunId  // live vs frozen
                            ? [...c, event]
                            : c)
```

What breaks without the capture: if `onEvent` read `runCounter.current === runCounter.current`, the comparison is trivially always true — no guard at all. The guard *only works* because one side is frozen (the run's own id) and the other is live (the global current). The contrast between frozen and live is the mechanism.

#### Part 3 — the equality check inside the updater

The comparison lives *inside* the `setLiveTrace` functional updater, not before it. Returning `current` unchanged when the run is stale is a no-op write — React bails out, no spurious render from a dropped event.

What breaks if the check were outside (`if (runCounter.current === nextRunId) setLiveTrace(...)`): functionally similar, but you'd read the ref at callback-fire time rather than at flush time — a narrower race window but the same intent. The in-updater form is the cleaner expression.

#### Skeleton vs hardening

Skeleton: counter (ref) + frozen capture + equality check. That's it. There's no hardening layered on — no `AbortController` to actually *cancel* the in-flight fetch. Worth naming honestly: **the guard discards stale events, it does not abort the stale request.** The old stream keeps draining in the background (wasting a little work) but can no longer touch the UI. For a local dev tool that tradeoff is fine; for a metered API you'd add an `AbortController` to also stop the network work. (`AbortSignal` support already exists in the decoder — `ndjson-stream.ts:112,123` — it's just not wired from Studio.)

### Move 2.5 — current vs future state

```
  current (shipped)              vs   future (if it ever matters)
  ────────────────────                ────────────────────────────
  guard drops stale EVENTS            guard drops events
  in-flight stream keeps              + AbortController.abort()
  draining (wasted work, no           actually cancels the fetch
  UI effect)                          → no wasted provider tokens
```

What doesn't have to change: the guard itself. Adding cancellation is purely additive — pass `controller.signal` to `fetch` and `abort()` at the top of `startReplay`; the run-id check stays as the belt to cancellation's suspenders.

### Move 3 — the principle

Any UI that kicks off async work the user can re-trigger needs a way to answer "is this result still wanted?" The cheapest correct answer is a monotonically increasing token captured per launch and checked at write time, with the *current* token in a ref so old closures read the live value. Cancellation (AbortController) stops the *work*; the run-id guard stops the *write*. You often want both, but the write-guard alone is enough to keep the UI correct.

## Primary diagram

```
  Stale-run guard — two runs racing

  t0  user clicks Run     runCounter: 0→1   nextRunId(A)=1
        run A stream opens
  t1  A: event ──► onEvent: counter(1)===id(1)? yes ► append to liveTrace
  t2  user clicks Run AGAIN  runCounter: 1→2   nextRunId(B)=2
        setReplay(null); setLiveTrace([])   ← B clears the slate
        run B stream opens
  t3  A: event (late!) ──► onEvent: counter(2)===id(1)? NO ► DROP
  t4  B: event ──► onEvent: counter(2)===id(2)? yes ► append
  t5  A: finishes ──► its setReplay also gated by run identity downstream
  t6  B: result ──► setReplay({...B, runId:2})   ← only B paints the result

  invariant held: liveTrace and replay only ever reflect run B
```

## Implementation in codebase

### Use cases

Fires whenever a user re-runs before a stream completes — most realistically when they click "Run OpenAI," see it's slow, switch the fixture (`selectFixture` clears trace and would re-run) or hit Run again. Also implicitly on mount: `startReplay` runs in a `useEffect` (`AgentReplayShell.tsx:134-136`), and the `selectFixture`/`selectMode` handlers reset trace and the user often re-runs immediately. The comparison flow in `RecommendationWorkspace` runs *three* sequential replays (fixture, then openai) and uses its own separate `comparisonRunCounter` ref for the same reason (`RecommendationWorkspace.tsx:67,112-122`).

### Code, line by line

```
  apps/studio/src/AgentReplayShell.tsx:97, 104-132

  const runCounter = React.useRef(0);              ← the monotonic token (REF)

  const startReplay = React.useCallback(async () => {
    const fixtureToRun = selectedFixtureRef.current;
    const modeToRun = modeRef.current;
    const nextRunId = runCounter.current + 1;      ← compute this run's id
    runCounter.current = nextRunId;                ← advance "current" to it
    setRunId(nextRunId);                           ← (state copy, for display only)
    setRunning(true);
    setError(null);
    setReplay(null);                               ← clear prior run's result
    setLiveTrace([]);                              ← clear prior run's trace
    try {
      const onEvent = (event: CapabilityEvent) => {
        setLiveTrace((current) =>
          runCounter.current === nextRunId          ← live ref  ===  frozen local
            ? [...current, event]                   ← current run → append
            : current);                             ← superseded → DROP (no-op)
      };
      const result = modeToRun === 'fixture'
        ? await runFixture(fixtureToRun)            ← local, no stream
        : await runServer(fixtureToRun, modeToRun, { onEvent });  ← streamed (§01)
      setLiveTrace(result.trace);                   ← final authoritative trace
      setReplay({ ...result, runId: nextRunId, completedAt: … });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  }, [runFixture, runServer]);
       │
       └─ the guard is the single line `runCounter.current === nextRunId`.
          Remove it and run A's late events append into run B's trace.
          runCounter MUST be a ref: onEvent closes over nextRunId (frozen)
          but must read the LATEST current id (live) — useState would freeze
          both and the guard would be meaningless.
```

Note also `setRunId(nextRunId)` at `:108` — that's a *state* copy of the id, used purely for the "Run #N" badge in the metrics (`RecommendationWorkspace.tsx:57`). The *authority* for the guard is the ref; the state is cosmetic. Naming which copy is load-bearing (ref) and which is display-only (state) is the lesson.

## Elaborate

This is the React-hooks form of a request-sequence number, the same idea used in network protocols (TCP sequence numbers, idempotency keys) to reject out-of-order or duplicate messages. In the React world it shows up most often as the "ignore stale fetch" cleanup in `useEffect` (the `let cancelled = false; return () => { cancelled = true }` idiom). Studio's version is the imperative-callback cousin: instead of a per-effect boolean, a session-global counter, because the async work is launched by an event handler (`startReplay`), not by an effect dependency change. The deeper reason it must be a ref and not state is the **stale closure** problem — the canonical hooks footgun. `onEvent` is created once per `startReplay` call and captures everything in scope at that moment; only a ref escapes that capture and reads present-time.

What to read next: `01-live-stream-consumption.md` (the stream this guards), then `study-runtime-systems` for why async callbacks fire after the launching frame has long returned.

## Interview defense

**Q: User clicks Run twice quickly. What stops the two streams' events from interleaving?**
A monotonic run id. `startReplay` bumps a `useRef` counter and captures the new id in a local. Every streamed event's `onEvent` checks `runCounter.current === capturedId` inside the `setState` updater; if a newer run advanced the counter, the stale event's write is a no-op. So `liveTrace` only ever holds the current run's events.

```
  runCounter(ref) bumps per run → onEvent appends only if ref === its frozen id
```
Anchor: `AgentReplayShell.tsx:97,107-116`.

**Q: Why a ref instead of state for the counter?**
Because `onEvent` is a closure created at run-start; it freezes whatever it captures. I need it to compare its own frozen id against the *latest* current id. A ref's `.current` reads present-time even from an old closure; `useState` would hand the closure a stale snapshot and the guard would be meaningless.

```
  frozen capturedId  (in closure)   vs   live runCounter.current  (ref)
  the contrast is the guard — both-frozen = no guard
```

**Q: Does this cancel the old request?**
No — and that's the honest limitation. It drops stale *events* from touching the UI, but the old fetch keeps draining in the background. For a local tool that's fine. To also stop the work I'd add an `AbortController` and `abort()` at the top of `startReplay`; the decoder already honors `AbortSignal`.

## Validate

1. **Reconstruct:** write the three skeleton parts (ref counter, frozen capture, in-updater equality check) from memory. (`AgentReplayShell.tsx:97,107-116`)
2. **Explain:** why does `setRunId(nextRunId)` exist alongside the ref, and which one is authoritative? (State copy is for the "Run #N" badge only; the ref is the guard's authority — `:108` vs `:106-107`.)
3. **Apply:** the comparison flow runs fixture then OpenAI back-to-back. Why does it need its *own* `comparisonRunCounter` separate from the shell's? (It launches replays outside `startReplay`, so it can't reuse the shell's counter without colliding — `RecommendationWorkspace.tsx:67,112`.)
4. **Defend:** you switch this to `useState` for the counter. Walk the bug that appears. (The `onEvent` closure captures the state value at creation; `runCounter.current` becomes a stale snapshot, the `===` check compares two frozen values, and stale events are no longer reliably dropped.)

## See also

- `01-live-stream-consumption.md` — the `onEvent` callback this wraps.
- `03-shared-replay-shell.md` — where `startReplay` and the ref are defined.
- Cross-guide: `study-runtime-systems` (async callbacks, closures, event-loop timing).
