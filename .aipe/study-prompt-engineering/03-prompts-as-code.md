# 03 — Prompts as code

**Industry name(s):** prompt versioning / prompt provenance / prompts-as-source.
**Type:** Industry standard.

## Zoom out, then zoom in

A prompt that lives as an inline string inside a request handler is a liability:
nobody can diff it, nobody knows which version produced a given output, and a
model upgrade silently changes its behavior with no paper trail. AptKit treats
prompts as versioned modules. Look at where the envelope lives.

```
  Zoom out — prompts as versioned modules

  ┌─ Prompt layer (packages/prompts/src) ───────────────────────┐
  │  ★ PromptPackage { id, version, capabilityId, system } ★     │ ← we are here
  │  query · recommendation · monitoring · diagnostic            │
  └───────────────────────────┬──────────────────────────────────┘
                             │  imported by name, rendered, run
  ┌─ Agent layer ────────────▼──────────────────────────────────┐
  │  options.prompt ?? recommendationPromptPackage.system        │
  └───────────────────────────┬──────────────────────────────────┘
                             │  trace events carry capabilityId
  ┌─ Eval/observability layer ▼──────────────────────────────────┐
  │  replay artifact: { capabilityId, provider, ... }            │
  └───────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern: each prompt is a typed object with provenance — an
`id`, a `version`, and the `capabilityId` of the agent that owns it. It's a real
TypeScript module, so it diffs in git, gets reviewed in PRs, and ships in the
published bundle as part of the API surface.

## Structure pass

**Layers.** Two: the *package* (the versioned envelope) and the *binding* (the
agent that consumes `package.system`, with an override hook).

**Axis — held constant: "what identifies this prompt later?"**

```
  One question across the layers: what's the prompt's identity?

  ┌─ package ─────────────────┐  → id + version + capabilityId (declared)
  │ 'recommendation-agent.    │
  │  default', '0.1.0', ...   │
  └───────────────────────────┘
  ┌─ binding (agent) ─────────┐  → capabilityId stamped on every trace event
  │ RECOMMENDATION_CAPABILITY │
  └───────────────────────────┘
  ┌─ artifact (replay) ───────┐  → capabilityId + provider recorded in output
  │ { capabilityId, provider }│
  └───────────────────────────┘
```

**Seam — the override hook.** The load-bearing seam is `options.prompt ??
package.system`. On one side the package's versioned default; on the other a
caller-supplied override. The axis (identity) is at risk here: an override
bypasses the package's `version`, so a host app can run a prompt the artifact
can't trace back. That's the joint to watch.

## How it works

#### Move 1 — the mental model

You already version your API contracts — a `package.json` has a `version`, and a
breaking change bumps it. A prompt is an API contract with a model: it has a
shape, it has consumers, and a change to it can break them. So you version it the
same way.

```
  PromptPackage — a versioned contract

  ┌──────────────────────────────────────────────┐
  │ id:           'recommendation-agent.default'  │ ← stable name
  │ version:      '0.1.0'                          │ ← bump on change
  │ capabilityId: 'recommendation-agent'           │ ← owner / trace key
  │ system:       "You are a recommendation..."    │ ← the actual prompt
  │ variables:    [{ name:'schema', required }]    │ ← declared holes
  │ examples:     [{ input, expectedContains }]    │ ← few-shot + regression seed
  └──────────────────────────────────────────────┘
```

#### Move 2 — the walkthrough

**`id` — the stable name.** `'recommendation-agent.default'`. It identifies which
prompt this is, independent of its text. The `.default` suffix leaves room for
variants (`.compact`, `.experimental`) without renaming. **Breaks if missing:**
you can't reference a prompt except by its full text — no way to say "version 2
of *this* prompt."

**`version` — the change marker.** `'0.1.0'`. The pairing that matters in
production is *prompt version + model version*. A prompt tuned on
`claude-sonnet-4-6` may regress on the next model. When you bump the model, the
prompt version is your record of what the prompt was when it last passed evals.
**Breaks if missing:** a model upgrade silently changes behavior and you have no
marker for "the prompt was unchanged; the model moved."

**`capabilityId` — the trace key.** `'recommendation-agent'`. This is the thread
that ties a prompt to its outputs. Every trace event the agent loop emits carries
`capabilityId` (`run-agent-loop.ts:112`), and every replay artifact records it.
That's prompt observability: given an output, you can find which capability — and
therefore which prompt — produced it. **Breaks if missing:** you have outputs in
`artifacts/replays/` with no way to know which prompt made them.

```
  Provenance flow — capabilityId threads prompt → output

  PromptPackage.capabilityId
        │ used as
        ▼
  runAgentLoop({ capabilityId }) ──► trace.emit({ capabilityId, ... })
        │                                          │
        ▼                                          ▼
  replay artifact { capabilityId, provider }  NDJSON trace stream
        │
        └─ given any saved output, capabilityId tells you which prompt produced it
```

**`variables` + `examples` — the self-describing parts.** `variables` declares
the `{var}` holes the template expects, each with `required`; `examples` carries
input → `expectedContains` pairs (few-shot, and the seed of a regression suite —
see 05, 08). **Breaks if missing:** the template's holes are undocumented and a
caller can't tell what to pass.

#### Move 3 — the principle

A prompt is source code, so it gets what source code gets: a name, a version,
review, diffs, and a trace key. The single highest-leverage piece is the
`version + model` pairing — it's the only thing standing between you and a silent
Friday-afternoon regression when the model gets upgraded under you.

## Primary diagram

The package, its binding, and the provenance trail in one frame.

```
  Prompts as code — package to traced output

  ┌─ packages/prompts/src/recommendation.ts ────────────────────┐
  │ recommendationPromptPackage = {                              │
  │   id:'recommendation-agent.default', version:'0.1.0',         │
  │   capabilityId:'recommendation-agent', system: RECOMMENDATION_PROMPT,
  │   variables:[schema, project_id, diagnosis], examples:[...] } │
  └───────────────────────────┬──────────────────────────────────┘
        this.prompt = options.prompt ?? package.system  ← override seam
                             ▼
  ┌─ runAgentLoop({ capabilityId: 'recommendation-agent' }) ─────┐
  │   trace.emit({ type:'model_usage', capabilityId, provider }) │
  └───────────────────────────┬──────────────────────────────────┘
                             ▼
  ┌─ artifacts/replays/*.json ───────────────────────────────────┐
  │ { capabilityId:'recommendation-agent', provider:'anthropic',  │
  │   createdAt, durationMs, trace, eval, modelTurns }            │
  └───────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Every agent imports its prompt by name from `@aptkit/prompts` and
runs it through the loop with the matching `capabilityId`. The published bundle
re-exports the packages, so the prompts are part of the semver-`0.3.0` API
surface (`@rlynjb/aptkit-core`).

The type that makes provenance structural:

```
  packages/prompts/src/types.ts  (lines 13–22)

  export type PromptPackage = {
    id: string;            ← stable name, e.g. 'recommendation-agent.default'
    version: string;       ← '0.1.0' — bump on change; pairs with model version
    capabilityId: string;  ← 'recommendation-agent' — the trace key
    description: string;
    system: string;        ← the versioned prompt text
    compactSystem?: string;← declared variant slot (not yet wired — see 04)
    variables: PromptVariable[];
    examples: PromptExample[];
  };
       │
       └─ id/version/capabilityId are required, not optional. A prompt without
          provenance literally does not type-check as a PromptPackage.
```

The recommendation package, fully stamped:

```
  packages/prompts/src/recommendation.ts  (lines 78–84)

  export const recommendationPromptPackage: PromptPackage = {
    id: 'recommendation-agent.default',
    version: '0.1.0',
    capabilityId: 'recommendation-agent',
    description: 'Action recommendation generation from a supported diagnosis...',
    system: RECOMMENDATION_PROMPT,
    ...
```

The override seam and the trace binding in the agent:

```
  packages/agents/recommendation/src/recommendation-agent.ts  (lines 16, 60, 78)

  export const RECOMMENDATION_CAPABILITY_ID = 'recommendation-agent';
  ...
  this.prompt = options.prompt ?? recommendationPromptPackage.system;   ← override seam
  ...
  await runAgentLoop<IdlessRecommendation[]>({
    capabilityId: RECOMMENDATION_CAPABILITY_ID,   ← threads into every trace event
       │
       └─ the ?? lets a host app swap the prompt — but the swapped prompt skips the
          package's version field, so the artifact can no longer trace it back.
          That's the cost of the override; worth knowing before you reach for it.
```

And usage cost ties to provider/model at the same `capabilityId` — the other half
of "which prompt + which model produced this":

```
  packages/runtime/src/run-agent-loop.ts  (lines 111–121)

  trace?.emit({
    type: 'model_usage', capabilityId,
    provider: model.id, model: response.model ?? model.defaultModel ?? 'unknown',
    inputTokens: ..., outputTokens: ..., timestamp: timestamp(),
  });
       │
       └─ provider + model recorded next to capabilityId is the prompt+model
          pairing made observable: you can see this prompt ran on this model.
```

## Elaborate

Treating prompts as code is the practice that survives the most painful
production scenario in this discipline: the model upgrade. When the underlying
model changes, behavior changes — and if your prompts are inline strings with no
version, you can't tell whether a regression came from your change or theirs. The
`version + model` pairing turns "something feels off since Tuesday" into "prompt
0.1.0 was stable on sonnet-4-6, regressed on the new model — here's the eval diff."

AptKit gets the provenance shape right and leaves room to grow: `compactSystem`
is declared but unused (the variant slot exists), and there's no per-call log of
*which prompt version* produced a given artifact — only the `capabilityId`, not
the `version`. Recording `version` into the replay artifact alongside
`capabilityId` is the next increment; it's a small change with outsized payoff
when you're bisecting a regression across model upgrades.

Where it connects: `examples[]` here is also the seed of the regression suite in
05, and the published-API-surface constraint (these packages are part of
`@rlynjb/aptkit-core` 0.3.0) means a prompt change is a semver event.

## Interview defense

**Q: Why version a prompt?**
Because it's a contract with a model, and the model changes under you. The
load-bearing pairing is prompt version + model version: a prompt tuned on one
model can regress on the next, and the version is your marker for "the prompt was
unchanged; the model moved." Without it, a model upgrade is an unattributable
regression.

```
  prompt v0.1.0  +  sonnet-4-6   → eval pass   (baseline recorded)
  prompt v0.1.0  +  next-model   → eval regress → blame the model, not your edit
        ▲                              ▲
        └──── version is the constant ─┘ that makes the diff legible
```
Anchor: "`version: '0.1.0'` + provider/model in the usage trace — `types.ts:15`,
`run-agent-loop.ts:111`."

**Q: How do you know which prompt produced a given output in production?**
The `capabilityId` threads from the package through every trace event and into
the replay artifact. Given an output, the artifact's `capabilityId` tells you the
owning capability and therefore the prompt. The gap in this repo: it records
`capabilityId` but not the prompt `version` in the artifact — I'd add that.
Anchor: "`capabilityId` in `run-agent-loop.ts:112`, artifact keys in context.md."

## Validate

- **Reconstruct:** List the three provenance fields of a `PromptPackage` and what
  each one buys.
- **Explain:** Why is `capabilityId` required and not optional in
  `packages/prompts/src/types.ts:13`? What breaks in observability if it were
  optional?
- **Apply:** You're shipping a tuned recommendation prompt. What do you change in
  `packages/prompts/src/recommendation.ts`, and what does the published-bundle
  semver constraint mean for that change?
- **Defend:** A teammate inlines a quick prompt edit via `options.prompt` in
  `recommendation-agent.ts:60` to "test something." Explain what provenance that
  silently breaks.

## See also

- [01-anatomy.md](01-anatomy.md) — what's inside `system`.
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — `examples[]` as the regression seed; catching model-upgrade regressions.
- [04-token-budgeting.md](04-token-budgeting.md) — the unused `compactSystem` variant slot.
