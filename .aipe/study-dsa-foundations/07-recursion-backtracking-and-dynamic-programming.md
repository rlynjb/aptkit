# Recursion, Backtracking & Dynamic Programming

**Industry name(s):** recursion · bounded iteration / state machines · backtracking · memoization / tabulation (DP) — *Industry standard*

> **Status: partially exercised.** The agent loop is a **bounded iterative state machine** — the closest thing aptkit has to a recursion-shaped control flow, and it's deliberately *iterative*, not recursive. Backtracking and dynamic programming are `not yet exercised` — no overlapping-subproblem cache, no search-tree with undo, runs anywhere in aptkit. You've built recursion-with-call-stack visualizers and recursive BST traversals; this file grounds the iterative state machine that's real and labels DP/backtracking as honest curriculum.

---

## Zoom out, then zoom in

The one control structure in aptkit that *could* have been recursive — the multi-turn agent loop — was written as a bounded `for` loop instead. That choice is the lesson.

```
  Zoom out — the loop that stands in for recursion

  ┌─ Service layer ─────────────────────────────────────────────┐
  │  ★ runAgentLoop ★  (packages/runtime/src/run-agent-loop.ts)  │
  │    for (turn = 0; turn < maxTurns; turn++)                   │
  │      model.complete() → maybe run tools → append → repeat    │
  │    a BOUNDED iterative state machine                        │
  │    (recursion-shaped: "keep going until done or capped")    │
  └───────────────────────────┬─────────────────────────────────┘
                              │ recovery path
  ┌─ one bounded retry, not a recursive descent ────────────────┐
  │  runRecoveryTurn() — a SINGLE extra turn if parse fails      │
  │  (NOT recursive backtracking; one shot, then give up)       │
  └──────────────────────────────────────────────────────────────┘

  not present anywhere: DP / memoization · backtracking search tree
```

Zoom in: recursion is "a function that calls itself on a smaller subproblem until a base case." An iterative state machine is the same idea unrolled into a loop with explicit state and an explicit termination bound. DP adds a cache so overlapping subproblems aren't recomputed; backtracking adds undo so you can explore a search tree and retreat. aptkit uses the loop; it has no use for the cache or the undo.

---

## Structure pass

**Layers:** the bounded loop (real), the single bounded recovery turn (real), backtracking (absent), DP (absent).

**Axis — control flow / termination:** trace "what guarantees this stops?"

```
  One axis — "what guarantees termination?"

  recursion          → a base case (smaller input each call)
  aptkit agent loop  → a TURN COUNTER + forced-final escape   ← real
  backtracking       → exhausted choices at every node        (absent)
  DP                 → a finite filled table / memo            (absent)

  the agent loop's guarantee is a HARD COUNT, not a base case —
  because the LLM, not the code, decides whether to "recurse" again
```

**Seam — code-bounded vs model-driven continuation.** Inside one turn, *code* decides the mechanics. But whether there's a *next* turn depends on whether the model emitted a tool call — the *model* drives the recursion-equivalent. The control axis flips at that seam: the loop is the code's, the recursion decision is the model's. That's why the bound must be a hard counter — you can't trust the model to hit a base case.

---

## How it works

### Move 1 — the mental model

You've watched recursion build and unwind a call stack frame by frame. The agent loop is that pattern *unrolled*: instead of `solve(state)` calling `solve(smaller_state)`, it's `for each turn: advance(state)`. The "subproblem" is "what's left after this turn's tool results come back." It would be natural to write it recursively — `runTurn(messages)` calls `runTurn(messages + results)` — but aptkit makes it an explicit loop so the termination bound is dead obvious and there's no stack-depth risk from a model that won't stop.

```
  Pattern — bounded iterative state machine (recursion unrolled)

  state = [userPrompt]
  ┌──────────────────────────────────────────────┐
  │ turn 0: model.complete(state)                 │
  │   tool_use? → run tools → append → continue   │──┐
  │   no tool?  → finalText, BREAK                │  │
  └──────────────────────────────────────────────┘  │ loop, not recurse
  ┌──────────────────────────────────────────────┐  │
  │ turn 1..maxTurns-1: same                      │◄─┘
  │   last turn → forceFinal: strip tools,        │
  │               demand the answer               │
  └──────────────────────────────────────────────┘
  termination: no-tool-use  OR  turn == maxTurns-1  OR  budget spent
```

### Move 2 — the walkthrough

#### The bounded loop and its three termination conditions

The whole control structure is a counted loop with explicit exits — no recursion, no implicit base case:

```ts
// packages/runtime/src/run-agent-loop.ts:98-109, 131-135
for (let turn = 0; turn < maxTurns; turn += 1) {     // HARD bound (default 8)
  signal?.throwIfAborted();
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;   // ← the escape
  const response = await model.complete({
    system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
    messages,
    tools: forceFinal ? undefined : toolSchemas,     // ← strip tools on final turn
    maxTokens, signal,
  });
  // ...
  const toolUses = toolUsesFromContent(response.content);
  if (toolUses.length === 0) { finalText = text; break; }   // ← natural exit
}
```

Three ways the "recursion" stops: (1) the model emits no tool call → it answered, `break`; (2) `turn` reaches `maxTurns - 1` → forced final; (3) the tool-call budget is spent → forced final. Recursion would rely on the model "knowing" to stop (a base case). aptkit doesn't trust that — it caps the depth in code.

#### The load-bearing part: the forced-final turn (the base case the model can't be trusted to reach)

Here's the skeleton, named by what breaks without each part:

```
  agent loop kernel        what breaks if removed
  ───────────────────────  ────────────────────────────────────────────
  turn counter (maxTurns)  no bound → model loops forever, never answers
  forceFinal flag          model keeps calling tools, never synthesizes
  strip tools on final     model calls a tool when it MUST answer → no text
  synthesisInstruction     model says "I need more data" instead of answering
  no-tool-use break        natural early exit when the model is done
```

The part people forget is **forceFinal stripping the tools** (`run-agent-loop.ts:108`). Setting `tools: undefined` on the last turn *removes the option to call a tool*, so the model has no choice but to produce text. Without it, an agent can hit the turn cap still trying to call tools and return *no answer*. This is the iterative analog of a recursion's base case — except the code imposes it, because the model won't impose it on itself. Naming this in an interview signals you built a real agent loop, not a toy.

#### The recovery turn: one bounded retry, NOT recursive backtracking

When the final text won't parse into the required shape, there's a *single* recovery attempt — and it's pointedly not a recursive retry tree:

```ts
// packages/runtime/src/run-agent-loop.ts:192-201
let parsed: T | null = null;
if (options.parseResult) {
  parsed = options.parseResult(finalText);
  if (parsed === null && options.recoveryPrompt) {
    const recoveryText = await runRecoveryTurn(options, options.recoveryPrompt(toolCalls));
    parsed = recoveryText === null ? null : options.parseResult(recoveryText);  // ONE retry
  }
}
```

Backtracking would explore alternatives, fail, undo, and try another branch — potentially many times. This does *one* extra turn and then gives up (`parsed` stays `null`). That's a deliberate non-backtracking choice: an LLM retry tree is unbounded cost with no convergence guarantee, so aptkit caps it at one. The contrast teaches backtracking by its absence — aptkit's "search" has no undo and no branch exploration because the cost model (each step is an expensive model call) makes exhaustive search the wrong shape.

#### The tolerant parser: recursion-free bounded scan

`parseAgentJson` is where you might expect a recursive descent parser — and aptkit deliberately doesn't write one:

```ts
// packages/runtime/src/json-output.ts:7-28
export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);   // 1. strip fences
  const candidate = (fence ? fence[1] : text).trim();
  try { return JSON.parse(candidate); } catch { /* fall through */ }   // 2. fast path
  const objectStart = candidate.indexOf('{');                  // 3. bounded scan
  const arrayStart = candidate.indexOf('[');
  const start = /* min of the two non-negative starts */;
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
  throw new Error('no parseable json in model output');
}
```

It tries `JSON.parse` (the standard library's parser does the real recursion), and on failure does a *bounded* substring scan — first brace/bracket to last — then parses that slice. No hand-rolled recursive grammar walk: it leans on `JSON.parse` for the recursion and adds only a tolerant outer envelope. The boundary condition it handles: a model wrapping JSON in prose or markdown fences. The lesson — don't write a recursive parser when a bounded scan plus the platform parser does the job.

### Move 3 — the principle

**When the "recursion" is driven by an untrusted decider, unroll it into a bounded loop with an enforced base case.** aptkit's agent loop is recursion's shape — advance until done — but because the LLM decides whether to continue, the termination guarantee has to be a hard counter and a *forced* final turn, not a base case the recursion hopes to reach. Backtracking and DP are absent for the same cost reason: when each "step" is an expensive model call, you can't afford to explore-and-undo or fill a table of subproblems. The structure you reach for is shaped by who controls continuation and what each step costs.

---

## Primary diagram

The full control flow — the bounded state machine and its non-recursive recovery.

```
  runAgentLoop — bounded iterative state machine (recursion unrolled)

  messages = [userPrompt]
  ┌─ for turn in 0..maxTurns ───────────────────────────────────┐
  │  forceFinal = (turn==maxTurns-1) OR budgetSpent              │
  │  resp = model.complete(tools = forceFinal ? none : schemas)  │
  │  append assistant message                                    │
  │  toolUses empty? ──yes──► finalText = text; BREAK            │
  │       │ no                                                   │
  │       ▼                                                      │
  │  run each tool → append tool_result → next turn             │
  └──────────────────────────────────────────────────────────────┘
       │ after loop
       ▼
  parseResult(finalText)
       null? ──► runRecoveryTurn (ONE shot) ──► parseResult again
                 (NOT backtracking — no branch tree, no undo)

  absent by design: memoization/DP table · backtracking search tree
  termination guarantee: HARD turn counter + forced-final (not a base case)
```

---

## Elaborate

Tail-recursion-to-iteration is a classic transform: any "call myself on the rest" can become a loop with explicit state. aptkit applies it for a non-classic reason — not stack-depth optimization, but *trust*. A recursive agent (`runTurn` calling `runTurn`) would let a misbehaving model drive arbitrary depth; the explicit `for (turn < maxTurns)` makes the bound a visible constant. This is the same instinct behind iterative-deepening and depth-limited search: cap the depth when you can't trust the search to terminate.

Dynamic programming earns its place when subproblems *overlap* — the same sub-input recomputed many times (Fibonacci, edit distance, knapsack). aptkit has no such structure: each turn's input is the growing conversation, never a repeated sub-input, so there's nothing to memoize. Backtracking earns its place when a search has *cheap* steps and you need to explore-and-undo (N-queens, sudoku, the river-crossing search you built in `PG.ts`). aptkit's steps are *expensive* (model calls), so exhaustive exploration is the wrong shape — hence one bounded recovery, not a retry tree. The honest framing: DP and backtracking aren't missing because the author didn't know them; they're absent because the problem shape (no overlapping subproblems, expensive steps) doesn't call for them.

---

## Interview defense

**Q: Is the agent loop recursive?**

> No — it's a bounded iterative state machine. It's recursion's *shape* ("advance until done") unrolled into `for (turn = 0; turn < maxTurns; turn++)`, because the LLM, not the code, decides whether to continue. You can't trust an untrusted decider to hit a base case, so termination is a hard turn counter plus a forced-final turn, not a recursive base case. Each turn calls the model, runs any tools it requested, appends results, and loops; it breaks early when the model emits no tool call.

```
  recursion:  solve(state) → solve(smaller)   base case stops it
  aptkit:     for turn<maxTurns: advance       counter stops it
```

**Q: What's the part of that loop people forget?**

> The forced-final turn — on the last iteration it sets `tools: undefined`, removing the model's option to call a tool, so it *must* produce an answer. Without it, an agent can burn through all its turns still calling tools and return no answer at all. It's the base case the code imposes because the model won't impose it on itself.

**Q: Why no backtracking or DP in the retry logic?**

> Cost. Backtracking and DP make sense when steps are cheap — explore, fail, undo, or fill a memo table. Here each step is an expensive model call with no convergence guarantee, so an LLM retry tree is unbounded cost for unclear gain. aptkit does exactly *one* recovery turn and then gives up. And there's no DP because no subproblem repeats — each turn's input is the growing conversation, never a recomputed sub-input, so there's nothing to memoize.

Anchor: *the agent loop is recursion unrolled into a bounded loop with a forced base case, because an untrusted model drives continuation and each step is expensive.*

---

## See also

- **01-complexity-and-cost-models.md** — the `O(maxTurns)` × (model-call cost) analysis of this loop.
- **03-stacks-queues-deques-and-heaps.md** — why the loop isn't a work queue.
- **05-graphs-and-traversals.md** — the traversal kernel (frontier/visited/terminate) the loop's termination echoes.
- `study-agent-architecture` — the ReAct/agentic-retrieval reasoning pattern this loop implements.
