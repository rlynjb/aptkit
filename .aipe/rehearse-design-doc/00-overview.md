# Design Docs — AptKit

You're not writing these to teach yourself the code (that's `study-*`). You're writing them so a skeptical reviewer reads three pages, nods, and aligns behind a call you already made. The bottleneck at staff level isn't the diff — it's getting a room to agree on the diff *before* you cut it. These are the artifacts that do that.

Three decisions in this repo clear the bar. The rest don't, and saying which is which is half the skill.

## Which decisions warrant a doc

A design doc is expensive attention. Spend it only where the decision was **significant and non-obvious** — hard to reverse, a real alternative existed, the impact crosses package boundaries, and someone will ask "why this way?" Rank the candidates, write the top few, and skip everything that's a default nobody would question.

```
  Decision ranking — AptKit

  decision                  reverse?   real alt?   cross-cut?   "why?"   → doc?
  ────────────────────────  ────────   ─────────   ──────────   ──────   ──────
  emulated-tool-calling     medium     yes (3)     no (1 pkg)   YES      ✔ 01
  rag-from-contracts        HARD       yes (2)     YES (3 pkgs) YES      ✔ 02
  single-bundle-publishing  HARD       yes (2)     YES (build)  YES      ✔ 03
  ─────────────────────────────────────────────────────────────────────────
  ESM-only / NodeNext       easy       weak        yes          no       skip
  Node built-in test runner easy       yes         no           no       skip
  per-package tsc -b build  easy       weak        yes          no       skip
  capability = prompt+       —         —           yes          no       skip
    policy+loop+validator                                       (pattern, not a fork)
  cosine over an array       easy       yes         no           no       skip
    (InMemoryVectorStore)
```

Why the skips are skips, in one line each so a reviewer doesn't wonder if you missed them:

- **ESM-only / NodeNext** — a 2024 TypeScript default; reversing it is a tsconfig flag, and no real alternative was weighed. Convention, not a decision.
- **Node's built-in test runner over jest/vitest** — defensible, but cheap to reverse per-package and contained to test files. A preference, not a fork in the road.
- **`capability = prompt package + tool policy + loop config + validator`** — this is a *pattern* the repo repeats six times, not a single non-obvious choice. It's worth a study file, not an RFC; there was never a competing design on the table.
- **`InMemoryVectorStore` does a cosine scan over an array** — obvious for a dev/test default, and it sits *behind* the `VectorStore` contract that doc 02 is actually about. The interesting decision is the contract, not the toy implementation.

The three that made the cut are each a fork where a credible engineer would have gone the other way — and where this repo can point at the consequence of its choice in shipped code.

## The reusable RFC template

Every doc below uses the same nine-part spine — the canonical RFC shape. Copy this for the next decision you write up. It's ordered so a reviewer who reads top-to-bottom never has to scroll back up to find context.

```
  The 9-part RFC spine

  ┌─ 1. Title + one-line summary ──────────────────────────┐
  │     the decision in ONE sentence, at the top.          │
  │     a reader who stops here still knows what you did.   │
  └────────────────────────────┬───────────────────────────┘
  ┌─ 2. Context / problem ──────▼───────────────────────────┐
  │     what FORCED the decision — real repo constraints.   │
  └────────────────────────────┬───────────────────────────┘
  ┌─ 3. Goals & non-goals ──────▼───────────────────────────┐
  │     what it must do + what it WON'T (kills scope creep).│
  └────────────────────────────┬───────────────────────────┘
  ┌─ 4. The decision ───────────▼───────────────────────────┐
  │     the chosen design. MANDATORY diagram — shape first. │
  └────────────────────────────┬───────────────────────────┘
  ┌─ 5. Alternatives (2–3) ─────▼───────────────────────────┐
  │     each real option + why it LOST. "design it twice."  │
  └────────────────────────────┬───────────────────────────┘
  ┌─ 6. Tradeoffs accepted ─────▼───────────────────────────┐
  │     "we chose X, accepting Z." no apology.              │
  └────────────────────────────┬───────────────────────────┘
  ┌─ 7. Risks & mitigations ────▼───────────────────────────┐
  │     what breaks, what guards it.                        │
  └────────────────────────────┬───────────────────────────┘
  ┌─ 8. Rollout / migration ────▼───────────────────────────┐
  │     how it ships safely; what changes for callers/data. │
  └────────────────────────────┬───────────────────────────┘
  ┌─ 9. Open questions ─────────▼───────────────────────────┐
  │     what's still undecided. honesty = staff signal.     │
  └─────────────────────────────────────────────────────────┘
```

Two rules that make these land, both from the coach:

- **Lead with the decision, not the suspense.** Section 1 is the call in a sentence. A reviewer should be able to disagree with you from the title alone — that's what gets you the fast "yes" or the early "wait, why?".
- **A doc with no alternatives reads as undercooked.** Section 5 is "design it twice" written down. If you can't name two options you rejected and why, you haven't designed yet — you've defaulted, and a sharp reviewer will smell it.

## How to use these

```
  .aipe/rehearse-design-doc/
    00-overview.md                  ← you are here (ranking + template)
    01-emulated-tool-calling.md     ← Gemma has no native tools; we fake them
    02-rag-from-contracts.md        ← RAG depends on 2 interfaces, not a vendor
    03-single-bundle-publishing.md  ← ship 16 packages as ONE npm tarball
```

Read 02 first if you're being asked about architecture — it's the load-bearing call, and it's the one with the cleanest proof (two unrelated consumers ride the same two interfaces). Read 01 if the conversation is about local models and weak-model reliability. Read 03 if it's about packaging, release, or "why is the repo root private?". Each stands alone; none depends on the others.
