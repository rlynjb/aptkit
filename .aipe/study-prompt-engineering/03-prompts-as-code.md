# 03 — Prompts as code: versioning and observability

**Subtitle:** prompts-as-code — version-controlled prompt packages with
provenance (Industry standard)

## Zoom out, then zoom in

A prompt is source code. It gets reviewed, versioned, diffed, and shipped
through the same pipeline as the rest of your TypeScript. aptkit takes this
literally: every agent's prompt is a typed `PromptPackage` with an `id`, a
`version`, and a `capabilityId` — provenance baked into the value. Here's
where that lives.

```
  Zoom out — prompts as a versioned source layer

  ┌─ Source layer (git, reviewed, semver'd) ────────────────────┐
  │  ★ PromptPackage ★  { id, version, capabilityId, system }    │ ← we are here
  │  packages/prompts/src/{query,recommendation,monitoring,...}  │
  └───────────────────────────┬──────────────────────────────────┘
                              │ imported by the agent
  ┌─ Capability layer ────────▼───────────────────────────────────┐
  │  capability = prompt package + tool policy + loop + validator  │
  └───────────────────────────┬──────────────────────────────────┘
                              │ run → artifact
  ┌─ Observability layer ─────▼───────────────────────────────────┐
  │  replay artifact records capabilityId + provider + trace      │
  └────────────────────────────────────────────────────────────────┘
```

Zooming in: the concept is *treating the prompt as a first-class artifact*
rather than a string buried in a function. Two consequences fall out — you
can pin a prompt to a model version (a prompt that worked on Sonnet 3 can
break on Sonnet 4), and you can trace which prompt produced which output in
production.

## Structure pass

**Layers.** Source (the package literal) → capability (package + policy +
loop) → observability (the artifact with provenance).

**Axis — can you answer "which exact prompt produced this output?"** Trace
it:

```
  Axis: "is the prompt that produced this output identifiable?"

  inline string in a function  → NO  (no id, no version, can't diff)
  PromptPackage { id, version }→ YES (named, semver'd, reviewable)
  capability binds it to an id → YES (capabilityId on every event)
  artifact records capabilityId→ YES (provenance survives to disk)
```

**Seam.** The boundary that matters is between *the prompt as text* and
*the prompt as a versioned identity*. Inline strings live below that seam —
unidentifiable. `PromptPackage` lives above it. Cross that seam and the
prompt becomes something you can review, pin, and trace.

## How it works

You already version your code and pin your dependencies in `package.json`.
A prompt is a dependency of your agent's behavior, so it gets the same
treatment: a name, a version, a place in the dependency graph. Let's walk
how aptkit reifies that.

### Step 1 — the prompt is a typed value with provenance

The `PromptPackage` type forces three identity fields:

```ts
// packages/prompts/src/types.ts:13
export type PromptPackage = {
  id: string;          // 'query-agent.default'
  version: string;     // '0.1.0'  ← semver on the PROMPT
  capabilityId: string;// 'query-agent'  ← binds to the agent
  description: string;
  system: string;      // the actual prompt text
  compactSystem?: string;  // a token-budget variant (concept 4)
  variables: PromptVariable[];
  examples: PromptExample[];
};
```

And every agent's prompt is exported as one of these:

```ts
// packages/prompts/src/query.ts:56
export const queryPromptPackage: PromptPackage = {
  id: 'query-agent.default',
  version: '0.1.0',
  capabilityId: 'query-agent',
  description: 'Free-form workspace question answering ...',
  system: QUERY_PROMPT,
  variables: [ /* {schema}, {project_id}, {intent} declared */ ],
  examples: [ /* eval anchors */ ],
};
```

The `version` field is the load-bearing one. It says "this exact prompt
text is 0.1.0." When you change a word, you bump it, and now any artifact
that recorded `version: 0.1.0` is pinned to the old text. The
`variables[]` array is self-documenting — it declares which placeholders the
template expects, so a reviewer sees the contract without reading the regex.

### Step 2 — the capability binds prompt to identity

A prompt alone isn't an agent. aptkit's organizing idea is that a
*capability* = prompt package + tool policy + loop config + validator. The
agent pulls the package's system text and stamps the capability id onto
every trace event:

```ts
// packages/agents/query/src/query-agent.ts:71
this.prompt = options.prompt ?? queryPromptPackage.system;
// ...
const { finalText } = await runAgentLoop({
  capabilityId: QUERY_CAPABILITY_ID,   // 'query-agent' — stamped on every event
  ...
});
```

```
  Layers-and-hops — provenance from package to artifact

  ┌─ Source ─────────┐ hop 1: system text  ┌─ Capability ──────────┐
  │ queryPromptPackage│ ──────────────────► │ QueryAgent            │
  │ id/version/capId  │ hop 2: capabilityId │ runAgentLoop(capId)   │
  └───────────────────┘ ──────────────────► └──────────┬────────────┘
                                                hop 3: every event
                                                carries capabilityId
                                                        ▼
                                             ┌─ Observability ──────┐
                                             │ CapabilityEvent       │
                                             │ replay artifact JSON  │
                                             └───────────────────────┘
```

### Step 3 — observability: which prompt produced which output

Every event the loop emits carries the `capabilityId`
(`run-agent-loop.ts:112` — `model_usage`, `step`, `tool_call_*`). Those
events stream out as NDJSON and land in a replay artifact. The artifact
records `capabilityId`, `provider`, the full `trace`, and the output. So in
production you can take any saved artifact and answer: which capability ran,
against which provider, producing what. That's prompt observability — not
"we log the prompt string somewhere" but "the prompt's identity is attached
to its output by construction."

### Step 4 — the prompt + model-version pairing

Here's the operational scar this concept is really about. A prompt is not
portable across model versions. The Gemma provider defaults to `gemma2:9b`
(`gemma-provider.ts:47`); the Anthropic default is `claude-sonnet-4-6`. The
*same* tool-emulation system text that coaxes a clean JSON tool call out of
one model can fall apart on another that's chattier or formats differently.
The artifact records `provider` precisely so that when you see a regression,
you can ask "did the prompt change, or did the model under it change?" —
the question you cannot answer if the prompt is an anonymous inline string
and the model is implicit.

```
  Comparison — inline string vs PromptPackage when the model upgrades

  inline string + implicit model:
    Sonnet 3 → Sonnet 4 upgrade → outputs change → WHY? unknowable
    (no prompt version, no recorded provider)

  PromptPackage + recorded provider:
    artifact A: { version:'0.1.0', provider:'anthropic', model:'sonnet-3' }
    artifact B: { version:'0.1.0', provider:'anthropic', model:'sonnet-4' }
    same prompt version, different model → it's the MODEL → pin or re-eval
```

### Step 5 — the deployment story

Because the prompt is a value in a package, changing it is a code change: a
diff, a pull request, a review. The `@rlynjb/aptkit-core` bundle is
published with semver (`0.4.x`), and the prompt packages are re-exported as
part of that public surface (per the project's compatibility contract). A
prompt edit ships exactly like an API change — visible, reviewable,
versioned — not as a silent string swap that nobody notices until the eval
set regresses.

### The principle

The generalizing idea: **a prompt is a dependency of your system's
behavior, so it earns a name, a version, and a place in the dependency
graph.** The moment a prompt is an anonymous inline string, you've lost the
ability to diff it, pin it to a model, or trace its output. aptkit's
`PromptPackage` is the minimal reification that buys all three back.

## Primary diagram

The full prompts-as-code path, provenance flowing from source to artifact.

```
  Prompts as code — aptkit

  ┌─ Git / review ──────────────────────────────────────────────┐
  │  PromptPackage { id:'query-agent.default', version:'0.1.0',  │
  │                  capabilityId:'query-agent', system, vars }  │
  │  edited via diff + PR, semver-bumped on change               │
  └────────────────────────────┬──────────────────────────────────┘
                              │ imported, system text used
  ┌─ Capability ──────────────▼───────────────────────────────────┐
  │  prompt package + tool policy + loop + validator              │
  │  runAgentLoop(capabilityId) stamps every event                │
  └────────────────────────────┬──────────────────────────────────┘
                              │ NDJSON trace
  ┌─ Artifact (provenance on disk) ▼──────────────────────────────┐
  │  { capabilityId, provider, model, trace, output }             │
  │  answers: which prompt + which model → this output            │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The "prompts as code" framing is now standard practice — prompt registries,
versioned prompt stores, and prompt-management tooling all encode the same
idea. aptkit's version is deliberately lightweight: no external registry,
just a typed value in a workspace package, versioned by git and semver. That
fits a toolkit that publishes as one npm bundle.

The deeper connection is to evals (concept 5). Versioning a prompt is only
useful if you can tell whether a new version is *better*. The
`PromptPackage.examples` and the replay-eval pipeline are the other half:
version the prompt, run the golden set, compare scores across versions. And
the prompt+model pairing connects to token budgeting (concept 4) via
`compactSystem` — a second, shorter system variant in the same package, for
when the model or window changes.

## Interview defense

**Q: What does "prompts as code" actually buy you?**

Three things you lose with an inline string: diffability (review a prompt
change like a code change), pinning (tie a prompt version to a model
version, so you can tell a prompt regression from a model regression), and
observability (attach the prompt's identity to its output by construction).
aptkit's `PromptPackage` carries `id`/`version`/`capabilityId`, and every
trace event and artifact records the capability id and provider.

```
  inline string → unidentifiable output
  PromptPackage → artifact { capabilityId, version, provider } → traceable
```

Anchor: "`types.ts:13` — version on the prompt, capabilityId on every event,
provider on the artifact. That triple answers 'which prompt + which model
made this output.'"

**Q: A model upgrade lands Friday and 30% of outputs change. How does
prompts-as-code help you triage?**

Because the prompt version and the provider/model are both recorded on the
artifact, you can compare two runs with the *same* prompt version across the
two models and confirm the change is the model, not your prompt. Without
that pairing you're guessing. The fix is then scoped: re-eval the prompt
against the new model and pin or revise — not blindly rewrite.

Anchor: "Recorded `provider` + prompt `version` = the model-vs-prompt
question becomes answerable instead of a guess."

## See also

- [01-anatomy.md](01-anatomy.md) — the `PromptPackage` sections this
  versions
- [04-token-budgeting.md](04-token-budgeting.md) — `compactSystem` as a
  budget variant in the same package
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — versioning is
  only useful with evals to compare versions
- [06-single-purpose-chains.md](06-single-purpose-chains.md) — the
  capability = prompt + policy + loop + validator unit
