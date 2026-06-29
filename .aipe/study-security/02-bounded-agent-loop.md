# Bounded agent loop

*maxTurns / maxToolCalls budget with forced synthesis · Industry standard (resource bounding / liveness guard)*

## Zoom out, then zoom in

Here's the agent loop in the stack. The model and the tools talk back and forth — model asks for a tool, tool answers, model asks again. The question this concept answers: **what stops that conversation from going forever?**

```
  Zoom out — where the budget lives

  ┌─ Capability layer ──────────────────────────────────────┐
  │  agent passes maxTurns / maxToolCalls into the loop      │
  └───────────────────────────┬─────────────────────────────┘
  ┌─ Runtime layer ───────────▼─────────────────────────────┐
  │  runAgentLoop:  for turn 0..maxTurns {                  │ ← we are here
  │     ★ budget check ★ → model.complete → run tools        │
  │  }                                                       │
  └───────────────────────────┬─────────────────────────────┘
  ┌─ Provider layer ──────────▼─────────────────────────────┐
  │  model.complete()  (Gemma / Anthropic / OpenAI)          │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: this is a **bounded loop with a forced exit** — the agentic version of a `for` loop with a hard iteration cap instead of a `while (true)`. You already write this defensively in normal code: a retry helper with `maxRetries`, a pagination loop that stops at a page count, a `setTimeout` that bails. Here the loop body is "ask a non-deterministic model what to do next," which makes the cap a *safety* control, not just a robustness one: a model that's confused, adversarial, or being driven by an injected instruction cannot spin the loop or drain your token budget.

## The structure pass

Layers: **capability (sets the budget) → runtime (enforces it) → provider (does the work)**. Trace one axis — **control** ("who decides whether we go another round?") — down the stack.

```
  axis traced = "who decides to loop again?"

  ┌─ runtime loop ─┐   seam (last turn)   ┌─ provider call ─┐
  │ MODEL decides  │ ═══════╪═══════════►  │ no tools given  │
  │ (calls a tool) │   (control flips)     │ → MUST answer   │
  └────────────────┘                       └─────────────────┘
         ▲                                         ▲
         └──────── same axis, two answers ─────────┘
           → the forced-final turn is the seam where
             control is yanked back from the model
```

Normally the *model* decides to loop again by emitting another tool call. On the final allowed turn, control flips: the runtime strips the tools, so the model *cannot* call one and is forced to produce text. That flip — model-driven becomes code-driven — is the load-bearing seam, and it's the part people forget when they describe an agent loop.

## How it works

#### Move 1 — the mental model

The shape is a counted loop guarding a `while`-shaped process. Two counters (turns, tool calls), one termination condition the model controls (it stops calling tools), and one the *code* controls (the budget runs out). When the code's condition fires, it doesn't just `break` — it runs one more turn with the tools removed, so you always get a real answer instead of a dangling tool request.

```
  Pattern — bounded loop with a forced-synthesis exit

  turn = 0
  repeat:
    budgetSpent = toolCalls >= maxToolCalls          // code's exit
    forceFinal  = (turn == maxTurns-1) OR budgetSpent
    response = model.complete({ tools: forceFinal ? none : tools })
    if response has no tool calls:  finalText = text; STOP   // model's exit
    run the requested tools; append results
    turn += 1
  until turn == maxTurns

  two ways out:  model stops asking   |   budget forces a final answer
```

#### Move 2 — the load-bearing skeleton

This concept has a kernel — the counted loop — so walk it by what breaks when each part is removed.

**The kernel.** From `packages/runtime/src/run-agent-loop.ts:98-109`:

```ts
for (let turn = 0; turn < maxTurns; turn += 1) {          // (A) turn cap
  signal?.throwIfAborted();                                // (D) cancellation
  const budgetSpent =
    maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;  // (B) call cap
  const forceFinal = turn === maxTurns - 1 || budgetSpent;
  const response = await model.complete({
    system: forceFinal && synthesisInstruction
      ? `${system}\n\n${synthesisInstruction}` : system,
    messages,
    tools: forceFinal ? undefined : toolSchemas,           // (C) strip tools on exit
    maxTokens, signal,
  });
  // ... if no tool_use blocks: finalText = text; break;   // model's exit
```

**(A) The turn cap — remove it and the loop is `while(true)`.** Without `turn < maxTurns`, a model that calls a tool every turn never terminates. This is the difference between a loop you can reason about and one that can hang your process. rag-query sets `maxTurns: 6` (`packages/agents/rag-query/src/*`).

**(B) The tool-call cap — remove it and one turn can fan out unbounded.** A single model turn can emit *multiple* tool-use blocks. `maxToolCalls` (rag-query: 4) counts total calls across turns, so even if each turn is cheap, the model can't rack up an unbounded number of tool invocations (each of which is latency, cost, and a chance to misbehave). What breaks without it: the turn cap alone doesn't bound *work per turn*.

**(C) The forced-final turn — remove it and you get a dangling tool request.** This is the part that's easy to miss. When the budget is spent, the loop doesn't just stop — it makes one more `model.complete` call with `tools: undefined`. The model is given no tools, so it *must* answer in prose. Strip this and the loop's last action could be an unanswered tool call: the user gets nothing usable. The `synthesisInstruction` is appended to the system prompt on this turn — `buildSynthesisInstruction` produces "You have NO more tool calls available. ... Do not say you need more queries." (lines 72-74) — so the model is told plainly to conclude.

**(D) Cancellation — the optional hardening.** `signal?.throwIfAborted()` at the top of every turn (and inside `callTool`) lets a caller abort a run mid-flight via an `AbortSignal`. This is layered on top of the budget; the budget is the safety kernel, cancellation is responsiveness.

```
  Execution trace — rag-query, maxTurns=6, maxToolCalls=4

  turn 0: forceFinal=false → model calls search → toolCalls=1
  turn 1: forceFinal=false → model calls search → toolCalls=2
  turn 2: forceFinal=false → model answers       → STOP (model's exit)

  worst case (model keeps searching):
  turn 3: toolCalls=4 → budgetSpent=true
  turn 4: forceFinal=true → tools stripped → model MUST answer → STOP
```

**Separate skeleton from hardening:** the counted loop + tool-strip-on-exit is the kernel. The default values (`maxTurns = 8`, `maxTokens = 4096`), the 16k tool-result truncation (lines 52-57, which also bounds prompt growth), and the recovery turn for unparseable output (lines 192-228) are hardening on top.

#### Move 3 — the principle

Any loop whose body delegates the "should we continue?" decision to a non-deterministic component needs a deterministic outer bound. The model decides *when it's done*; the code decides *when it's done deciding*. Keeping those two authorities separate — and making the code's bound the hard one — is what turns "let the agent figure it out" from a liveness risk into a controlled process. The interview-grade detail is the forced-synthesis turn: bounding the loop is obvious; ensuring the bound still yields a usable answer is the part that signals you've built one.

## Primary diagram

```
  Bounded agent loop — full picture

  ┌─ Runtime: runAgentLoop ─────────────────────────────────────┐
  │  for turn in 0..maxTurns:                                    │
  │    budgetSpent = toolCalls >= maxToolCalls                   │
  │    forceFinal  = lastTurn OR budgetSpent                     │
  │         │                                                    │
  │   ┌─────▼─────┐  tools: forceFinal ? none : schemas          │
  │   │model.     │ ───────────────────────────────────────►    │
  │   │complete() │ ◄─── content (text and/or tool_use) ─────    │
  │   └─────┬─────┘                                              │
  │     no tool_use? ──► finalText; BREAK   (model's exit)       │
  │     tool_use?    ──► run tools (capped), loop   ────────►    │
  │     forceFinal?  ──► tools stripped → MUST answer (code exit)│
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

This is resource-bounding, the same instinct behind a query timeout, a circuit breaker, or a `ulimit`. The agent-specific twist is the forced-synthesis exit, which exists because an LLM loop's "natural" termination (the model decides to stop) is not guaranteed — a stuck or adversarial model can keep requesting tools indefinitely. The pattern shows up across production agent frameworks under names like "max iterations" or "step budget"; what's worth recognizing here is that aptkit pairs the cap with a graceful exit rather than a hard `break`. See `01-tool-policy-least-privilege.md` (bounds *what* the model can do, where this bounds *how much*), and `study-agent-architecture` for the loop as a reasoning pattern.

## Interview defense

**Q: What stops an agent loop from running forever or draining your token budget?**
Two hard caps the *code* owns, not the model: `maxTurns` (rag-query: 6) bounds iterations, `maxToolCalls` (4) bounds total tool invocations across turns. The model decides when it's done by stopping its tool calls; the code decides when it's done deciding. A confused or adversarial model hits the budget and gets cut off.

```
   for turn < maxTurns:
     forceFinal = lastTurn OR toolCalls >= maxToolCalls
     model.complete({ tools: forceFinal ? none : tools })
     no tool call → done    |    forceFinal → MUST answer
```
*Anchor: the forced-final turn strips the tools so you always get an answer, not a dangling tool request.*

**Q: What's the part people forget?** The forced-synthesis turn. Capping iterations is the obvious half — but if you just `break` when the budget runs out, the loop's last act might be an unanswered tool call and the user gets nothing. Stripping `tools` on the final turn forces the model into prose, so the bound still produces a usable result.

## See also

- `01-tool-policy-least-privilege.md` — bounds *what* the model may call; this bounds *how often*.
- `03-hallucination-tolerant-tool-args.md` — defends the arguments inside each bounded call.
- `audit.md` lens 7 (LLM/agent security).
