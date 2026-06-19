# Overview — the prompt surface of AptKit

One page. Where prompts live, what touches them, and the one path every prompt
travels from a TypeScript string literal to a parsed, validated result.

## The whole thing in one map

Here's the entire prompt-engineering surface of this repo as layered bands.
Find the prompt, follow it down to the parsed result.

```
  AptKit prompt surface — string literal to validated output

  ┌─ Prompt layer (packages/prompts/src) ───────────────────────────┐
  │  QUERY_PROMPT  RECOMMENDATION_PROMPT  MONITORING_PROMPT  ...      │
  │  each wrapped in a PromptPackage { id, version, capabilityId,    │
  │  system, variables[], examples[] }                              │
  └───────────────────────────┬─────────────────────────────────────┘
                              │  renderPromptTemplate(system, {schema, ...})
                              │  {var} → value substitution
  ┌─ Context layer (packages/context) ─▼────────────────────────────┐
  │  schemaSummary(workspace) → the {schema} string injected above   │
  └───────────────────────────┬─────────────────────────────────────┘
                              │  rendered system string
  ┌─ Runtime layer (packages/runtime) ─▼────────────────────────────┐
  │  runAgentLoop: turn loop, tool calls, then on the LAST turn      │
  │  appends buildSynthesisInstruction(...) → forced final answer    │
  │  parseAgentJson + parseResult → recovery re-prompt on parse fail │
  └───────────────────────────┬─────────────────────────────────────┘
                              │  Provider.complete(request)
  ┌─ Provider layer (packages/providers) ▼──────────────────────────┐
  │  anthropic | openai | fallback chain | local context-window guard│
  └───────────────────────────┬─────────────────────────────────────┘
                              │  validated typed result
  ┌─ Eval layer (packages/evals) ▼──────────────────────────────────┐
  │  replay artifact → structural-diff / detection-scorer /          │
  │  rubric-judge → promote to fixture → deterministic replay        │
  └──────────────────────────────────────────────────────────────────┘
```

## The one path, in words

A prompt in AptKit is never a free-floating string. It's the `system` field of
a `PromptPackage` carrying `id`, `version`, and `capabilityId`
(`packages/prompts/src/types.ts:13`). At call time the agent renders it —
`renderPromptTemplate` swaps every `{var}` for a value
(`packages/prompts/src/types.ts:24`) — injecting deterministic context like the
workspace schema (`packages/context/src/workspace-summary.ts:11`). The rendered
string becomes the `system` for `runAgentLoop`
(`packages/runtime/src/run-agent-loop.ts:76`), which runs the tool-calling turns
and, critically, **forces a final answer** on the last turn by appending a
synthesis instruction (`run-agent-loop.ts:104`). The output text gets parsed and
validated; on a parse miss, a recovery turn re-injects the prior tool results and
asks once more for the structured answer (`run-agent-loop.ts:195`).

## What's load-bearing here

Three mechanics carry the weight, and they're the ones to look at first:

1. **The forced-synthesis turn** (`buildSynthesisInstruction`,
   `run-agent-loop.ts:72`). The single most important prompt mechanic in the
   repo. Without it, a tool-using agent runs out of turns mid-thought and never
   emits the JSON you parse. Covered in 02 and 09.

2. **Parse-then-validate-then-recover** (`parseAgentJson` +
   `parseResult` + `recoveryPrompt`). The repo never trusts the model to emit
   clean JSON. It extracts from a fence, validates at the boundary, and
   re-prompts on failure. Covered in 02.

3. **The PromptPackage envelope** (`id` + `version` + `capabilityId`). Prompts
   are versioned code with provenance, not strings scattered through handlers.
   Covered in 03.

## What this repo does NOT do (read these honestly)

- No provider `response_format` / tool-calling-for-output. Structured output is
  JSON-in-a-markdown-fence parsed defensively. See 02.
- No real tokenizer. Token budgeting is a `length / 3` heuristic in the local
  context guard. See 04.
- No prompt-cache / `cache_control` directives. See 04.
- No self-critique or self-consistency loop. See 10.
- No explicit prompt-injection delimiters or instruction-hierarchy framing. See 12.
- No forbidden-opening lists or rotation history. See 13.

Each of those is a buildable target, not a hidden failure. The files name the
exact gap and what closing it would cost.
