# 07 — Recursion, Backtracking, and Dynamic Programming

**Industry name(s):** Recursion, tree/structural recursion, backtracking (constraint search), dynamic programming (memoization / tabulation). Type label: Language-agnostic foundation.

## Zoom out, then zoom in

These three are a family: recursion is the base (a function calling itself on smaller input), backtracking is recursion that explores a state space and undoes choices, and dynamic programming is recursion that caches overlapping subproblems. AptKit uses exactly one of them, minimally: a single piece of *structural recursion* that flattens nested JSON into searchable text. Backtracking and DP are `not yet exercised` — there's no state-space search and no overlapping-subproblem optimization anywhere in the kit. You've built the harder members of this family in `reincodes` (recursion call-stack visualizers, the river-crossing state-space search in `PG.ts`), so the absence here is teachable against work you've done.

```
  Zoom out — recursion in AptKit

  ┌─ Evals layer ────────────────────────────────────────┐
  │  collectText(value): flatten nested JSON → one string │ ← the one recursion
  │    recurse into arrays and objects, concat leaves      │
  └───────────────────────────┬───────────────────────────┘
                              │ used by containsText rule
  ┌─ (absent) ────────────────▼───────────────────────────┐
  │  backtracking (state-space search)  not yet exercised  │ ← your PG.ts
  │  dynamic programming (memo/tab)     not yet exercised  │
  └────────────────────────────────────────────────────────┘
```

Zoom in: recursion solves a problem by reducing it to smaller instances of itself plus a base case. `collectText` does this over the *shape* of JSON — a value is a leaf (return it) or a container (recurse into children, combine). Backtracking adds "try a choice, recurse, undo if it fails" for searching a space of possibilities. DP adds a cache so you don't recompute the same subproblem. AptKit needs only the first, because its one recursive problem (flatten a tree) has no choices to undo and no overlapping subproblems to cache.

## Structure pass

**Layers.** One: the evals layer, where `collectText` recurses over a JSON value. The other two members of the family have no layer in the repo.

**Axis — trace "subproblem structure": *what smaller problem does this reduce to, and do subproblems overlap?*** — the question that separates the three.

```
  One axis — "subproblem structure" — across the family

  structural recursion  reduce to children, combine, no overlap
  (collectText)         → tree recursion, O(nodes), each visited once

  backtracking          reduce to choices, recurse, UNDO on failure
                        → explores a state space, prunes dead branches

  dynamic programming   reduce to subproblems that OVERLAP → cache them
                        → memoize/tabulate to avoid recomputation

  the flip: collectText's subproblems are DISJOINT children (no
  overlap → no DP needed) with NO choices (no undo → no backtracking).
  it's the simplest member of the family.
```

**Seam.** The boundary worth naming is between *disjoint subproblems* (a tree's children — `collectText`, no caching needed) and *overlapping subproblems* (the same input reached by different paths — what DP exists to handle). AptKit's recursion sits firmly on the disjoint side: each JSON node is visited exactly once, so there's nothing to cache and no choice to backtrack. That single property — disjoint, choice-free subproblems — is why neither backtracking nor DP appears.

## How it works

### Move 1 — the mental model

You built recursion call-stack visualizers, so the shape is familiar: a function that handles the base case directly and otherwise calls itself on smaller pieces, with the call stack tracking where to return. `collectText` is the cleanest kind — *structural* recursion that mirrors the shape of the data: a leaf returns its text, a container recurses into each child and joins the results.

```
  The kernel — structural recursion over a tree

  collectText(value):
    if string  → return value           ← base case (leaf)
    if array   → children.map(collectText).join('\n')   ← recurse, combine
    if object  → values.map(collectText).join('\n')     ← recurse, combine
    else       → return ''               ← base case (non-text leaf)

  shape mirrors the data: leaves return, containers recurse+combine
```

The strategy in one sentence: when a problem's structure is recursive (a tree of objects/arrays), write a function whose *cases* match the structure — one base case per leaf kind, one recursive case per container kind — and let the call stack handle the descent. No cache, no undo, because each node is independent and visited once.

### Move 2 — the one recursion, and the two absences

**Structural recursion — `collectText`, flattening a tree to text.** Bridge from rendering nested JSON in the UI: to display arbitrary nested data you recurse, and `collectText` does the same to *search* it. The `containsText` eval rule needs to ask "does this subtree contain the word X anywhere?" — so it flattens the whole subtree into one string and does a substring check. The recursion is how it reaches every leaf regardless of nesting depth.

```
  Execution trace — collectText flattening a subtree

  value = {title: "Refund spike", tags: ["urgent", "billing"]}

  collectText({...})              object → recurse into values
    collectText("Refund spike")   string → "refund spike" (normalized)
    collectText(["urgent","billing"])  array → recurse into items
      collectText("urgent")       → "urgent"
      collectText("billing")      → "billing"
      join → "urgent\nbilling"
    join → "refund spike\nurgent\nbilling"
  ────────────────────────────────────────────────────────
  result: one string; containsText then does .includes(needle)
  each node visited exactly once → O(nodes), no cache needed
```

The load-bearing detail: the base cases. A string returns itself (optionally lowercased for case-insensitive search); a non-string, non-container leaf returns `''` (empty, contributes nothing). Without the `''` base case for numbers/booleans/null, the recursion would either throw or stringify them inconsistently. The base cases are what make the recursion *terminate* and stay well-typed at the leaves — drop them and you get either non-termination or garbage in the haystack. There's no visited set because JSON is a tree, not a graph — no cycles, so no risk of infinite recursion from revisiting.

**Backtracking — `not yet exercised`.** Bridge from your `PG.ts` river-crossing solver: backtracking is recursion that *makes a choice, recurses, and undoes the choice if the branch dead-ends* — it searches a space of possibilities and prunes. AptKit has no such search. Every recursive descent here (`collectText`, `getPath`) is deterministic — there are no choices to try and undo, no constraints to satisfy by search. The trigger that would summon it: a constraint-satisfaction problem — e.g. selecting a valid combination of tools/parameters subject to rules, where you'd try a choice, recurse, and backtrack on conflict. None exists; the agent delegates "what to try next" to the *model*, not to a backtracking search.

```
  Backtracking shape (absent here) — try, recurse, undo

  choose option →  recurse →  dead end? UNDO, try next option
       │                              │
       └──────── the UNDO is the defining move ───────┘

  aptkit's recursion never undoes — it's deterministic descent.
  the "search for what to do next" is the MODEL's job (the agent
  loop), not a backtracking algorithm.
```

**Dynamic programming — `not yet exercised`.** Bridge from memoized Fibonacci: DP applies when subproblems *overlap* — the same input is reached by many paths, so you cache (memoize) or build a table (tabulate) to compute each once. AptKit has no overlapping-subproblem structure. `collectText`'s subproblems are disjoint children; nothing recomputes the same input. The trigger: an optimization problem with optimal substructure and overlap — edit distance, longest common subsequence, optimal partitioning. The kit has no such problem; its "hard" decisions are made by the LLM, not by a DP table.

### Move 2.5 — current state vs future state

```
  Phase A (now)                  Phase B (would summon them)

  RECURSION                      (already present, minimally)
  collectText flattens JSON      more structural recursion as new
  → disjoint, no cache, no undo  nested-data evals appear (same shape)

  BACKTRACKING                   a constraint-satisfaction step done in
  not present                    CODE rather than delegated to the model
                                 (e.g. valid tool/param combination search)

  DYNAMIC PROGRAMMING            an optimization with overlapping
  not present                    subproblems (sequence alignment, optimal
                                 partition) — none exists in an LLM kit
```

The honest read worth stating plainly: in an LLM orchestration kit, the *search and optimization* that backtracking and DP classically handle is delegated to the model. The agent loop doesn't backtrack through a state space — it asks the model what to do next and bounds the attempts (`maxTurns`). That architectural choice is *why* these two foundations have no code here, and it's unlikely to change unless a deterministic constraint/optimization step is pulled out of the model and into code.

### Move 3 — the principle

Pick the simplest member of the recursion family that fits the problem's structure. If subproblems are disjoint children, plain structural recursion suffices — no cache, no undo. Add backtracking only when you're *searching* a space and must undo choices. Add DP only when subproblems *overlap* and recomputation is the cost. Reaching for memoization or backtracking on a problem with neither overlap nor choices is added machinery for nothing — exactly the trap `collectText` avoids by being a clean tree recursion. And in an LLM system, notice when the "search" has been delegated to the model instead of coded as an algorithm.

## Primary diagram

The one recursion, framed against the two absent family members.

```
  Recursion family in AptKit

  ┌─ EXERCISED: collectText, structural recursion ───────┐
  │  string → return (base)                               │
  │  array/object → map(collectText).join (recurse+combine)│
  │  other → '' (base)                                    │
  │  disjoint children, O(nodes), no cache, no undo        │
  │  used by containsText to flatten a subtree for search  │
  └────────────────────────────────────────────────────────┘
  ┌─ NOT YET EXERCISED ─────────────────────────────────┐
  │  backtracking — try/recurse/UNDO; search delegated to  │
  │                 the MODEL (agent loop), not coded       │
  │                 → your PG.ts is the from-scratch version │
  │  dynamic prog  — needs overlapping subproblems; none in  │
  │                 an LLM orchestration kit                 │
  └────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** `collectText` runs whenever a `containsText` structural-diff rule evaluates — the eval needs to check whether a word appears *anywhere* inside a (possibly nested) field of a replay artifact, so it flattens that field's subtree to one string first.

The structural recursion — `packages/evals/src/structural-diff.ts` (lines 185–192, `collectText`):

```
  function collectText(value: unknown, normalize: boolean): string {
    if (typeof value === 'string') return normalize ? value.toLowerCase() : value;  ← base: leaf string
    if (Array.isArray(value))
      return value.map((item) => collectText(item, normalize)).join('\n');          ← recurse: array
    if (value && typeof value === 'object')
      return Object.values(value).map((item) => collectText(item, normalize)).join('\n');  ← recurse: object
    return '';                                                                       ← base: non-text leaf
       │
       └─ four cases, mirroring JSON's shape: two base cases (string leaf, non-text
          leaf → '') and two recursive cases (array, object). The '' base case is
          load-bearing — without it, numbers/booleans/null would break the join or
          pollute the haystack. No visited set: JSON is a tree (no cycles), so the
          recursion always terminates at leaves.
  }
```

How it's consumed — same file, `assertContainsTextRule` (lines 144–160): it calls `getPath` (the tree *walk* from `04`) to address the field, then `collectText` (the tree *flatten* here) to turn that field's subtree into a searchable haystack, then a plain `.includes(needle)`. Two different tree operations — addressing then flattening — composed into one rule. That composition is the whole mechanism: walk to the node, recursively flatten it, substring-search the result.

There is no backtracking and no dynamic-programming code anywhere in `packages/` — no choice/undo recursion, no memoization cache, no DP table. That absence is the finding, and it's structural: the search-and-optimize work an LLM kit would otherwise code is delegated to the model.

## Elaborate

Recursion, backtracking, and DP form a ladder of increasing structure. Plain recursion mirrors recursive data (trees, nested expressions) — `collectText` is the textbook clean case. Backtracking (the N-queens / Sudoku / your river-crossing solver pattern) is recursion over a *decision tree* where you prune invalid branches and undo — its power is systematic exhaustive search with early cutoff. DP (Fibonacci, edit distance, knapsack) is recursion where the recursion tree has *repeated nodes*, so you trade memory for time by caching; tabulation is the bottom-up version that fills a table instead of recursing.

The reason AptKit only has the first rung is genuinely architectural, and it's worth internalizing for AI work: an agent loop *replaces* hand-coded search. Where a classical solver would backtrack through possibilities, the agent asks the model "what next?" and bounds the loop. Where a classical optimizer would fill a DP table, the model reasons. So an LLM orchestration kit naturally has rich structural recursion (data manipulation) and almost no backtracking/DP (the model absorbs that role). When you *do* see backtracking or DP in an AI codebase, it's usually a deterministic sub-problem deliberately pulled out of the model for correctness or cost — and that's the trigger to watch for here.

For how the agent loop's bounded "search for the answer" relates to recursion's call stack, see `03` (the message log as the loop's accumulating state) and `study-runtime-systems`.

## Interview defense

**Q: "Where's the recursion in this codebase, and what kind is it?"**

`collectText` in `structural-diff.ts` — structural recursion over JSON. Four cases mirroring the data: string leaf returns its text, non-text leaf returns empty string, array and object recurse into children and join. It flattens a subtree to one string so `containsText` can substring-search it. Disjoint children, each node visited once, O(nodes), no cache and no visited set because JSON is a cycle-free tree.

```
  string→return | array/object→recurse+join | other→''
  tree recursion, O(nodes), terminates at leaves
```

Anchor: *it's clean structural recursion — the '' base case is the load-bearing part that keeps it terminating and well-typed at the leaves.*

**Q: "Why no backtracking or dynamic programming here?"**

Because the search-and-optimize work they handle is delegated to the model. The agent loop doesn't backtrack through a state space — it asks the model what to do next and bounds the attempts with `maxTurns`. And there's no overlapping-subproblem optimization (edit distance, knapsack) anywhere — the model does the reasoning. `collectText`'s subproblems are disjoint children, so even it needs neither a cache nor an undo.

```
  backtracking's "search" → delegated to the model (agent loop)
  DP's "overlap" → no overlapping subproblems exist in the kit
```

Anchor: *in an LLM kit the model absorbs the search/optimize role — so you get rich structural recursion and almost no backtracking/DP.*

**Q: "When would you add backtracking or DP to this codebase?"**

When a deterministic constraint or optimization step gets pulled out of the model into code — for correctness or cost. Backtracking if there's a "find a valid combination subject to rules" search (try/recurse/undo); DP if there's an optimization with overlapping subproblems (sequence alignment, optimal partition). Neither exists today because every such decision is currently the model's job, bounded by the loop.

```
  pull a constraint search into code → backtracking
  pull an overlapping-subproblem optimization into code → DP
```

Anchor: *they appear when you deliberately move search/optimization out of the model and into deterministic code — until then the loop replaces them.*

## Validate

**Reconstruct.** Write `collectText`'s four cases from memory and identify the two base cases and two recursive cases. Explain why no visited set is needed (JSON is a tree, no cycles → guaranteed termination at leaves).

**Explain.** In `assertContainsTextRule` (`structural-diff.ts:144`), `getPath` and `collectText` are used together. What does each do, and why both? (Answer: `getPath` *addresses* the target field by dotted path; `collectText` *flattens* that field's subtree into a searchable string. Walk to the node, then recursively flatten it, then `.includes`.)

**Apply to a scenario.** A new eval needs to compute the minimum edit distance between a generated answer and a reference answer. Is that a recursion/backtracking/DP problem, and does the repo have anything like it? (Answer: edit distance is the canonical DP problem — overlapping subproblems, optimal substructure, solved with a table. The repo has nothing like it today; adding it would be the first DP in the codebase, and a legitimate one because it's a deterministic optimization you'd *want* out of the model.)

**Defend the decision.** Someone wants to memoize `collectText` "for performance." Defend leaving it uncached. (Answer: its subproblems are disjoint children — no node is ever recomputed, so there's nothing to memoize. A cache would add memory and bookkeeping for zero hits. Memoization helps only with *overlapping* subproblems, which a tree flatten doesn't have.)

## See also

- `04-trees-tries-and-balanced-indexes.md` — `getPath`, the tree *walk* that composes with this tree *flatten* in the `containsText` rule.
- `03-stacks-queues-deques-and-heaps.md` — the call stack (recursion's backing structure) and the agent loop as bounded iterative "search."
- `02-arrays-strings-and-hash-maps.md` — the substring `.includes` that consumes `collectText`'s flattened output.
- `study-runtime-systems` (neighboring guide) — the agent loop as the bounded iteration that stands in for hand-coded search.
