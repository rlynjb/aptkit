# 06 — Tree-of-Thoughts

*Tree-of-Thoughts (ToT) — Industry standard as a paper (Yao et al. 2023); rare
in production.*

## Zoom out, then zoom in

This pattern is *not in AptKit, and that is the correct decision.* Place the
empty-and-staying-empty slot.

```
  The reasoning family, with the slot AptKit rightly skips

  ┌─ reasoning patterns ─────────────────────────────────────┐
  │   chain                                                   │
  │   ReAct ───────────── 5 agents                            │
  │   plan-and-execute ── NOT BUILT                           │
  │   reflexion ───────── rubric agent                        │
  │   ★ tree-of-thoughts ★ ── NOT BUILT (correctly)  ← here   │
  └──────────────────────────────────────────────────────────┘
```

Let me be blunt up front, because this is the file where hedging would hurt
you: tree-of-thoughts is **rarely worth it in production.** It explores multiple
reasoning branches in parallel, scores them, and keeps the best — which means
its cost is the *branching factor times the depth* in model calls. For the
analytics work AptKit does, that's a multiplier on latency and token spend to
solve a problem ReAct already solves linearly. AptKit doesn't use it. That's not
a gap; it's good judgment.

Where ToT genuinely earns its cost: puzzle-like problems with a *verifiable*
intermediate state and a real risk of *early wrong commitment* — Game of 24,
crosswords, certain proof search. AptKit has none of those. Anomaly diagnosis
doesn't branch into combinatorial possibilities you must search; it's a short
chain of grounded lookups.

Frontend anchor: ReAct is a single async function picking one next call.
Tree-of-thoughts is `Promise.all([branchA(), branchB(), branchC()])` — but where
each branch *itself* spawns more `Promise.all`s, and you run a scoring pass to
throw most of them away. You'd only build that if one straight path measurably
dead-ends. For a settings form, you'd never. For a chess engine, maybe.

## Structure pass

Trace the **cost axis** — "model calls per solved problem" — to show why ToT is
a hard sell.

```
  Cost axis: model calls to reach an answer

  Pattern             Model calls (rough)             When the cost pays off
  ──────────────────  ──────────────────────────────  ──────────────────────
  ReAct               ~ N steps (linear)              almost always
  ─ ─ ─ ─ ─ ─ ─ ─ ─   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   ─ ─ ─ ─ ─ ◄ SEAM
  tree-of-thoughts    ~ branching^depth + scoring     verifiable search,
                      (exponential-ish)               early-commit risk
```

The seam is where linear becomes branching. Above it ReAct pays N calls. Below
it ToT pays a branching factor raised to a depth, *plus* a scoring call per
frontier. You cross that seam only when a linear path provably can't find the
answer — a condition AptKit's analytics tasks never hit.

## How it works

### Move 1 — the mental model

Tree-of-thoughts generates several candidate next-thoughts at each step,
*scores* them, *prunes* the weak ones, and continues from the survivors — a
search over a tree of partial solutions, not a single line.

```
  Tree-of-thoughts = generate → score → prune → continue from survivors

                   root (problem)
                 ┌──────┼──────┐
              thoughtA thoughtB thoughtC      ← generate K branches
                 │8      │3      │7           ← score each (the evaluator)
              keep ✓   prune ✗  keep ✓        ← prune low scorers
              ┌──┼──┐         ┌──┼──┐
             …expand survivors only…          ← recurse to some depth
                       │
                       ▼
                  best leaf = answer
```

### Move 2 — the moving parts

**The branch generator**

```
  at each node: ask model for K different next thoughts
       │
       ▼
  [thoughtA, thoughtB, thoughtC]   ← K parallel candidates
```

Pseudocode: `candidates = await Promise.all(range(K).map(() => proposeNext(node)))`.
This is the cost: every node fans out K ways, so the call count compounds with
depth.

**The state evaluator**

```
  score each candidate: "how promising is this partial solution?"
       │
       ▼
  prune all but the top-M                        ← keeps the tree from exploding
```

Pseudocode: `scores = candidates.map(scoreThought); keep top M`. ToT *requires* a
usable evaluator — if you can't score a partial solution, you can't prune, and
the tree explodes. This requirement is exactly why ToT fits puzzles (clear
partial-state scoring) and not open-ended diagnosis (what's the "score" of
half a diagnosis?).

**The search strategy**

```
  BFS / DFS over survivors, to a bounded depth, then pick best leaf
```

Pseudocode: a frontier loop expanding survivors. This is the part that turns a
single chain of thought into a managed search — and the part that costs you a
real budget on branching, not just turns.

### Move 3 — the principle

Tree-of-thoughts trades a multiplicative compute bill for the ability to back
out of early wrong commitments — worth it only with a scorable partial state and
a real early-commit risk, which most production tasks lack.

## Primary diagram

The full search shape, with the blunt cost note and the narrow conditions that
justify it.

```
  Tree-of-thoughts — full shape (NOT in AptKit, correctly)

  build ONLY if: scorable partial state  AND  early-commit risk  AND
                 linear ReAct provably dead-ends
        │
        ▼
                 root
            generate K branches  ─────▶ cost = K^depth + scoring calls
            score + prune to top M
            recurse to depth D
            pick best leaf
        │
        ▼
   AptKit: none of the three conditions hold ──▶ stays empty
```

The empty box is the right answer for this codebase; draw the shape only to show
you know what you're declining.

## Implementation in codebase

**Not yet implemented — and intentionally so.** No AptKit capability branches its
reasoning. Every agent runs one linear `runAgentLoop` (`run-agent-loop.ts:76`)
that picks a single next step per turn; there is no candidate generation, no
scoring of partial solutions, no pruning frontier anywhere in
`packages/agents/*`.

Why that's correct here: AptKit's tasks fail *none* of the three ToT
preconditions. (1) No scorable partial state — there's no meaningful score for
"half a diagnosis." (2) No early-commit catastrophe — a wrong first query just
gets corrected by the next turn's reasoning, cheaply, because ReAct re-decides
each turn. (3) Linear ReAct doesn't dead-end — the budget+forced-synthesis turn
already produces a grounded answer (`run-agent-loop.ts:102-109`). Adding ToT
would multiply token cost and latency to solve a problem that's already solved.

If a future AptKit task *did* fit — say, searching over many mutually exclusive
root-cause hypotheses where committing to the wrong branch wastes the whole
budget — the build template would live in
`../06-orchestration-system-design-templates/`. Until such a task exists,
building ToT would be speculative complexity, and the honest engineering move is
to not build it.

## Elaborate

**Origin.** "Tree of Thoughts" (Yao, Yu, et al., 2023) generalized
chain-of-thought into a deliberate tree search with generate-evaluate-prune,
crushing GPT-4's Game-of-24 success rate (4% with CoT → 74% with ToT). The
headline result is real — *on puzzle tasks with verifiable intermediate state.*

**Adjacent concepts.** ToT is the search-y cousin of plan-and-execute
(`04-plan-and-execute.md`): both look ahead, but plan-and-execute commits to one
plan while ToT keeps several alive and scores them. "Graph of Thoughts" (2023)
generalizes the tree to a DAG. In practice most teams get ToT's benefit far more
cheaply with *best-of-N sampling* (generate N full answers, pick the best with a
judge) — one level of branching, no recursive frontier — which is the pragmatic
fallback when you think you want ToT.

## Interview defense

**Q: "Would you use tree-of-thoughts here?"**

```
  the three-gate test, all must pass

  scorable partial state?  ──NO──▶  don't build ToT
  early-commit catastrophe? ─NO──▶  don't build ToT
  linear ReAct dead-ends?   ─NO──▶  don't build ToT
  AptKit: three NOs ─────────────▶  correctly skipped
```

Anchor: "No — ToT needs a scorable partial state and a real early-commit risk,
and AptKit's diagnosis has neither; I'd be paying an exponential compute bill to
fix a problem ReAct already solves linearly."

**Q: "What's the cheap alternative if you *think* you want ToT?"**

```
  best-of-N: generate N full answers ─▶ judge picks best
  (one branch level, no recursion — most of ToT's gain, a fraction of the cost)
```

Anchor: "Best-of-N with an LLM judge — and I already have a judge pattern in the
rubric agent, so that's the reach, not a recursive tree." Surfaces the skeleton
part: best-of-N is just `Promise.all` of N `runAgentLoop` calls plus the
reflexion judge from `05-reflexion-self-critique.md` — no new machinery.

## Validate

- **Reconstruct:** Draw generate→score→prune→recurse and label the cost as
  `K^depth + scoring`.
- **Explain:** Name the three preconditions ToT needs and state which AptKit
  fails (all three — see Implementation).
- **Apply:** Propose the *cheaper* substitute for a task you think needs ToT and
  say which existing AptKit pattern you'd reuse (best-of-N + the rubric judge,
  `rubric-improvement-agent.ts:57`).
- **Defend:** A teammate read the ToT paper and wants to add it to the diagnostic
  agent. Talk them down with the cost axis and the missing scorable partial
  state (`diagnostic-agent.ts:55` runs linearly and the forced synthesis at
  `run-agent-loop.ts:102-109` already handles dead-ends).

## See also

- [03-react.md](03-react.md) — the linear pattern ToT would replace (don't)
- [04-plan-and-execute.md](04-plan-and-execute.md) — the look-ahead cousin
- [05-reflexion-self-critique.md](05-reflexion-self-critique.md) — the judge you'd
  reuse for the cheap best-of-N substitute
- `../06-orchestration-system-design-templates/` — where you'd build it if a task
  ever justified it
