# Overview — the whole system in one frame

One page, one diagram. Skim only this file and you have the map: every major component, what it owns, and what it talks to. The detail lives in `audit.md` and the eight pattern files; this is the orientation you return to.

AptKit is not a deployed service. It's a **library monorepo** — eleven internal packages plus a Studio dev app, published as one npm tarball. There's no request coming in from the internet; the "request" is a host app calling an agent's method, or you clicking "Replay" in Studio. So the system map is a *dependency-and-data-flow* map, not a traffic map.

## The full system

This is the whole thing — every package as a labelled band, every arrow a real dependency or data hop. Read it top to bottom: input flows down into the agent loop, out to a provider, and the trace flows back up.

```
  AptKit — full system map (dependency + data flow)

  ┌─ Entry / UI layer ───────────────────────────────────────────────────┐
  │  apps/studio (React 18 + Vite)        host app importing               │
  │   click "Replay" → fetch POST          @rlynjb/aptkit-core              │
  │        │  Vite middleware                    │  calls agent.method()    │
  │        │  5 NDJSON stream routes             │                          │
  └────────┼─────────────────────────────────────┼──────────────────────────┘
           │  body: {fixtureId, mode}             │
           ▼                                      ▼
  ┌─ Capability layer — packages/agents/* (5 agents) ─────────────────────┐
  │                                                                        │
  │   anomaly-monitoring ──► diagnostic-investigation ──► recommendation   │
  │   (scan → Anomaly[])     (Anomaly → Diagnosis)        (Anomaly+        │
  │                                                        Diagnosis →     │
  │   query (NL → answer)    rubric-improvement            Recs[])         │
  │                                                                        │
  │   each agent = prompt package + tool policy + loop config + validator  │
  └────────────────────────────────┬───────────────────────────────────────┘
                                    │  runAgentLoop(...) + filtered tools
                                    ▼
  ┌─ Runtime core — packages/runtime (no internal deps) ──────────────────┐
  │   runAgentLoop  ───emits───►  CapabilityEvent[]  (the trace)           │
  │   bounded by maxTurns / maxToolCalls, forced synthesis turn            │
  │   structured-generation (retry+validate)   ndjson-stream (encode)      │
  │        │  every model call goes through ONE contract                   │
  │        ▼                                                               │
  │   ModelProvider.complete(request) ◄── the central seam ──┐            │
  └──────────────────────────────────────────────────────────┼────────────┘
                                                              │
  ┌─ Policy + context layer ───────────┐   ┌─ Provider layer — packages/providers/* ─┐
  │  packages/tools                    │   │  anthropic   openai   (vendor SDK calls) │
  │   ToolRegistry (Map by name)       │   │      ▲          ▲                        │
  │   ToolPolicy (Set allowlist)       │   │      └──────────┴── FallbackModelProvider│
  │   coverage-gate (Set tokens)       │   │            (sequential chain)            │
  │  packages/context (WorkspaceDescr) │   │  ContextWindowGuardedProvider (pre-flight│
  │  packages/prompts (templates)      │   │            token budget guard)           │
  └────────────────────────────────────┘   └──────────────────┬───────────────────────┘
                                                               │  HTTPS (only wire hop)
                                                               ▼
                                                    ┌─ External ──────────┐
                                                    │ Anthropic / OpenAI  │
                                                    │ model HTTP APIs     │
                                                    └─────────────────────┘

  ┌─ Testing / observability backbone — packages/evals + scripts + artifacts ─────────┐
  │  live run → artifact (artifacts/replays/*.json) → eval (structural-diff /          │
  │  detection-scorer / rubric-judge) → promote-to-fixture → FixtureModelProvider      │
  │  replays it deterministically (no network, no tokens spent)                        │
  └─────────────────────────────────────────────────────────────────────────────────┘

  ┌─ Publish boundary — packages/core ────────────────────────────────────────────────┐
  │  @rlynjb/aptkit-core: re-exports all 11 packages; bundledDependencies inlines       │
  │  them into ONE standalone tarball. App-specific product logic must not leak in.    │
  └─────────────────────────────────────────────────────────────────────────────────┘
```

## Legend — what each component is, owns, and talks to

| Component | What it is | What it owns | What it talks to |
| --- | --- | --- | --- |
| `apps/studio` | React + Vite dev app | The manual preview/replay UI; 5 NDJSON stream routes (`vite.config.ts`) | Imports core; POSTs to its own Vite middleware; consumes NDJSON |
| `packages/agents/*` | 5 capability agents | One capability each: `*_CAPABILITY_ID`, a tool policy, a loop config, a validator | Calls `runAgentLoop`; reads tools filtered by its policy |
| `packages/runtime` | Foundation, zero internal deps | The `ModelProvider` contract, `runAgentLoop`, `CapabilityEvent`, structured-generation, NDJSON helpers | Nothing internal depends downward; everything depends *on* it |
| `packages/tools` | Registry + policy + gate | `ToolRegistry` (Map by name), `ToolPolicy` (Set allowlist), `coverage-gate` (Set tokens) | Imports `ModelTool` from runtime; consumed by agents |
| `packages/context` | Pure types + renderer | `WorkspaceDescriptor`, `schemaSummary()` | No internal deps; consumed by agents/prompts |
| `packages/prompts` | Prompt packages | Per-agent templates with id/version/capabilityId provenance | Consumed by agents |
| `packages/providers/*` | `ModelProvider` adapters | anthropic/openai SDK adaptation; `FallbackModelProvider` chain; `ContextWindowGuardedProvider` | Implements the runtime contract; calls vendor SDKs over HTTPS |
| `packages/evals` | Eval functions | shape assertions, structural-diff, detection-scorer, rubric-judge, replay-runner | Reads replay artifacts; consumed by scripts |
| `packages/core` | The published surface | `@rlynjb/aptkit-core` re-export bundle; `bundledDependencies` | Re-exports all 11 packages; published to npm |
| `scripts/*.mjs` | Pipeline CLIs | eval / promote / replay / pack-standalone | Read artifacts + fixtures; write fixtures + tarball |
| `artifacts/replays/` | Saved JSON | Replay artifacts (the observability record) | Written by replay scripts/Studio; read by evals |

## The one axis to hold in your head: **who decides control flow?**

Trace that single question down the layers and the seams pop:

```
  "who decides what happens next?" — traced down the stack

  Studio / host app        → CODE decides (calls a fixed agent method)
  multi-agent pipeline     → CODE decides (fixed order: monitor→diagnose→recommend)
  runAgentLoop             → LLM decides (per turn: emit tool calls or finish)
  ...but bounded by        → CODE decides (maxTurns/maxToolCalls hard ceiling)
  ModelProvider.complete   → PROVIDER decides (which vendor, fallback, guard)
  vendor SDK               → EXTERNAL decides (the model itself)
```

The answer flips four times. Each flip is a seam worth studying — and each is a pattern file. The most important flip is at `runAgentLoop`: control hands from code to the LLM, then code claws it back with a hard iteration budget. That tension is the heart of the repo.
