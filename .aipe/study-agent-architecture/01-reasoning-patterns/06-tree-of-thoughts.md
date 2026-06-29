# Tree of Thoughts

**Industry standard.** "Tree of Thoughts," "ToT," "branching search over reasoning." Type label: reasoning pattern. **In this codebase: not implemented, and correctly so.** aptkit explores no reasoning branches; it runs a single ReAct path. Cover it so you can say *why you didn't use it* — which is the more common (and stronger) interview answer.

## Zoom out, then zoom in

ToT explores multiple reasoning branches, scores them, and picks the best. It's the heaviest pattern in the family, and it rarely earns its cost in production. aptkit doesn't touch it.

```
  Zoom out — ToT's place in the family (aptkit skips it)

  ┌─ Pattern family (SECTION A) ────────────────────────────┐
  │  ReAct → plan-execute → reflexion → ★ Tree of Thoughts ★ │
  │  (aptkit is at ReAct)              (not exercised)        │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

**Axis: cost per answer.** ToT multiplies token cost by the branch factor — explore 3 paths, pay ~3x. aptkit's cost discipline runs the other way: `maxToolCalls` caps, a `usage-ledger` tracks spend, a local Gemma default makes the cheap path free. The seam between ToT and aptkit's philosophy is cost: ToT spends *more* to chase a better answer; aptkit spends *less* and hardens the single path.

## How it works

### Move 1 — the mental model

ToT runs a reasoning step several times to get divergent paths, scores each, and continues from the best — like a beam search where each node is a chunk of reasoning.

```
  Tree of Thoughts — branch, score, pick

           root question
          ┌──────┼──────┐
          ▼      ▼      ▼
        path A  path B  path C
          │      │      │
        score  score  score
          └──────┼──────┘
                 ▼
            best path wins  (cost ≈ branch_factor × baseline)
```

### Move 2 — why aptkit is right to skip it

**The cost math.** Each branch is a full reasoning trajectory. With aptkit's `maxToolCalls: 4` per agent, a branch factor of 3 would mean up to 12 tool calls per question — and against a local Gemma model that already needs the `minTopK` floor and retry nudges to stay on track, branching multiplies the *unreliability* too, not just the cost. You'd be scoring three mediocre paths instead of hardening one.

**Where the budget went instead.** aptkit spent its reliability budget on the single path:
- `minTopK` floor so the one search doesn't starve (`search-knowledge-base-tool.ts:51`)
- forced synthesis so the one trajectory always produces an answer (`run-agent-loop.ts:104`)
- the recovery turn so a parse failure on the one path gets one salvage attempt

That's the trade: harden one path cheaply rather than explore many paths expensively. For aptkit's tasks (grounded Q&A, evidence-gathering, scoring) a well-prompted single ReAct loop beats branching.

**When ToT would actually earn it.** Tasks with a verifiable scoring function and genuinely divergent solution paths — game-tree search, constraint puzzles, code with a test oracle. None of aptkit's capabilities look like that. Recommendation and diagnosis have no cheap "score this branch" oracle; the cost of branching wouldn't buy measurable quality.

### Move 3 — the principle

ToT is rarely worth it in production: the branching multiplies token cost by the branch factor and rarely beats a well-prompted ReAct loop on real tasks. Recognizing it and being able to say *why you didn't reach for it* is the senior answer — premature ToT is the same mistake as premature multi-agent.

## Primary diagram

```
  ToT cost vs aptkit's single-path hardening

  ToT:    root ─► 3 branches ─► score each ─► best   (≈3x cost, 3x noise)

  aptkit: root ─► ONE ReAct path ─► hardened with:
                  minTopK floor + forced synthesis + recovery turn
          (1x cost, the reliability spent on the one path)
```

## Elaborate

Tree of Thoughts came out of research on tasks where a model's first reasoning path is often wrong but a *scored* search over paths finds the right one (Game of 24, creative writing with an evaluator). The production reality: most business tasks lack a cheap, reliable branch-scorer, so ToT's branches get scored by the same model that generated them — compounding cost *and* bias. aptkit's tasks are firmly in the "harden one path" category.

## Interview defense

**Q: Did you consider tree-of-thoughts?**
Considered and rejected. ToT multiplies token cost by the branch factor, and against my local Gemma model it would multiply the unreliability too — I'd be scoring three shaky paths instead of hardening one. My tasks (grounded Q&A, evidence-gathering, scoring) have no cheap branch-scoring oracle, so branching wouldn't buy measurable quality. I spent the reliability budget on the single path instead: a top_k floor, forced synthesis, a recovery turn.

```
  ToT: 3 branches × cost × noise   vs   aptkit: 1 path, hardened
```
*Anchor: "recognize it, say why you didn't use it" — premature ToT = premature multi-agent.*

## See also

- `03-react.md` — the single path aptkit hardens instead
- `05-production-serving/01-cross-turn-caching.md` — aptkit's cost discipline
- `03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md` — the same "don't over-reach" judgment
