# 03 — Prompts as code: versioning and observability

**Industry name:** prompt management / prompt versioning — *Industry standard*

## Zoom out, then zoom in

The Friday I learned this lesson: the underlying model got upgraded over the
weekend, 30% of my eval set regressed Monday, and I couldn't answer the only
question that mattered — *which prompt, on which model, produced the outputs that
used to pass?* I had prompts as strings scattered across handlers and no version
on any of them. Never again. **Prompts are source code: one file per prompt,
version-controlled, reviewed in PRs, and stamped with provenance so you can pair
a prompt version with a model version.**

aptkit gets this right structurally. Here's the shape.

```
  Zoom out — prompts as versioned code

  ┌─ Authoring layer (this concept) ──────────────────────────────┐
  │  packages/prompts/src/                                         │ ← we are here
  │    query.ts        → queryPromptPackage {id, version, capId}   │
  │    diagnostic.ts   → diagnosticPromptPackage                   │
  │    recommendation.ts, monitoring.ts                            │
  │  packages/prompts/src/types.ts → PromptPackage type            │
  └───────────────────────────┬────────────────────────────────────┘
                              │  rendered + sent
  ┌─ Runtime ─────────────────▼────────────────────────────────────┐
  │  agent loop / generateStructured → model.complete               │
  └───────────────────────────┬────────────────────────────────────┘
                              │  trace events carry capabilityId
  ┌─ Observability ───────────▼────────────────────────────────────┐
  │  CapabilityEvent {capabilityId, model, timestamp} (NDJSON)      │
  │  replay artifacts {provider, fixture, capabilityId} on disk     │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: the unit is the `PromptPackage` (`packages/prompts/src/types.ts:13`).
It's not a string — it's a record with `id`, `version`, and `capabilityId`. That
trio is the provenance that answers the Monday-morning question.

## The structure pass

**Layers:** the prompt *definition* (a typed record in git) → the *render* (vars
substituted) → the *run* (sent under a `capabilityId`) → the *trace/artifact*
(what was logged, with model id + timestamp).

**Axis — can you reconstruct what produced an output?** Trace it:

```
  Axis: "is this output traceable back to a prompt + model?"

  ┌────────────────────────────────────────────┐
  │ PromptPackage {id, version, capabilityId}   │  → YES, prompt identified
  └────────────────────────────────────────────┘
      ┌──────────────────────────────────────┐
      │ run under capabilityId               │  → YES, run tagged
      └──────────────────────────────────────┘
          ┌──────────────────────────────────┐
          │ artifact {provider, model, time}  │  → YES, model + when captured
          └──────────────────────────────────┘

  every layer carries identity → output is fully reconstructable
```

**Seam:** the `capabilityId` string. It's the join key that threads a prompt
definition → its run → its trace events → its replay artifact. `query.ts:59` sets
`capabilityId: 'query-agent'`; the loop stamps every `CapabilityEvent` with that
same id (`run-agent-loop.ts:116`); the artifact on disk records it too. **What
breaks if the seam is loose:** you have prompts and you have logs but you can't
join them, which is exactly the position I was in on that Monday.

**The honest gap:** the *prompt+model pairing* is half-built. The artifact
records the `provider` and `model`, and the package records the prompt `version`
— but nothing in the repo *joins them into a single regression key* (e.g. an eval
matrix indexed by `version × model`). So "which prompt version on which model"
is reconstructable by hand but `not yet exercised` as automation.

## How it works

### Move 1 — the mental model

You already version your API contracts — a `package.json` has a `version`, a
migration has a number, a published package has a semver. A `PromptPackage` is
that same instinct applied to the prompt: give it an `id`, a `version`, and a
stable `capabilityId`, and now a prompt change is a reviewable diff with a
version bump, not a silent string edit.

```
  Pattern — the PromptPackage record (prompts/src/types.ts:13)

  PromptPackage {
    id:           "query-agent.default"   ← stable name (review/audit)
    version:      "0.1.0"                 ← bump on every behavior change
    capabilityId: "query-agent"           ← the join key into traces/artifacts
    system:       "You are an AI analyst..."  ← the prompt body
    compactSystem?:  "..."                 ← token-budget variant (concept 04)
    variables:    [{name, description, required}]  ← the {placeholder} contract
    examples:     [{name, input, expectedContains}] ← eval anchors
  }
```

### Move 2 — walking the provenance

**Step 1 — the definition is a typed record in git.** `queryPromptPackage`
(`query.ts:56`) is a `const` export with the system string, the variable
contract, and examples. It's reviewed like any other code — a prompt PR shows the
exact diff of the instruction text. **What breaks without this:** prompt edits
ship as invisible string changes with no review surface and no version.

**Step 2 — the variable contract is explicit.** `variables[]` (`query.ts:62`)
declares `schema` (required), `project_id` (required), `intent` (required) with
descriptions. This is the typed interface to the prompt — it tells a caller what
must be supplied before `renderPromptTemplate` (`types.ts:24`) runs. **What
breaks without it:** a caller forgets `{schema}`, the regex leaves the literal
`{schema}` in the prompt, and the model gets a placeholder instead of data.

**Step 3 — the run is tagged with capabilityId.** When the agent runs the loop,
it passes `capabilityId` (`rag-query-agent.ts:67`, `RAG_QUERY_CAPABILITY_ID`),
and the loop stamps it onto every emitted event:

```
  Inline annotation — run-agent-loop.ts:116 model_usage event

  trace?.emit({
    type: 'model_usage',
    capabilityId,                  ← the join key, on every event
    provider: model.id,            ← which provider answered
    model: response.model ?? ...,  ← which exact model version
    inputTokens, outputTokens,     ← cost provenance (concept 04)
    timestamp: timestamp(),        ← when
  });
```

**Step 4 — the artifact persists it.** A replay artifact
(`artifacts/replays/*.json`) records `capabilityId`, `provider`, `fixture`, and
the model turns. That's the durable record: open an artifact months later and you
know which capability, which provider, and what the model actually emitted. The
fixture-replay backbone (see `../study-testing/`) turns this into deterministic
regression tests.

### Move 2.5 — current state vs future state

This concept is built-but-partial. Worth being precise about the line.

```
  Comparison — prompt provenance: now vs the gap

  NOW (shipped)                      │  GAP (not yet exercised)
  ─────────────────────────────────  │  ────────────────────────────────
  PromptPackage has id+version       │  no eval matrix keyed on
  capabilityId threads run→trace     │    (prompt version × model)
  artifact records provider+model    │  no automated "this prompt was
  compactSystem? slot for budget     │    validated against models X,Y,Z"
  prompts reviewed as code in PRs    │  drift across model upgrades is
                                     │    caught by re-running evals
                                     │    manually, not by a gate
```

The takeaway is what *doesn't* have to change: the provenance is already on the
wire (`capabilityId` + `model` in every event). Closing the gap is a build on top
of existing data, not a re-architecture — you'd add an eval run keyed on
`(version, model)`, not new instrumentation.

### Move 3 — the principle

**A prompt without a version is a liability the moment the model changes.** The
discipline isn't bureaucracy — it's the only thing that lets you answer "what
broke and why" after a model upgrade. Treat the prompt as the source it is: name
it, version it, review the diff, and stamp every run so the output traces back to
the exact prompt and the exact model that produced it.

## Primary diagram

The full provenance thread, definition to artifact.

```
  Prompts as code — the provenance thread

  DEFINITION (git)        prompts/src/query.ts
  ┌──────────────────────────────────────────────────────┐
  │ queryPromptPackage { id, version, capabilityId,       │
  │                      system, variables, examples }    │
  └───────────────────────────┬────────────────────────────┘
       renderPromptTemplate({schema, intent, project_id})
  RUN                         ▼   run under capabilityId
  ┌──────────────────────────────────────────────────────┐
  │ runAgentLoop({ capabilityId, model, system })          │
  └───────────────────────────┬────────────────────────────┘
       emit CapabilityEvent {capabilityId, provider, model, ts}
  TRACE / ARTIFACT            ▼
  ┌──────────────────────────────────────────────────────┐
  │ artifacts/replays/*.json {capabilityId, provider,      │
  │                           model, fixture, modelTurns}  │
  └──────────────────────────────────────────────────────┘
       join key throughout = capabilityId
```

## Elaborate

The "prompts as code" movement (Hamel Husain, the LangSmith/PromptLayer tooling
ecosystem) exists because the alternative — prompts as untracked strings — makes
the model-upgrade regression undebuggable. The `PromptPackage.version` here is
deliberately semver-shaped so a behavior change is a visible bump. The deeper
idea this repo nails is that *the prompt and the model are a pair*: a prompt
tuned on one model is not guaranteed on the next, so the provenance has to carry
both. aptkit carries both on the wire (`model.id` in every `CapabilityEvent`);
the missing piece is the gate that re-validates the pair on a model change.

## Interview defense

**Q: How do you manage prompts in production?** As versioned source: one
`PromptPackage` per prompt with `id`, `version`, `capabilityId`; reviewed in PRs;
every run stamped with the capabilityId and the model id so outputs trace back.
The capabilityId is the join key from definition to trace to artifact.

```
  PromptPackage {version} ──capabilityId──► trace {model, ts} ──► artifact
  "which prompt, which model, when" — answerable for every output
```
*Anchor: `PromptPackage` (`types.ts:13`); `capabilityId` stamped at
`run-agent-loop.ts:116`.*

**Q: What's the part people forget?** The **prompt+model pairing**. A prompt is
only valid *for a given model*. People version the prompt and forget the model
changed underneath it — which is exactly the 30%-regression Monday. The fix is an
eval gate keyed on `(prompt version × model id)`; in this repo the data for it is
captured but the gate is `not yet exercised`.

## See also

- `01-anatomy.md` — what's inside the `system` field being versioned.
- `04-token-budgeting.md` — the `compactSystem` slot is a budget variant of the package.
- `05-eval-driven-iteration.md` — the eval gate that should key on version × model.
- `../study-testing/` — fixture-replay turns artifacts into regression tests.
