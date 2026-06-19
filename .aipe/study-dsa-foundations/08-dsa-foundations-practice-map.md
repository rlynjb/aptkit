# 08 — DSA Foundations Practice Map

**Industry name(s):** Ranked learning plan / gap analysis. Type label: Project-specific synthesis.

## Zoom out, then zoom in

This is the audit's verdict turned into a plan. You've read what AptKit exercises (maps, sets, discriminated unions, linear scans, round-robin, comparator sorts) and what it doesn't (trees, heaps, graphs, binary search, DP). This file ranks what to *practice* — and the ranking is deliberately inverted from a textbook. Sharpen the exercised concepts first, because those are the ones you can defend with *this* repo's code in an interview. Keep the missing foundations warm second, leaning on your `reincodes` work, because AptKit gives you nowhere to anchor them.

```
  Zoom out — the practice map's two tiers

  ┌─ TIER 1: exercised in AptKit (defend with this repo) ─┐
  │  hash map dispatch · set membership/least-privilege   │
  │  bounded JSON scan · comparator-sort top-k            │
  │  round-robin scheduling · cost-as-token-budget        │
  └───────────────────────────┬───────────────────────────┘
                              │ then
  ┌─ TIER 2: not yet in AptKit (defend with reincodes) ───┐
  │  heap/PQ · binary search · graph BFS/DFS/topo         │
  │  balanced tree/index · trie · backtracking · DP       │
  └────────────────────────────────────────────────────────┘
```

Zoom in: Tier 1 is where you have a *live* code anchor — you can pull up `tool-registry.ts:50` and walk the `Map` dispatch. Tier 2 is where the anchor is `reincodes`, and the AptKit angle is "here's the trigger that would bring it into this repo." Both tiers matter for a senior loop; the ordering is about *which story you can tell with the repo in front of you.*

## Structure pass

**Axis — trace "interview defensibility *from this repo*":** for each concept, can you point at AptKit code, or only at `reincodes`?

```
  One axis — "can I defend it with AptKit code?" — ranked

  hash map dispatch       YES  tool-registry.ts:50      ← strongest
  set membership          YES  tool-policy.ts:15, coverage:42
  bounded JSON scan       YES  json-output.ts:7
  comparator-sort top-k   YES  monitoring-agent.ts:87
  round-robin             YES  content-workflow.ts:148
  token cost model        YES  run-agent-loop.ts:101, ledger:25
  ──────────────────────────────────────────────────────────
  heap / PQ               NO   reincodes PriorityQueue.ts
  binary search           NO   (none — practice cold)
  graph BFS/DFS/topo      NO   reincodes Graph.ts / PG.ts
  balanced tree           NO   reincodes BinarySearchTree.ts
  trie / backtracking / DP NO  (thin/none — practice cold)
```

**Seam.** The line between Tier 1 and Tier 2 is exactly the "can I open a file in this repo" boundary. Above it, the interview story is "here's how I used it" — concrete, lived, strong. Below it, the story is "here's how I built it elsewhere, and here's when this repo would need it" — still good, but a different proof. Knowing which side a concept is on tells you how to rehearse it.

## How it works

### Move 1 — the mental model

You know the spaced-repetition idea from `dryrun` — practice the things you'll be tested on, weighted by how shaky they are. Same shape here, with a twist: weight also by *whether you have a repo anchor*. A concept you used in AptKit *and* feel shaky on is top priority. A concept you built in `reincodes` and feel solid on is maintenance, not study.

```
  The kernel — priority = exercised? × shaky?

           shaky          solid
        ┌──────────────┬──────────────┐
  in    │ STUDY FIRST  │ rehearse the │  ← Tier 1, your strongest
  aptkit│ (defend w/   │ AptKit story │     interview material
        │  this repo)  │              │
        ├──────────────┼──────────────┤
  not in│ STUDY COLD   │ keep warm    │  ← Tier 2, lean on reincodes
  aptkit│ (no anchor   │ (reincodes   │
        │  anywhere)   │  anchor)     │
        └──────────────┴──────────────┘
```

### Move 2 — the ranked plan, tier by tier

**Tier 1 — exercised, defend with AptKit (rehearse these for the loop first).** These are your strongest interview material because the anchor is live in this repo. The work here is *rehearsal*, not learning: be able to open the file and walk it.

```
  Tier 1 — ranked by how load-bearing in AptKit

  1. hash map dispatch        tool-registry.ts:34,50
     story: O(1) tool dispatch, throw-on-miss recovery
  2. set membership / policy  tool-policy.ts:15, coverage-gate.ts:42,
                              detection-scorer.ts:64
     story: least-privilege gate + matched/missed/unexpected split
  3. token-and-turn cost      run-agent-loop.ts:101, usage-ledger.ts:25
     story: budget the billed round-trip, not the asymptotics
  4. comparator-sort top-k    monitoring-agent.ts:87
     story: rank-table sort + slice; why not a heap
  5. round-robin scheduling   content-generation-workflow.ts:148
     story: modulo fairness; guard i % 0
  6. bounded JSON scan        json-output.ts:7
     story: locate vs validate; delegate to JSON.parse
```

The rehearsal target for each: a 60-second walk that names the structure, the file, the load-bearing line, and the boundary condition. Concept `1` and `2` are the two to nail cold — they're the repo's substrate, and "walk me through tool dispatch / the allowlist" is the most likely DSA-flavored question this codebase invites.

**Tier 2 — not yet exercised, defend with `reincodes` (keep warm second).** No AptKit anchor, so the story is "built it elsewhere + here's the trigger." Ranked by how likely AptKit is to actually grow it (which is also how natural the "when it'd appear here" story is).

```
  Tier 2 — ranked by likelihood of appearing in AptKit

  1. graph BFS/DFS/topo sort  trigger: capability composition into a
     reincodes: Graph.ts, PG.ts          dependency DAG (see 05)
     → MOST likely future graph; strong reincodes anchor
  2. heap / priority queue    trigger: bounded-concurrency scheduler
     reincodes: PriorityQueue.ts          or top-k k≪n large n (see 03,06)
  3. balanced tree / B-tree   trigger: persistent range-queried replay
     reincodes: BinarySearchTree.ts       store → really a DB index (see 04)
  4. binary search            trigger: large sorted index searched by key
     reincodes: (none) — practice cold    (see 06)
  5. dynamic programming      trigger: deterministic optimization pulled
     reincodes: (thin) — practice cold    out of the model, e.g. edit distance
  6. backtracking             trigger: constraint search coded instead of
     reincodes: PG.ts (state-space)        delegated to the model (see 07)
  7. trie                     trigger: prefix routing over many tool names
     reincodes: (none) — practice cold     (see 04) — least likely
```

The two to *learn* (not just rehearse) because you have no anchor anywhere: **binary search** and **dynamic programming beyond memoized recursion**. Your `me.md` profile flags exactly these as the thin spots. They're also the two most common interview filters that AptKit won't help you practice — so they need cold, deliberate reps from a problem set, not from this repo.

### Move 3 — the principle

Practice weighted by *defensibility from the artifact in front of you*, then by *gap*. The repo you're interviewing about decides which DSA stories are strongest — sharpen those first because they're concrete and lived. The textbook gaps still need closing, but they're a separate, cold track. Don't let the absence of trees and heaps in AptKit fool you into thinking they don't matter for the loop — they do; they just need a different anchor (`reincodes`) and a different study mode (problem-set reps, not code-walks).

## Primary diagram

The whole practice map in one frame.

```
  AptKit DSA practice map — what to do, in order

  ┌─ DO FIRST: rehearse Tier 1 (AptKit anchors) ─────────┐
  │  map dispatch → set policy → cost model →             │
  │  sort top-k → round-robin → JSON scan                 │
  │  goal: 60-sec walk each, file + load-bearing line     │
  │  nail #1 (dispatch) and #2 (allowlist) cold           │
  └───────────────────────────┬───────────────────────────┘
                              ▼
  ┌─ DO SECOND: keep Tier 2 warm (reincodes anchors) ────┐
  │  graph → heap → balanced tree (trigger stories)       │
  │  goal: "built it in reincodes + here's the AptKit     │
  │         trigger" for each                             │
  └───────────────────────────┬───────────────────────────┘
                              ▼
  ┌─ DO COLD: learn the no-anchor gaps ──────────────────┐
  │  binary search · DP beyond memoization                │
  │  goal: problem-set reps; AptKit can't help here       │
  └────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** This file isn't a pattern in the code — it's the synthesis of the audit. Its "implementation" is the cross-reference map: every Tier 1 concept points at a real file:line you can open and rehearse.

The Tier 1 anchor map (open these to rehearse):

```
  concept              file:line                              the line to know
  ──────────────────────────────────────────────────────────────────────────
  map dispatch         tool-registry.ts:34,50,57   handlers.get + throw on miss
  set policy           tool-policy.ts:15            new Set(allowedTools)
  set coverage         coverage-gate.ts:42          requires.every(has)
  set scoring          detection-scorer.ts:64,80    matched/missed/unexpected
  cost: turn budget    run-agent-loop.ts:101,102    budgetSpent / forceFinal
  cost: ledger         usage-ledger.ts:25,50        reduce → tokens → USD
  sort top-k           monitoring-agent.ts:35,87    severityRank + sort + slice
  round-robin          content-generation-workflow.ts:148  i % sections, i % angles
  JSON scan            json-output.ts:7,17          fence → first-open/last-close
  tree walk            structural-diff.ts:53        getPath dotted descent
  tree recursion       structural-diff.ts:185       collectText flatten
       │
       └─ each row is a 60-second interview answer waiting to be rehearsed.
          the file:line IS the anchor — "let me show you" beats "I know that."
```

## Elaborate

The reason this plan inverts the textbook order (exercised-first, not foundations-first) is that you're not learning DSA from zero — `me.md` and `reincodes` make clear you've already built graphs, heaps, BSTs, sorts, and state-space search from scratch. The risk for you isn't *not knowing* the foundations; it's walking into an interview about AptKit and not having rehearsed the *applied* stories this specific repo gives you. The applied stories are the differentiator — plenty of candidates can implement a heap; fewer can explain why a kit deliberately *doesn't* use one (concept #4's "why not a heap" answer is exactly that signal).

The two cold gaps (binary search, DP beyond memoization) are worth naming bluntly: they're common interview filters, AptKit won't exercise them, and `reincodes` is thin on them. That's a real gap, not a framing — close it with deliberate problem-set reps in parallel with the IK curriculum, which already covers them. Everything else is rehearsal of things you've built.

For the human-layer rehearsal of these into spoken interview answers, see `rehearse-interview-defense`. For where the applied AI stories (agent loop, evals, providers) live as *AI engineering* rather than DSA, see `study-ai-engineering`.

## Interview defense

**Q: "This codebase doesn't use trees, heaps, or graphs. Does that mean you don't know them?"**

No — it means the codebase's data is small and flat, so those structures would be over-engineering here, and recognizing that is itself the senior signal. I've built them from scratch in a separate repo — graph BFS/DFS, a binary heap, a priority queue backing Dijkstra, a BST with all traversals. In AptKit I can point at exactly where each *would* appear: a heap if a bounded-concurrency scheduler arrives, a graph if capabilities compose into a dependency DAG. Knowing when *not* to reach for a structure is as load-bearing as knowing how to build it.

```
  built elsewhere (reincodes) + here's the AptKit trigger
  → "I know it AND I know when it's premature"
```

Anchor: *the absence is a correct sizing decision, and I can name the trigger that would flip it — that's the senior read, not a gap.*

**Q: "What's the strongest DSA story you can tell about this repo?"**

The tool registry: a `Map<name, handler>` giving O(1) dispatch, with an explicit throw on a missing key so a hallucinated tool name becomes a recoverable error instead of a silent `undefined`. Paired with the policy `Set` that filters the catalog to a least-privilege allowlist before the model ever sees it. Two structures, one hot path, and the load-bearing details are the throw-on-miss and the set-as-security-boundary.

```
  Map.get O(1) + throw-on-miss   |   Set.has least-privilege gate
  tool-registry.ts:50            |   tool-policy.ts:15
```

Anchor: *map dispatch with throw-on-miss recovery, plus the set allowlist as the trust boundary — the repo's substrate in two structures.*

## Validate

**Reconstruct.** From memory, list the six Tier 1 concepts and one file:line anchor for each. Then list the seven Tier 2 concepts and which have a `reincodes` anchor vs which are cold.

**Explain.** Why does this plan rehearse exercised concepts *before* studying the missing foundations, when a textbook would teach foundations first? (Answer: you already know the foundations from `reincodes`; the gap is rehearsing the *applied* stories that only this repo gives you, which are the interview differentiator.)

**Apply to a scenario.** You have one week before an interview about AptKit. Allocate your DSA study time across the three tiers. (Answer: bulk on Tier 1 rehearsal — 60-second code-walks for the six concepts, nailing dispatch and allowlist cold; a smaller slice on Tier 2 trigger-stories (graph/heap most likely to come up); a separate cold track on binary search + DP problem-set reps since AptKit can't anchor them.)

**Defend the decision.** A peer says you should focus all DSA prep on the hard topics (graphs, DP) since "those are what FAANG asks." Defend spending time on the AptKit applied stories instead. (Answer: the loop will ask both *algorithm implementation* and *applied judgment*. You're already strong on implementation via `reincodes`; the unrehearsed risk is the applied half — "walk me through your tool dispatch / why no heap here." Those stories are concrete, lived, and unique to you, and they're the ones a generic problem-set won't prepare. Balance, weighted toward the gap that's actually yours.)

## See also

- `00-overview.md` — the ranked findings and `not yet exercised` list this plan operationalizes.
- `01` through `07` — each Tier 1 and Tier 2 concept's full walk with code anchors and triggers.
- `rehearse-interview-defense` (neighboring guide) — turning these into spoken, pressure-tested answers.
- `study-ai-engineering` (neighboring guide) — the same code as *AI* stories (agent loop, evals, providers).
