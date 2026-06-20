# 05 — Fixture / provider mode switch

**Industry names:** environment/mode toggle · execution-strategy selector · "record-replay vs live" switch. **Type:** Project-specific (the fixture→anthropic→openai replay mode), built on a standard discriminated-mode-union idiom.

---

## Zoom out — where this lives

A small piece of state — `mode` — decides two big things: *where the agent runs* and *whether a Run button is even clickable*.

```
  Where the mode switch sits

  ┌─ UI layer (browser) ──────────────────────────────────────┐
  │  AgentReplayShell                                          │
  │    mode: 'fixture' | 'anthropic' | 'openai'  ◄─ ★ HERE ★   │ ← we are here
  │    providerStatus (from /api/model-status)                 │
  │       │                                                    │
  │       ├─ fixture → runFixture (browser, recorded) §03      │
  │       └─ provider → runServer (stream from server) §01     │
  │    gates the Run button on providerStatus[mode].available  │
  └─────────────────────────┬──────────────────────────────────┘
                            │ GET /api/model-status
  ┌─ Service (Vite middleware) ◄───────────────────────────────┐
  │  reports which API keys are set (env-driven availability)  │
  └─────────────────────────────────────────────────────────────┘
```

The question: **one UI, three ways to produce an agent result — deterministic recorded fixtures, live Anthropic, live OpenAI — how does mode flip the execution path *and* the UI affordances together?** You know this from any "mock vs real API" toggle, except here the choice also changes whether the work runs client-side or streams from the server.

## Structure pass

Axis — **"where does control actually execute?"** — flipped by `mode`.

```
  axis: "where does the agent run?"

  ┌─ mode = 'fixture' ────────────────────────┐
  │  agent runs IN THE BROWSER, recorded model │  → client owns execution
  └───────────────────────┬─────────────────────┘
                          │  the seam: mode flips it
  ┌─ mode = 'anthropic' | 'openai' ───────────▼┐
  │  agent runs ON THE SERVER, live provider    │  → server owns execution,
  │  result STREAMS back (§01)                  │     client consumes stream
  └───────────────────────────────────────────────┘
```

- **Layers:** mode selection (UI) → execution-path branch (`startReplay`) → either in-browser fixture run or server-streamed live run.
- **The seam** is `mode === 'fixture'` in `startReplay` (`AgentReplayShell.tsx:118`). On one side, `runFixture` runs the actual agent class in the browser against recorded `ModelResponse[]` (`agent-runners.ts:18-34`). On the other, `runServer` POSTs and consumes the NDJSON stream (`api.ts:51-57`). Control-of-execution flips here.
- **A second seam** is availability: `providerStatus[mode].available` gates the Run button (`AgentReplayShell.tsx:222`). Fixture is always available; providers are available only if their API key is set server-side. Trust/secret handling of those keys belongs to `study-security`.

## How it works

### Move 1 — the mental model

Three radio buttons. Picking one swaps the engine behind the Run button. Fixture is the "offline, deterministic, free" engine — it replays a recorded transcript through the real agent loop. The provider modes are the "online, nondeterministic, costs tokens" engines — they run the agent against a live model on the server and stream the trace back.

```
  The pattern: mode selects engine + gates affordance

   mode ──┬─ 'fixture'   ─► runFixture (browser, recorded)  always enabled
          ├─ 'anthropic' ─► runServer  (stream, live)       enabled iff key set
          └─ 'openai'    ─► runServer  (stream, live)       enabled iff key set
                                                  │
                              providerStatus[mode].available
                                  → Run button disabled? + "set KEY" hint
```

Strategy in one line: **`mode` is a discriminated selector that picks the execution path and, via `providerStatus`, the UI's enabled/disabled state.**

### Move 2 — the walkthrough

#### Part A — the mode union, per agent

The mode set differs by agent. Recommendation supports all three (`fixture | anthropic | openai`, `RecommendationWorkspace.tsx:33-37`); Monitoring, Diagnostic, Query, and Rubric support only `fixture | openai` (`MonitoringWorkspace.tsx:35-38`). The shell is generic over `M extends string`, so each workspace pins its own mode union, and the `<select>`/mode-switch only renders the modes that workspace passes.

What breaks if mode weren't per-agent: you'd show an "Anthropic" button on agents whose server path doesn't wire an Anthropic provider, leading to a dead button. Per-agent mode lists keep the affordances honest.

#### Part B — provider availability from the server

On mount, the shell GETs `/api/model-status` and stores `providerStatus` (`AgentReplayShell.tsx:138-145`). The Vite middleware reports availability purely from env: `anthropic.available = Boolean(env.ANTHROPIC_API_KEY)` (`vite.config.ts:206-212`). Fixture is hardcoded `available: true`. So the client never sees the keys — it sees booleans.

```
  availability flow (layers-and-hops)

  ┌─ UI ─────────┐  hop 1: GET /api/model-status   ┌─ Vite mw ───┐
  │ on mount     │ ──────────────────────────────► │ reads env    │
  │ setProvider  │  hop 2: { fixture:{available},   │ keys present?│
  │ Status(…)    │ ◄────── anthropic:{available},…} └──────────────┘
  └──────┬───────┘
         ▼ gates: Run button disabled = !providerStatus[mode].available
```

What breaks without this: the UI couldn't know whether a live run would fail for lack of a key until the request errored. The status call lets the button disable proactively and show "Set OPENAI_API_KEY and restart Studio" inline (`MonitoringWorkspace.tsx:193`).

#### Part C — the execution branch

```
  startReplay branch (pseudocode)

  result = mode === 'fixture'
     ? await runFixture(fixture)               // browser: real agent, recorded model
     : await runServer(fixture, mode, {onEvent})  // server: live provider, streamed
```

The fixture path is genuinely the *same agent class* (`new RecommendationAgent({ model: new FixtureModelProvider(...), ... })`, `agent-runners.ts:26-32`) — only the model provider is swapped for one that replays recorded responses. So fixture mode isn't a UI mock; it exercises the real agent loop, tool registry, and validators, just with a deterministic model. That's why it's trustworthy as a regression baseline.

What breaks if fixture mode faked the output instead of running the agent: you'd lose the regression-test value — the fixture run wouldn't catch a bug in the agent loop. Running the real loop with a fake model is the whole point.

#### Part D — selecting a mode resets the run

`selectMode(next)` sets the mode and clears `replay`, `liveTrace`, and `error` (`AgentReplayShell.tsx:155-161`), then the workspace bumps its `resetToken` (`RecommendationWorkspace.tsx:40`) to reset child panels (comparison, save state). It does *not* auto-run — the user clicks Run. This keeps a mode switch from silently firing a paid provider call.

What breaks if selecting a provider mode auto-ran: switching to "OpenAI" to *look* at the option would spend tokens. Requiring an explicit Run is a cost-safety choice.

### Move 3 — the principle

A mode toggle earns its keep when each mode is a genuinely different execution strategy, not just a label. Here fixture-vs-live flips both *where* the work runs (browser vs server) and *what it costs* (free/deterministic vs metered/nondeterministic), so the toggle must also drive the UI's affordances — disable what can't run, never auto-fire the expensive path. Tie the affordance to a server-reported capability (key present?) rather than guessing client-side, and the button can't lie about whether a run will work.

## Primary diagram

```
  Fixture / provider mode switch — full picture

  ┌─ UI: AgentReplayShell ─────────────────────────────────────┐
  │ ReplayModeSwitch: [Fixture] [Anthropic] [Openai]           │
  │   each ModeButton disabled = !providerStatus[mode].available│
  │                                                            │
  │ on mount: GET /api/model-status → providerStatus           │
  │                                                            │
  │ Run click → startReplay:                                   │
  │   mode==='fixture'                                         │
  │      → runFixture(fixture)   ┌─ browser ──────────────┐    │
  │                              │ new Agent({             │    │
  │                              │   model: FixtureProvider│    │
  │                              │   (recorded responses)})│    │
  │                              │ real loop, no network   │    │
  │                              └─────────────────────────┘    │
  │   mode==='anthropic'|'openai'                              │
  │      → runServer(fixture,mode,{onEvent})  ──POST──► stream │
  │                              ┌─ server (Vite mw) ──────┐    │
  │                              │ FallbackModelProvider   │    │
  │                              │ (live key, +fallback)   │    │
  │                              │ streams NDJSON (§01)    │    │
  │                              └─────────────────────────┘    │
  └────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

### Use cases

Every workspace built on the shell. The richest example is `RecommendationWorkspace`'s comparison feature, which deliberately runs *both* modes back-to-back: a fixture replay, then an OpenAI replay, then diffs their outputs (`RecommendationWorkspace.tsx:106-146`). That's the mode switch used as a measurement tool — same fixture, two engines, compare features/tokens/cost (`recommendation-panels.tsx:30-32`). The two-provider agents (Monitoring etc.) drop `anthropic` from their mode list because their server path only wires OpenAI-primary with Anthropic *fallback* (`vite.config.ts:769`), not Anthropic as a selectable mode.

### Code, line by line

```
  apps/studio/src/AgentReplayShell.tsx:118-120  — the execution branch

  const result = modeToRun === 'fixture'
    ? await runFixture(fixtureToRun)                          ← browser, recorded
    : await runServer(fixtureToRun, modeToRun as Exclude<M,'fixture'>, { onEvent });  ← server, streamed
       │
       └─ the `as Exclude<M,'fixture'>` cast encodes the invariant: runServer
          is only ever called with a non-fixture mode. The type says "in this
          branch, mode is a provider"
```

```
  apps/studio/src/AgentReplayShell.tsx:222-225  — the gated Run button

  <button className="runButton" onClick={startReplay}
          disabled={running || !providerStatus[providerKey(mode)].available}>  ← gate
    <Play size={17} />
    <span>{running ? 'Running' : mode === 'fixture' ? 'Run Fixture' : `Run ${modeLabel(mode)}`}</span>
  </button>
       │
       └─ disabled if a run is in flight OR the selected provider's key isn't set.
          providerKey() maps mode→status key (:236-240)
```

```
  apps/studio/src/agent-runners.ts:18-34  — fixture mode runs the REAL agent

  const model = new FixtureModelProvider(fixture.modelResponses);  ← recorded transcript
  const tools = new InMemoryToolRegistry(fixture.tools, handlers); ← recorded tool results
  const agent = new RecommendationAgent({                          ← the REAL agent class
    model, tools, workspace: fixture.workspace,
    idGenerator, trace: { emit: (event) => trace.push(event) },
  });
  return agent.propose(fixture.anomaly, fixture.diagnosis).then((recommendations) => {
    const evalResult = assertRecommendationShape(recommendations); ← the REAL validator
    return { recommendations, trace, evalOk: evalResult.ok, … };
  });
       │
       └─ fixture mode is not a mock of the output — it runs the genuine agent
          loop + tool registry + shape validator with a deterministic model.
          That's why it works as a regression baseline, not just a UI demo.
```

```
  apps/studio/vite.config.ts:206-212  — availability from env (server side)

  anthropic: { available: Boolean(env.ANTHROPIC_API_KEY),
               model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6' },
  openai:    { available: Boolean(env.OPENAI_API_KEY),
               model: env.OPENAI_MODEL ?? 'gpt-4.1' },
       │
       └─ client receives booleans + model names, never the keys themselves.
          Secret handling is study-security's lens; here it's just the
          source of the availability flag.
```

The provider abstraction (fallback chain, context guard) on the server side is `study-system-design`'s territory; this file owns only how the *client* selects and gates the mode.

## Elaborate

This is the UI face of the repo's central architectural seam: everything depends on the `ModelProvider.complete()` contract, never a vendor SDK directly (per the project context). Fixture mode swaps in a `FixtureModelProvider`; live mode swaps in an Anthropic/OpenAI adapter wrapped in a `FallbackModelProvider`. The Studio mode switch is literally a UI control over *which provider implementation* the agent loop receives — provider-as-strategy made clickable. The record-replay idea (run the real system against a recorded dependency) is the same one behind VCR-style HTTP fixtures and the broader "deterministic replay for regression" practice; what's notable here is that the recorded dependency is the *model*, the one nondeterministic part, so the rest of the system stays exercised.

What to read next: `01-live-stream-consumption.md` (the `runServer` path), `03-shared-replay-shell.md` (where `mode` and the runners live), then `study-system-design` (provider abstraction) and `study-security` (key handling).

## Interview defense

**Q: What does the Fixture/Anthropic/OpenAI toggle actually change?**
The execution strategy. Fixture runs the real agent loop *in the browser* against recorded model responses — deterministic, free, a regression baseline. Provider modes run the agent *on the server* against a live model and stream the trace back. `startReplay` branches on `mode === 'fixture'` to pick `runFixture` vs `runServer`. The toggle also gates the Run button on server-reported key availability so you can't fire a run that'll fail for a missing key.

```
  mode → fixture: browser+recorded | provider: server+live+stream; button gated on key present
```
Anchor: `AgentReplayShell.tsx:118-120,222`.

**Q: Is fixture mode just a mock?**
No — it runs the genuine agent class, tool registry, and shape validator, only swapping a `FixtureModelProvider` for the live model. So it catches bugs in the agent loop, not just the UI. That's why it's trustworthy as a deterministic regression run.

Anchor: `agent-runners.ts:18-34`.

**Q: Why doesn't switching to OpenAI auto-run?**
Cost. A provider run spends tokens. Selecting a mode clears the prior run and waits for an explicit Run click, so just *looking* at the OpenAI option costs nothing.

Anchor: `AgentReplayShell.tsx:155-161`.

## Validate

1. **Reconstruct:** write the `startReplay` execution branch and the Run-button `disabled` expression. (`AgentReplayShell.tsx:118-120,222`)
2. **Explain:** why does fixture mode instantiate the real `RecommendationAgent` rather than returning canned output? (To exercise the real loop/tools/validator as a regression baseline — `agent-runners.ts:26-34`.)
3. **Apply:** Monitoring offers only `fixture | openai`. Why not `anthropic`? (Its server path wires OpenAI-primary with Anthropic only as *fallback*, not as a selectable mode — `vite.config.ts:769`.)
4. **Defend:** the availability flag comes from the server, not the client. Why is that better than checking for a key in the browser? (The client never holds the keys — security — and the server is the source of truth for whether a live run can actually succeed; `vite.config.ts:206-212`.)

## See also

- `01-live-stream-consumption.md` — the `runServer` streaming path.
- `03-shared-replay-shell.md` — where `mode`/`providerStatus` live and the runners are injected.
- Cross-guide: `study-system-design` (provider abstraction / fallback chain), `study-security` (API key handling).
