# Recursion, Backtracking & Dynamic Programming

**Bounded iteration as a state space · state machines · backtracking search · memoization & tabulation (DP)** — Industry standard. **Status in aptkit: bounded iteration exercised (the agent loop); backtracking & DP `not yet exercised`.**

## Zoom out, then zoom in

aptkit's agent loop is the interesting case here. It walks a *state space* — but as bounded forward iteration, not recursion, and explicitly *not* backtracking. The load-bearing DSA lesson is the hard iteration cap. There's no dynamic programming anywhere in aptkit or buffr.

```
  Zoom out — where state-space iteration runs

  ┌─ Service layer — packages/runtime ───────────────────────────┐
  │  ★ run-agent-loop.ts:98  for (turn < maxTurns) ★              │ ← bounded
  │    each turn = a state: call model → maybe tools → repeat     │   iteration
  │    HARD CAP + forced-final turn = the load-bearing parts      │   (a state
  │  parseAgentJson:17  bounded substring scan (no recursion)     │    machine)
  └───────────────────────────────────────────────────────────────┘

  no backtracking · no memoization · no DP table anywhere
```

Zoom in: recursion, backtracking, and DP are all about *exploring a state space*. Recursion descends it; backtracking explores branches and undoes dead ends; DP caches overlapping subproblems so you never recompute. The agent loop touches the *first* idea (a state space traversed step by step) but deliberately avoids the others — it goes forward only, never branches, never backtracks. Naming that "it's iteration over states, capped, no backtracking" is the whole lesson. You built recursion-with-call-stack visualizers in `reincodes`; this file is about why the agent loop *isn't* one.

## Structure pass

```
  layers:  the state space  →  the exploration rule  →  the termination
  axis held constant: "how do we move through states, and when do we stop?"

  ┌─ bounded iteration ─────────┐   move FORWARD only; stop at cap or terminal
  │  agent loop (run-agent-loop) │   → linear path, no branching ★ EXERCISED
  └──────────────┬───────────────┘
                 │  seam: exploration flips from "forward only" to "branch + undo"
  ┌─ backtracking ──────────────┐   try branch, recurse, UNDO on dead end
  │  N-queens, puzzles           │   → explores a tree of choices  (not in aptkit)
  └──────────────┬───────────────┘
                 │  seam: exploration flips to "cache overlapping subproblems"
  ┌─ dynamic programming ───────┐   memoize / tabulate repeated subproblems
  │  edit distance, knapsack     │   → reuse, don't recompute  (not in aptkit)
  └──────────────────────────────┘
```

The axis — *how do we move through states, and when do we stop?* — puts the agent loop firmly in the top layer: forward-only, capped. The seams below mark what aptkit *doesn't* do. That negative space is honest curriculum, not a gap to apologize for.

## How it works

### Move 1 — the mental model

The agent loop is a **state machine**, not a recursion. Each turn is a state; the transition is "ask the model what to do next." It moves forward one turn at a time and stops on one of two conditions: a terminal state (the model produces text with no tool calls) or a hard iteration cap. That cap is what separates it from an unbounded loop — and it's the part that breaks catastrophically if you remove it.

```
  the agent loop as a bounded state machine

  ┌──────┐  tool calls?  ┌──────────┐  results   ┌──────┐
  │ MODEL│──── yes ──────▶│ RUN TOOLS│───────────▶│ MODEL│ ─┐
  │ TURN │               └──────────┘             │ TURN │  │ loop
  └───┬──┘                                        └──────┘ ◀┘
      │ no tool calls (text only)        ▲
      ▼                                  │ turn == maxTurns−1
   ┌──────┐                              │ → FORCE FINAL (drop tools)
   │ DONE │ ◀────────────────────────────┘
   └──────┘     two exits: terminal state OR hard cap
```

Compare it to your `reincodes` recursion visualizers: a recursive descent pushes frames and pops them, and its depth is bounded by the input. The agent loop has no frames to pop — it's a flat `for` loop whose bound is a *constant you set*, not a property of the input. That difference is the whole point: with an LLM deciding each transition, the input can't bound the loop, so you bound it yourself.

### Move 2 — walking the agent loop's state-space iteration

**The hard iteration cap — the single load-bearing part.** `run-agent-loop.ts:98`:

```ts
  for (let turn = 0; turn < maxTurns; turn += 1) {   // ← maxTurns defaults to 8 (line 87)
    signal?.throwIfAborted();
    const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
    const forceFinal = turn === maxTurns - 1 || budgetSpent;   // ← last turn OR budget gone
```

Read what breaks without the cap. The model decides each turn whether to call more tools. A confused or adversarial model can call tools forever — search, search again, never conclude. There's no input-derived bound, because the *model* drives the transition, not the data. So `maxTurns` is the termination guarantee. **Strip line 98's bound and the loop is unbounded — the agent can spin until it times out or burns the token budget.** This is the exact analog of BFS's empty-frontier termination (file 05): the condition people forget, that makes the difference between "terminates" and "hangs."

**The forced-final turn — guaranteed progress to an answer.** Lines 102-108:

```ts
    const response = await model.complete({
      system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
      messages,
      tools: forceFinal ? undefined : toolSchemas,   // ← on the last turn, REMOVE the tools
      ...
```

On the final allowed turn, the loop *removes the tools* from the request. The model physically cannot call another tool — it has to produce text. This converts "ran out of turns" from a failure (loop exits with no answer) into a graceful conclusion (model is forced to synthesize what it has). The boundary condition it fixes: without it, hitting the cap could leave `finalText` empty. With it, the cap always yields an answer. This is hardening *on top of* the skeleton — the cap guarantees termination, the forced-final guarantees a *useful* termination.

**The terminal state — the natural exit.** Lines 131-135:

```ts
    const toolUses = toolUsesFromContent(response.content);
    if (toolUses.length === 0) {   // ← model produced text, no tool calls
      finalText = text;
      break;                        // ← terminal state reached, exit early
    }
```

The *normal* exit: the model stops asking for tools and just answers. This is the agent reaching a terminal state before the cap — the happy path. The cap is the safety net for when this never happens.

**No backtracking — and that's deliberate.** The loop appends to `messages` and moves forward (line 124, 189). It never undoes a turn, never explores an alternative branch, never maintains a frontier of unexplored states. A backtracking search (N-queens, your river-crossing BFS) tries a choice, recurses, and *unwinds* on a dead end. The agent loop commits to each turn permanently. If a tool call was a mistake, the model has to *recover forward* (the `recoveryPrompt`/`runRecoveryTurn` path, line 195-217 — a one-shot retry, not a backtrack). The lesson: this is a *linear* state-space walk, not a *tree* search. Calling it backtracking would be wrong.

**parseAgentJson — bounded scanning, not recursion.** `json-output.ts:17`:

```ts
  const objectStart = candidate.indexOf('{');
  const arrayStart = candidate.indexOf('[');
  ...
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));   // ← grab outermost bracket span
```

You might expect a recursive-descent parser here. It isn't one — it's a bounded substring scan: find the first opening bracket, the last closing bracket, slice the span, hand it to `JSON.parse`. No recursion, no stack, `O(n)` over the text. The lesson: a full recursive parser is overkill when you just need to *extract* a JSON blob from chatty model output — the simplest bounded scan that survives the common failure (prose wrapped around the JSON) wins. The fenced-block regex (line 8) handles the ` ```json ` case first; the substring scan is the fallback.

**No dynamic programming — `not yet exercised`.** There's no overlapping-subproblem structure anywhere in aptkit or buffr. No edit distance, no knapsack, no memoized recursion over a table. The closest *conceptual* neighbor is the chunker's overlap (file 01) — but that's amortization, not DP. If aptkit ever did, say, optimal chunk-boundary placement to minimize fact-splitting, that'd be a DP problem. Today: nothing. Don't invent it.

### Move 3 — the principle

When a loop's transitions are decided by something you don't control — an LLM, external input, a network — you cannot let the *input* bound it; you bound it yourself with a hard cap and a forced terminal state. The agent loop is the cleanest example: a state machine that goes forward only, never backtracks, and *always* terminates because the cap and forced-final turn are non-negotiable. Termination you can prove beats cleverness you can't.

## Primary diagram

```
  recursion/backtracking/DP across aptkit — one frame

  CONCEPT          where                       status
  ──────────────────────────────────────────────────────────────
  bounded iter   ★ run-agent-loop.ts:98       EXERCISED
    hard cap        maxTurns (line 87)          load-bearing: no cap → hangs
    forced final    tools=undefined (line 105)  always yields an answer
    terminal exit   no tool_use → break (132)   the happy path
  bounded scan     json-output.ts:17           exercised (not recursion)
  backtracking     —                           not exercised (loop is LINEAR)
  recursion        —                           incidental only
  dynamic prog     —                           not exercised anywhere

  you've BUILT: recursion + call-stack visualizers (reincodes/Tree.ts),
  state-space BFS (PG.ts) → drill targets, not aptkit evidence
```

## Elaborate

Backtracking (try-recurse-undo) and DP (cache overlapping subproblems) are the two heavyweight state-space techniques — and aptkit needs neither because its state space is a *line*, not a tree or a lattice. That's a design choice with teeth: a forward-only agent loop is simpler to reason about and trivially terminating, at the cost of never re-exploring a bad decision. Some agent frameworks *do* add tree search (tree-of-thoughts, beam search over reasoning paths) — that's where backtracking and the priority-queue frontier (file 03, 05) re-enter the picture. aptkit deliberately stays linear. The reasoning-pattern view of the loop (ReAct, when the model should search vs answer) belongs to **study-agent-architecture**; this file owns only the *control-structure* view — it's a bounded state machine.

## Interview defense

**Q: What's the load-bearing part of the agent loop, the one people forget?**
The hard iteration cap. The model decides each turn whether to call more tools, so the input can't bound the loop — a confused model would call tools forever. `maxTurns` (default 8) is the termination guarantee, and the forced-final turn (removing tools on the last iteration) makes sure hitting the cap still produces an answer instead of an empty result.

```
  for turn < maxTurns:           ← cap = termination guarantee
    if last turn: drop tools     ← forced final = useful termination
    if no tool calls: break      ← terminal state = happy exit
  drop the cap → unbounded spin (the BFS empty-frontier of agent loops)
```

Anchor: "When an LLM drives the transitions, you bound the loop yourself — the cap is the same role as BFS's empty-frontier check: the difference between terminates and hangs."

**Q: Is the agent loop backtracking or a search?**
No — it's forward-only bounded iteration. No branching, no undo, no frontier of alternatives. It commits to each turn and can only recover *forward* (a one-shot recovery prompt), never unwind a bad choice. A real backtracking search (like a constraint puzzle) explores a tree and undoes dead ends; this walks a line.

**Q: Any dynamic programming in here?**
None. No overlapping-subproblem structure to memoize anywhere in aptkit or buffr. The chunker's overlap is amortization, not DP. If you wanted optimal chunk boundaries that minimize fact-splitting, *that* would become a DP problem — it isn't built.

## See also

- `01-complexity-and-cost-models.md` — why the capped loop is `O(maxTurns)`, a constant
- `05-graphs-and-traversals.md` — why the loop isn't a state-space graph search
- `03-stacks-queues-deques-and-heaps.md` — the PQ frontier tree-search would need (and the loop avoids)
- **study-agent-architecture** — the ReAct reasoning view of the same loop
