# Error Recovery in Agents
*Error recovery in agents · bounded failure handling (Industry standard)*

An agent loop has more ways to go wrong than a function call, and the difference between a demo and a production agent is whether every one of them has a defined exit. aptkit's recovery isn't one mechanism — it's a *table* of failure modes, each with a specific handler, spread across the loop and the provider. A tool throws? The error goes back to the model as an observation. The loop runs long? A hard `forceFinal` stops it. The model emits junk JSON? A retry nudge re-prompts. The model says nothing? A fallback answer. The caller cancels? `throwIfAborted`. Five failure modes, five handlers, all bounded.

The one people forget — and the one an interviewer will dig for — is the **hard iteration budget**. There's no clever loop-detection here. aptkit does *not* notice the model calling the same tool with the same args three turns running. The only thing standing between you and an infinite loop is a counter: `maxTurns` and `maxToolCalls`. Blunt, but it's the safety net that always catches, and naming its bluntness honestly is the whole point.

## Zoom out, then zoom in

Map each failure mode to where it's caught. Some land in the loop, some in the provider.

```
Failure-mode table → aptkit's real handler
┌──────────────────────────┬──────────────────────────────────────────────┐
│ FAILURE                  │ HANDLER (where)                                │
├──────────────────────────┼──────────────────────────────────────────────┤
│ tool throws              │ catch → result becomes an OBSERVATION  (loop)  │
│ loop runs too long       │ forceFinal hard stop: tools off + synth (loop)★│
│ invalid tool-call JSON   │ RETRY_NUDGE re-prompt              (gemma prov) │
│ empty final output       │ FALLBACK_ANSWER                    (agent)     │
│ caller cancels           │ signal.throwIfAborted()            (loop)      │
├──────────────────────────┼──────────────────────────────────────────────┤
│ repeated identical call  │ NOT DETECTED — only the hard budget stops it  │
└──────────────────────────┴──────────────────────────────────────────────┘
```

The ★ is the backstop that catches everything the others miss, including the un-handled repeated-call case. Every other handler is a *graceful* recovery; the budget is the *guaranteed* one. A production agent needs both — the graceful ones keep quality up, the hard one keeps you from a runaway bill.

## Structure pass

Trace **failure** through one turn and watch where each mode exits.

A turn opens with cancellation: `signal?.throwIfAborted()` (`run-agent-loop.ts:99`). If the caller aborted, the loop throws here — clean exit, no partial work charged forward.

Then the budget check sets the tone for the whole turn: `forceFinal = turn === maxTurns - 1 || budgetSpent` (`:101-102`). If this is the last turn or the tool budget is spent, the turn runs *without tools* and *with* a synthesis instruction — failure-by-exhaustion is pre-empted into a forced answer.

Inside tool dispatch, a thrown tool is caught and *converted*, not propagated: the `catch` at `:163-168` packs the error message into a `tool_result` with `isError: true`. The failure becomes data the model observes next turn — the model can read "that tool failed" and try another path. That's the seam: a tool failure doesn't crash the loop, it *re-enters as an observation*.

The invalid-JSON mode never reaches the loop at all — it's caught one layer down in the Gemma provider's retry loop. And the empty-output mode is caught one layer *up*, in the agent's `finalText.trim() || FALLBACK_ANSWER`. Failure handling is layered: provider, loop, agent.

## How it works

### Move 1 — the mental model

Every failure mode either *re-enters the loop as information* (tool error, retry nudge) or *terminates the loop safely* (budget, abort, fallback). Nothing is allowed to crash silently or spin forever.

```
The kernel: re-enter as info, or terminate safely
  recoverable → feed back as observation → model adapts → loop continues
  fatal/exhausted → forced answer / fallback / throw → loop ends, bounded
```

### Move 2 — the moving parts

**Tool error → observation.** The dispatch wraps every `callTool` in try/catch and turns a throw into a result block. The model sees the error and can route around it.

```
callTool throws ──catch──► tool_result{ content:{error}, isError:true } ──► next turn input
```

```ts
// packages/runtime/src/run-agent-loop.ts:158-186
try {
  const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
  toolCall.result = result; resultContent = truncate(JSON.stringify(result));
} catch (error) {
  isError = true;
  const message = error instanceof Error ? error.message : String(error);
  toolCall.error = message;
  resultContent = truncate(JSON.stringify({ error: message }));   // ◄── error becomes data
}
// ...
toolResults.push({ type: 'tool_result', toolUseId: toolUse.id, content: resultContent,
  ...(isError ? { isError: true } : {}) });   // ◄── flagged, fed back as observation
```

**Budget exceeded → forceFinal hard stop.** The blunt backstop. On the final turn or when tool calls hit the cap, tools are stripped and a synthesis instruction forces an answer.

```ts
// packages/runtime/src/run-agent-loop.ts:101-109
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;     // ◄── hard iteration budget
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,   // ◄── no tools → model MUST answer
  maxTokens, signal,
});
```

The loop bound itself is the outer guarantee: `for (let turn = 0; turn < maxTurns; turn += 1)` (`:98`, default `maxTurns = 8`). It cannot run more than `maxTurns` times no matter what the model does.

**Invalid tool-call JSON → retry nudge.** Handled in the Gemma provider, not the loop. A malformed-but-attempted call earns a corrective re-prompt, bounded by `maxToolCallAttempts`.

```ts
// packages/providers/gemma/src/gemma-provider.ts:62-89 (condensed)
const messages = attempt === 0 ? baseMessages : [...baseMessages, { role: 'user', content: RETRY_NUDGE }];
// ...
const call = parseToolCall(raw);
if (call) return /* tool_use */;
if (looksLikeToolAttempt(raw)) continue;   // ◄── retry on botched JSON, up to maxToolCallAttempts
```

**Empty output → fallback answer.** Caught in the agent, above the loop. If the loop returns empty text, the agent substitutes a sane default instead of returning "".

```ts
// packages/agents/rag-query/src/rag-query-agent.ts:31, 82
const FALLBACK_ANSWER = "I couldn't find anything in the knowledge base to answer that.";
// ...
return finalText.trim() || FALLBACK_ANSWER;   // ◄── never return empty
```

**Cancellation → throwIfAborted.** Checked every turn (`:99`) and passed into each tool call's `{ signal }` (`:159`). An aborted run stops at the next turn boundary.

### Move 3 — the principle

Give every failure mode a defined exit, and layer them: recover gracefully where you can (errors-as-observations, retry nudges, fallbacks) and bound hard where you must (the iteration budget, the abort signal). The graceful handlers protect answer *quality*; the hard budget protects you from *cost and runaway* when the graceful ones don't fire. Never trust the model to terminate on its own.

## Primary diagram

```
Where each failure exits — one runAgentLoop run
┌──────────────────────────────────────────────────────────────────────────┐
│ turn start ─► signal.throwIfAborted()        ──cancel──► THROW (clean)      │
│        │                                                                   │
│        ▼  forceFinal = last turn OR budgetSpent ──► tools off + synth ─► END│
│        │                                            (hard budget backstop) │
│        ▼  model.complete                                                   │
│        │   invalid JSON? ──► RETRY_NUDGE (in provider, bounded) ──► retry   │
│        ▼                                                                   │
│   callTool ─► throws? ──catch──► tool_result{error} ──► observation, loop ↑ │
│        │                                                                   │
│        ▼  no tool_use ─► finalText ─► (empty? ─► FALLBACK_ANSWER) ─► END     │
└──────────────────────────────────────────────────────────────────────────┘
   NOT handled: repeated identical tool call — only the budget eventually stops it
```

## Elaborate

The honest gap, stated plainly: there is no loop-detection. If the model calls `search_knowledge_base{query:"x"}`, gets thin results, and calls `search_knowledge_base{query:"x"}` again unchanged, aptkit does nothing special — it dispatches it again, every time, until `maxToolCalls` is hit and `forceFinal` ends the run. The budget is the *only* thing that stops a stuck model. That's fine as a safety net (you never spin forever) but wasteful (you pay for the repeats). The exercise below closes exactly this gap. Also note tool cancellation is only `AbortSignal` pass-through — there's no per-tool timeout; a hung tool blocks until the caller aborts.

## Project exercises

### Add repeated-identical-tool-call detection

- **Exercise ID:** `EX-ERR-06a`
- **What to build:** Inside the dispatch loop, hash each `(toolName, args)` pair and detect when the model issues an identical call it already made this run. On a repeat, short-circuit: return the prior result (or a "you already called this, here's what it returned" observation) instead of re-dispatching, so the model is nudged to change course before the budget runs out. This is the Phase 4 robustness rep that closes the named honest gap.
- **Why it earns its place:** It's the documented missing piece — today only `maxToolCalls` stops a stuck model, and that's late and wasteful. Detecting the repeat early saves tool work and turns a silent spin into a corrective observation, exactly the kind of bounded-failure thinking interviewers probe.
- **Files to touch:** `packages/runtime/src/run-agent-loop.ts` (the dispatch loop, `:139-189`).
- **Done when:** A run where the model issues the same `(toolName, args)` twice executes the underlying tool only once and feeds back a repeat-signal observation, proven by a unit test counting `callTool` invocations.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: What stops your agent from looping forever?**

```
maxTurns (default 8) + maxToolCalls → forceFinal: tools off + "answer now"
```

A: A hard iteration budget. The loop is `for (turn < maxTurns)` and there's a `maxToolCalls` cap; hitting either flips `forceFinal`, which strips the tools and injects a synthesis instruction so the model is forced to answer with what it has. It's blunt but it always catches. Anchor: `run-agent-loop.ts:101-109`.

**Q: What happens when a tool throws mid-loop?**

```
catch → tool_result{ error, isError:true } → model observes it → adapts
```

A: It's caught and converted, not propagated. The dispatch wraps `callTool` in try/catch and packs the error into a `tool_result` flagged `isError`, which becomes the model's observation next turn — so the model can try a different tool. The loop never crashes on a tool failure. Anchor: `run-agent-loop.ts:163-186`.

**Q: Does it detect the model calling the same tool over and over?**

```
NO automatic loop-detection — only the hard maxToolCalls budget eventually stops it
```

A: Honestly, no — there's no repeated-call detection today. Identical calls dispatch every time until `maxToolCalls` is spent and `forceFinal` ends the run. The budget guarantees termination but pays for the repeats. Adding `(toolName, args)` hashing to short-circuit repeats is the obvious next improvement. That's the part people forget — they assume there's loop-detection, and there isn't; there's a budget.

## See also

- [03-react-pattern.md](03-react-pattern.md) — forceFinal and the synthesis turn in the loop's normal flow.
- [02-tool-calling.md](02-tool-calling.md) — the RETRY_NUDGE handler for invalid tool-call JSON.
- [01-agents-vs-chains.md](01-agents-vs-chains.md) — the bounds (`maxTurns`/`maxToolCalls`) set at the call site.
