# Tree of Thoughts

**Industry term:** Tree of Thoughts (ToT) — branch the reasoning, score branches, pick the best. *Industry standard.*

## Zoom out, then zoom in

Explore multiple reasoning branches in parallel, score them, keep the best. It's covered here so you recognize it and can explain why you *didn't* use it — which is the more common (and more senior) answer.

```
  Zoom out — study material only; nothing in aptkit branches

  ┌─ Reasoning-pattern family ──────────────────────────────────┐
  │   ReAct (aptkit) · plan-and-execute · reflexion              │
  │   ★ tree-of-thoughts ★  ← rarely worth it in production      │ ← we are here
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: aptkit does not branch reasoning. Every loop follows a single path. ToT multiplies token cost by the branch factor and rarely beats a well-prompted ReAct loop on real tasks.

## The structure pass

**Layers.** A root question, a branching layer (candidate paths), a scoring layer, a selection.

**Axis: cost — token spend scales with branch factor × depth.** That's the axis that kills ToT in production.

**The seam.** The scoring step. A ToT is only as good as its branch evaluator; a bad scorer makes the branching pure waste.

## How it works

**Use case in aptkit:** none. The honest framing is recognition, not implementation.

### Move 1 — the mental model

It's a search over reasoning states — the same shape as the BFS you built in `Graph.ts`, except each node is a partial line of reasoning and the "edges" are the model expanding a thought. You explore several, score them, and walk down the best.

```
           root question
          ┌──────┼──────┐
          ▼      ▼      ▼
        path A  path B  path C
          │      │      │
        score  score  score
          └──────┼──────┘
                 ▼
            best path wins
```

### Move 2 — the walkthrough

**Why it's rarely worth it.** Each branch is a full reasoning chain. Three branches three levels deep is roughly 3³ reasoning expansions plus a scorer call per node. On most real tasks, that token multiplier doesn't buy enough accuracy over a single well-prompted ReAct loop to justify the cost or latency.

**Where it ever pays.** Genuinely combinatorial problems with a cheap, reliable scorer — puzzle solving, constraint search, game-tree-like tasks. None of aptkit's capabilities are that shape; they're retrieval-and-ground or evidence-and-propose, where a single path with good retrieval wins.

**What it would cost aptkit.** A branch manager, a scorer (another model call per node), and state forking across branches — a large addition for capabilities that don't have the combinatorial structure that makes ToT pay. It's the wrong tool here.

### Move 3 — the principle

ToT is search over reasoning states; its cost is the branch factor and its value depends entirely on a cheap reliable scorer. For retrieval-and-ground tasks like aptkit's, a single ReAct path with good retrieval beats it. The senior answer is usually "I considered it and didn't, because the problem isn't combinatorial."

## Primary diagram

```
  ToT cost vs aptkit's single-path ReAct

  ToT:   root ─┬─ A ─┬─ ... (branch^depth reasoning chains + a scorer per node)
               ├─ B ─┤
               └─ C ─┘   → token cost multiplies; rarely beats ReAct

  aptkit: root ─► single ReAct path ─► answer  (one chain, bounded)
```

## Elaborate

Tree of Thoughts (Yao et al., 2023) generalized chain-of-thought into a deliberate search with backtracking. It posts strong numbers on puzzle benchmarks (Game of 24, crosswords) and weak cost-efficiency on open-ended tasks. The takeaway for a working engineer: it's a benchmark-winning technique, not a default production pattern.

## Interview defense

**Q: Would Tree of Thoughts help any aptkit capability?**

No, and that's the useful answer. ToT pays off on combinatorial problems with a cheap reliable scorer. aptkit's capabilities are retrieval-and-ground or evidence-and-propose — single-path tasks where good retrieval beats branching. The branch factor would multiply cost for no measurable gain.

*Anchor: ToT is search over reasoning states — value depends on a cheap scorer and combinatorial structure, neither of which aptkit has.*

## See also

- [03-react.md](03-react.md) — the single-path baseline ToT branches.
- [02-agent-loop-skeleton.md](02-agent-loop-skeleton.md) — the kernel ToT would fork.
