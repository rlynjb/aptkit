# Overview — the prompt surface of aptkit

Before any single concept, here is the whole thing on one page. Where do
prompts actually live in this repo, and what touches them on the way to a
model call?

aptkit is a provider-neutral agent toolkit. That single design decision —
everything depends on a `ModelProvider.complete()` contract, never a vendor
SDK directly — is what makes its prompt engineering interesting. The same
prompt has to work whether it is sent to Anthropic's native tool API or to
a local Gemma model that has *no* tool API and has to be talked into JSON
by the system text. That gap is where most of the scar tissue in this guide
lives.

## The whole prompt path, one diagram

Here is every layer a prompt crosses between "a template in a file" and
"text the model actually sees," with the box each concept in this guide
attaches to marked.

```
  The prompt path — template to model, top to bottom

  ┌─ Source layer (version-controlled) ─────────────────────────┐
  │  PromptPackage { id, version, capabilityId, system, ... }    │ ← concept 3
  │  packages/prompts/src/{query,recommendation,...}.ts          │   prompts-as-code
  │  examples[] live here too — but feed evals, not the prompt   │ ← concept 8
  └───────────────────────────────┬─────────────────────────────┘
                                  │ renderPromptTemplate({var})
                                  │ + injectProfile(profile)        ← concept 1
  ┌─ Assembly layer ──────────────▼─────────────────────────────┐
  │  system = profile + template + {schema}/{intent} filled in   │ ← concept 4
  │  one capability = prompt + tool policy + loop + validator    │   token budgeting
  └───────────────────────────────┬─────────────────────────────┘
                                  │ runAgentLoop / generateStructured
  ┌─ Runtime layer ───────────────▼─────────────────────────────┐
  │  loop: model.complete() → tool_use? → tool result → repeat   │ ← concept 6
  │  last turn: synthesisInstruction forces a final answer       │   single-purpose
  │  structured: validate JSON → retry with strict suffix        │ ← concepts 2, 9, 12
  └───────────────────────────────┬─────────────────────────────┘
                                  │ ModelProvider.complete(request)
  ┌─ Provider layer (the seam) ───▼─────────────────────────────┐
  │  Anthropic: native `tools` array  →  real tool_use blocks    │ ← concept 2
  │  Gemma:    tool schemas rendered INTO system text + nudge    │   the emulation
  │  parseAgentJson strips fences, scans for {...}               │ ← concept 7
  └───────────────────────────────┬─────────────────────────────┘
                                  │ artifact: trace + output + usage
  ┌─ Eval layer (closes the loop) ▼─────────────────────────────┐
  │  rubric-judge (Claude judges Gemma), precision@k, replay     │ ← concepts 5, 10
  └──────────────────────────────────────────────────────────────┘
```

Read that top to bottom and you have the spine of the guide. A prompt
starts as a typed `PromptPackage` with a version stamp, gets a profile
spliced in and placeholders filled, runs through a bounded loop or a
structured-generation retry, hits a provider that either speaks tools
natively or fakes them in the system text, and produces an artifact that
the eval layer scores.

## The one seam that matters most

If you study one boundary in this repo, study the provider seam. Trace a
single axis — *who enforces the output contract?* — across it:

```
  Axis: who enforces "respond with a tool call"?

  ┌─ caller (the agent) ─┐   seam: ModelProvider   ┌─ Anthropic ──┐
  │  passes tools[] +    │ ════════╪═════════════► │  API enforces │
  │  toolSchemas         │                         │  tool_use     │
  └──────────────────────┘                         └───────────────┘
                          ════════╪═════════════► ┌─ Gemma ───────┐
                                  (it flips)       │  PROMPT TEXT  │
                                                   │  enforces it  │
                                                   │  (best effort)│
                                                   └───────────────┘
```

Same caller, same `tools` array, same `toolSchemas`. On the Anthropic side,
the provider hands the array to a native API and the model emits structured
`tool_use` blocks the platform guarantees. On the Gemma side
(`packages/providers/gemma/src/gemma-provider.ts:133`), there is no native
tool API, so `buildSystemText` *renders the tool JSON schemas into the
system prompt* and asks for "ONLY a single JSON object" — and when the model
ignores that, a corrective `RETRY_NUDGE` re-prompts it. The contract is the
same; the enforcement mechanism flips from platform to prose. Every prompt
in this repo has to survive that flip, which is exactly why structured
output, tolerant parsing, and retries are not optional polish here.

## How to use this guide

Each concept file follows the same shape: zoom out to where it sits, a
structure pass, a mechanism walkthrough anchored to real files, a recap
diagram, deeper context, an interview-defense block, and cross-links. Read
in the order in the [README](README.md) — operational discipline first.
