# 05 — Guardrails and Control

*Guardrails / control envelope / agent safety — Pattern + in-codebase (the
control envelope is real and central; some guardrail layers are deliberately
absent).*

## Zoom out, then zoom in

An agent loop without controls is a model that can spend your budget forever,
return garbage the caller trusts, ignore a cancel, and — if its tools could
write — take actions you never sanctioned. Guardrails are the envelope that
makes the loop *safe to call in production.* AptKit's envelope has five layers,
and the cheapest, strongest one is a design choice you make before any code runs:
the tools are read-only. Start by seeing the layers wrapped around the loop.

```
  The control envelope around runAgentLoop (outermost = broadest safety)

  ┌─ READ-ONLY TOOL GRANT ── the key safety property ──────────────────┐
  │  every tool is read-only ; a hijacked agent can READ, never ACT     │
  │  ┌─ AbortSignal ── cancellation, threaded everywhere ─────────────┐ │
  │  │  signal.throwIfAborted() at the loop top + the tool boundary    │ │
  │  │  ┌─ OUTPUT GUARDRAIL ── parse + validate + 1-shot recovery ──┐ │ │
  │  │  │  the caller never trusts unvalidated agent output          │ │ │
  │  │  │  ┌─ FORCED SYNTHESIS ── budget hit ≠ giving up ──────────┐ │ │ │
  │  │  │  │  drop tools, demand a final answer from evidence      │ │ │ │
  │  │  │  │  ┌─ ITERATION + TOOL BUDGET ── runaway bound ───────┐ │ │ │ │
  │  │  │  │  │  maxTurns (default 8) + maxToolCalls             │ │ │ │ │
  │  │  │  │  │  ┌─ runAgentLoop (the kernel) ─────────────────┐│ │ │ │ │
  │  │  │  │  │  └──────────────────────────────────────────────┘│ │ │ │ │
  │  │  │  │  └────────────────────────────────────────────────────┘ │ │ │ │
  │  │  │  └──────────────────────────────────────────────────────────┘ │ │ │
  │  │  └───────────────────────────────────────────────────────────────┘ │ │
  │  └─────────────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────────────────────┘
```

The frontend anchor: this is the layered defense around a `fetch`. The budget is
a request timeout/retry cap. The output guardrail is validating the response body
before you `setState` from it. `AbortSignal` is the same `AbortController` you
pass to `fetch` to cancel a stale request. And the read-only grant is the
backend giving this client a read-only API key — even a compromised client can't
mutate anything.

## Structure pass

Trace the **failure axis** — *which specific failure does each layer stop.* The
seam separates "bound the agent's own runaway" from "protect the world from the
agent."

```
  The failure axis: which layer stops which failure

  Layer               Stops the failure...            Lives at
  ──────────────────  ──────────────────────────────  ─────────────────────────
  maxTurns            infinite reasoning loop          run-agent-loop.ts:102
  maxToolCalls        tool-call cascade / cost blowup  run-agent-loop.ts:101
  forced synthesis    "I need more data" non-answer    run-agent-loop.ts:104-106
  ─ ─ ─ ─ ─ ─ ─ ─ ─   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  ─ ─ ─ ─ ─ ─ ─ ◄ SEAM
  parse + validate    caller trusts garbage output     run-agent-loop.ts:192-199
  AbortSignal         work continues after cancel       run-agent-loop.ts:99
  READ-ONLY grant     agent takes a real-world action   tool policies (allowlists)
```

Above the seam: layers that bound the agent's *internal* runaway (turns, tools,
the non-answer). Below it: layers that protect *the outside* from the agent
(bad output, ignored cancellation, unsanctioned actions). The read-only grant is
the deepest because it's the only one that holds *even if every other layer is
bypassed* — a hijacked, runaway, mis-validated agent still can't write anything.

## How it works

### Move 1 — the mental model

Guardrails are *defense in depth*: independent layers, each stopping a different
failure, so no single bypass is catastrophic. You don't pick one — you stack
them, ordered so the strongest (read-only) is the one that holds when the others
don't.

```
  Defense in depth: independent layers, ordered by strength (PATTERN)

  weakest, cheapest ─────────────────────────────────▶ strongest, structural

  budgets    →  forced synth  →  validate  →  abort  →  READ-ONLY grant
  (bound the agent)            (bound the output)        (bound the blast radius)

  a failure that slips past one layer is caught by the next;
  the last layer holds even if all others are bypassed
```

The discipline: each layer assumes the previous one *might* fail. The budget
might not stop a model that flails within budget — forced synthesis catches that.
Validation might pass malformed-but-shaped output — read-only ensures even acting
on it can't write. You design for the bypass.

### Move 2 — the layers, one at a time

**Layer 1 — iteration + tool budget (bound the runaway)**

```
  two independent budgets feed one boolean

  budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls
  forceFinal  = turn === maxTurns - 1  OR  budgetSpent          (line 101-102)
       │
       ▼  either budget exhausted → force the final turn
```

Pseudocode: `forceFinal = turn == maxTurns-1 || toolCalls >= maxToolCalls`.
`maxTurns` bounds *conversation length*; `maxToolCalls` bounds *external work*.
You need both — a model can burn turns reasoning without tools, or many tools in
one turn — so they're orthogonal bounds.

**Layer 2 — forced synthesis (budget hit is a deadline, not a stop)**

```
  on the forced-final turn: DROP the tools, demand the answer

  forceFinal = true
       │
       ▼
  model.complete({
    system: system + synthesisInstruction,   ← "you have NO more tool calls"
    tools: undefined,                         ← ★ structurally can't ask for more ★
    messages })                               ← all evidence so far
```

Pseudocode: `if forceFinal: complete({ system: system+synth, tools: undefined })`.
By passing `tools: undefined`, the harness makes tool-calling *impossible* — the
model can't ask for more even if it wants to. This converts a budget cutoff into
a deadline: produce your best answer from what you have.

**Layer 3 — output guardrail (parse + validate + one-shot recovery)**

```
  the caller never trusts raw agent text

  finalText
       │  parseResult(finalText)            (line 194)
       ▼
  parsed === null ?  ── yes ──▶ runRecoveryTurn(recoveryPrompt(toolCalls)) (line 196)
       │ no                          │  fresh-message one-shot, re-parse
       ▼                             ▼
  return parsed  ◀─────────────────  parsed (or null if still bad)
```

Pseudocode: `parsed = parse(text); if parsed==null && recoveryPrompt: parsed =
parse(recover())`. The agent's output is validated against a per-capability shape
*before* the caller trusts it, with one recovery attempt if the first parse
fails. The output never triggers a side effect directly — it's data the caller
validates, then decides what to do with.

**Layer 4 — AbortSignal (cancellation, threaded everywhere)**

```
  one signal, checked at every yield point

  loop top:      signal?.throwIfAborted()        (line 99)
  model call:    model.complete({ ..., signal })  (passed through)
  tool call:     callTool(..., { signal })  → throwIfAborted at the boundary
       │
       ▼  abort fired anywhere → loop throws, stops immediately
```

Pseudocode: `signal?.throwIfAborted()` at the top of each turn + threaded into
model and tool calls. The same `AbortController` you pass to `fetch`. Without it,
a cancelled request keeps burning tokens and tool calls in the background.

**Layer 5 — the read-only tool grant (bound the blast radius)**

```
  every tool the agent may call only READS

  tool policy = allowlist of READ tools (get_*, execute_analytics_eql for SELECT)
       │
       ▼  even a hijacked / prompt-injected agent can:
  READ analytics  ✓                NOT mutate state  ✗
  (the worst case is a wrong answer, never a wrong ACTION)
```

Pseudocode: `allowedTools = [read-only tool names]`. This is the key safety
property. The tool policies (`03-tool-calling-and-mcp.md`) are read-only
allowlists, so the worst a compromised agent can do is return a wrong *answer* —
it can never take a wrong *action*. The blast radius is bounded by what the tools
*can't* do, not by trusting the model to behave.

### Move 3 — the principle

Safety is the envelope, not the model: bound the agent's runaway with budgets,
turn a cutoff into a forced answer, validate the output before anyone trusts it,
make cancellation real, and — strongest of all — grant only read-only tools so
the blast radius is a wrong answer, never a wrong action. Stack them so the last
layer holds when the others don't.

## Primary diagram

The complete control envelope mapped onto the loop.

```
  Control envelope on runAgentLoop (run-agent-loop.ts)

  messages = [ userPrompt ]
  ┌──────────────────────────────────────────────────────────────────┐
  │ for turn in 0..maxTurns:                          ← BUDGET (turns)  │
  │   signal?.throwIfAborted()                          (line 99) ABORT │
  │   budgetSpent = toolCalls >= maxToolCalls           (line 101) BUDGET│
  │   forceFinal  = turn==max-1 OR budgetSpent          (line 102)      │
  │   response = model.complete({                                       │
  │     system: forceFinal ? system+synthesis : system, ← FORCED SYNTH  │
  │     tools:  forceFinal ? undefined : toolSchemas,    (line 104-106) │
  │     messages, signal })                                            │
  │   if no tool_use: finalText; break                                 │
  │   for each tool_use:                                               │
  │     callTool(name, args, { signal })  ← READ-ONLY tools (line 159) │
  │     push truncate(result) into messages                            │
  └──────────────────────────────────────────────────────────────────┘
  parsed = parseResult(finalText)                       (line 194) ─┐
  if parsed==null && recoveryPrompt:                     (line 196)  │ OUTPUT
    parsed = parse(runRecoveryTurn(recoveryPrompt))                  │ GUARDRAIL
  return { finalText, toolCalls, parsed }  ◀── caller trusts `parsed`─┘
```

Read it as the loop wearing five jackets: the budgets gate the `for`, forced
synthesis rewrites the final `complete`, the signal is checked at every yield,
the post-loop tail validates, and every `callTool` only reads.

## Implementation in codebase

**Use case 1 — the two budgets, set per agent, enforced in the loop.**
`packages/runtime/src/run-agent-loop.ts:101-102` enforces; the agents set them:

```ts
// run-agent-loop.ts — enforcement:
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls; // line 101
const forceFinal = turn === maxTurns - 1 || budgetSpent;                            // line 102
```

```ts
// monitoring-agent.ts:76-77 — the per-agent setting:
maxTurns: 8,
maxToolCalls: 6,
```

Default `maxTurns` is 8 (`run-agent-loop.ts:87`); `maxToolCalls` is optional.
Recommendation tightens to 6/4, rubric to 6/3 — each agent picks bounds for its
risk profile.

**Use case 2 — forced synthesis.**
`packages/runtime/src/run-agent-loop.ts:104-106` + `buildSynthesisInstruction`
at `:72`:

```ts
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system, // line 104
  messages,
  tools: forceFinal ? undefined : toolSchemas,   // line 106 — ★ tools removed when forced ★
  maxTokens, signal,
});
// line 72:
export function buildSynthesisInstruction(middle) {
  return `You have NO more tool calls available. ${middle} Do not say you need more queries.`;
}
```

Line 106 is the mechanism: `tools: undefined` makes asking for more structurally
impossible. The agents fill the middle — `monitoring-agent.ts:78-80` tells it to
output the anomaly JSON array from gathered data.

**Use case 3 — output guardrail: parse, validate, one-shot recovery.**
`packages/runtime/src/run-agent-loop.ts:192-199`:

```ts
let parsed: T | null = null;
if (options.parseResult) {
  parsed = options.parseResult(finalText);                 // line 194 — parse + validate
  if (parsed === null && options.recoveryPrompt) {         // first parse failed
    const recoveryText = await runRecoveryTurn(options, options.recoveryPrompt(toolCalls)); // line 196
    parsed = recoveryText === null ? null : options.parseResult(recoveryText);
  }
}
```

`parseResult` wraps a per-capability validator —
`diagnostic-investigation/src/validate.ts:49` (`validateDiagnosis`),
`tryParseAnomalies` for monitoring. The caller receives `parsed` (typed or null),
never raw text it must trust. `runRecoveryTurn` (line 204) is a *fresh-message*
one-shot with a "output ONLY the structured answer, never ask for more data"
system prompt (line 211).

**Use case 4 — AbortSignal threaded throughout.**
`run-agent-loop.ts:99` (`signal?.throwIfAborted()` at the loop top), passed into
`model.complete` (line 108) and `callTool` (line 159), and re-checked at the tool
boundary (`tool-registry.ts:55`). One controller cancels the whole run.

**Use case 5 — the read-only tool grant.** Every agent's `allowedTools` is a
read-only allowlist — `monitoring-agent.ts:14-19`:
`execute_analytics_eql, get_metric_timeseries, get_segments, get_anomaly_context`
— all reads. There is no `delete_*`, `send_*`, or `update_*` in any first-party
policy. Even the rubric agent's `save_judgment` (`rubric-improvement-agent.ts:22`)
is a host-provided tool, not a first-party analytics mutation. The agent's
structured output never triggers a side effect directly; the caller decides.

**Not yet exercised: human-in-the-loop pause/resume.** There is no checkpoint,
no approval gate, no pause-for-confirmation before a sensitive step — the loop
runs to completion or aborts. Because the tools are read-only, no step *needs*
approval today; if a write tool were added, this is the layer you'd add first.
See SECTION F (`../06-orchestration-system-design-templates/`).

**Not yet exercised: input guardrail / prompt-injection sanitization.** There is
no input-sanitization layer — the user's question flows into the query agent
unsanitized, which is a real prompt-injection surface. The mitigating control is
the read-only grant: injection can steer the *answer* but cannot unlock an
action, because no action tool exists. Honest: the read-only grant is what makes
the missing input guardrail tolerable, not a substitute for it. See SECTION F.

## Elaborate

**Origin.** The control envelope is the production hardening every agent harness
converges on: bounded iteration (every framework has a max-steps), forced
termination, output validation, and cancellation. The read-only-by-default tool
grant is the agent-security principle of least privilege applied to the blast
radius — the cheapest, strongest control you can buy.

**Adjacent — the two budgets are defense in depth within one layer.** `maxTurns`
and `maxToolCalls` guard different runaways (reasoning loops vs tool cascades),
which is why both exist even though either alone bounds *something*.

**Adjacent — guardrails double as coordination control.** In a multi-agent
world, these same bounds limit per-agent runaway and stop a cascade from one bad
agent — see `../03-multi-agent-orchestration/09-coordination-failure-modes.md`,
which maps each failure mode to the AptKit control that already bounds it.

**Adjacent — the per-call prompt-injection defense.** The forced-synthesis and
recovery prompts are themselves a small per-call guardrail (constrain what the
model may do this turn). The general per-call defense + error-recovery patterns
are taught in `.aipe/study-ai-engineering/`, and the exact synthesis/recovery
*wording* in `.aipe/study-prompt-engineering/`.

## Interview defense

**Q: "What stops your agent from running away?"**

```
  two budgets → forceFinal → forced synthesis (tools dropped)
  maxTurns (line 102) + maxToolCalls (line 101) + tools:undefined (line 106)
```

Anchor: "Two orthogonal budgets — turns and tool calls — feed one `forceFinal`
boolean, and the budget exit doesn't just stop, it strips the tools and forces a
final answer from the evidence. A runaway is bounded *and* still produces an
answer."

**Q: "How do you make sure the caller never trusts garbage output?"**

```
  parse + per-capability validate + one-shot recovery (line 192-199)
  caller gets `parsed` (typed | null), never raw text
```

Anchor: "Every output is parsed and validated against a per-capability shape
before return, with one recovery turn if it fails. The caller receives typed data
or null — never raw model text it has to trust."

**Q: "What's your strongest safety control?"**

```
  READ-ONLY tool grant: allowlists are read-only
  worst case = wrong ANSWER, never wrong ACTION (holds even if hijacked)
```

Anchor: "The read-only tool grant. Every tool only reads, so even a hijacked or
prompt-injected agent can return a wrong answer but can never take a wrong
action. That's the layer that holds when every other one is bypassed — and it's
why I'm honest that there's no input-sanitization layer yet: the read-only grant
is what makes that gap tolerable, not a substitute for it." This is the
load-bearing control: bound the blast radius structurally, don't trust the model
to behave.

## Validate

- **Reconstruct:** Draw the five layers around the loop and name the file:line
  for each (budget 101-102, forced synth 104-106, validate 192-199, abort 99,
  read-only = the tool policies).
- **Explain:** Why does forced synthesis set `tools: undefined` instead of an
  instruction to stop? (`run-agent-loop.ts:106` — structurally impossible beats
  asking nicely; no tools offered means no tool_use can be emitted.)
- **Apply:** You add a write tool (e.g. `create_alert`). Which two guardrail
  layers must you add before shipping it? (a human-in-the-loop approval gate
  before the write, and an input-sanitization layer — both currently "not yet
  exercised" precisely because tools are read-only.)
- **Defend:** A teammate says "we don't sanitize user input, so we're wide open
  to prompt injection." Correct *and* qualify them. (correct: no input guardrail
  exists; qualify: the read-only grant bounds the blast radius to a wrong answer,
  not a wrong action — the gap is real but not catastrophic *today*.)

## See also

- [01-context-engineering.md](01-context-engineering.md) — the budgets also bound
  how large the context window grows
- [03-tool-calling-and-mcp.md](03-tool-calling-and-mcp.md) — the read-only
  allowlists this layer relies on
- [04-agent-evaluation.md](04-agent-evaluation.md) — the same `validate.ts`
  predicates gate output here and eval there
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the budget exit + forced
  synthesis as kernel bones
- `../03-multi-agent-orchestration/09-coordination-failure-modes.md` — each
  failure mode mapped to the control that bounds it
- `.aipe/study-ai-engineering/` — prompt-injection per-call defense + error
  recovery
- `.aipe/study-prompt-engineering/` — the synthesis + recovery prompt wording
