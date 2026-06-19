# Study — Software Design (AptKit)

A per-repo software-design study guide. It reads the AptKit monorepo through
the design primitives in John Ousterhout's *A Philosophy of Software Design*
(APOSD) — **deep modules, information hiding, complexity, layering,
readability** — and reports where the code honors each principle, where it
violates it, and the specific move to fix it.

This is not the book. It teaches each primitive in one paragraph and spends
its weight on findings about *your* files. For the full conceptual treatment,
read APOSD itself (Ousterhout, 2nd ed.) — it is short, and it is the source
every term here comes from.

---

## The through-line

```
  complexity is the enemy  ─────────►  deep modules are the weapon

  symptom            cause                   the fix
  ──────             ──────                  ──────
  change amplifies   knowledge leaks         hide the decision
                     across modules          behind one interface
  cognitive load     shallow modules         fold body into a
  spikes             (interface ≈ body)      narrow contract
  unknown-unknowns   special-case sprawl     define the case out
```

AptKit's whole reason for existing — extract reusable agent parts so they
ship as one npm bundle without app logic leaking in — *is* an information-
hiding argument at the package level. The repo is unusually deliberate about
one interface (`ModelProvider`) and unusually repetitive about another (the
five agent classes). Both are findings here.

---

## What's in this folder

```
  README.md                        ← you are here: map + through-line
  00-overview.md                   ← one-page orientation, depth ranking
  audit.md                         ← Pass 1: the 8 APOSD lenses, every lens
                                      checked, `not yet exercised` named honestly

  01-model-provider-deep-module.md ← Pass 2: the canonical deep module
  02-provider-decorator-stack.md   ← fallback + context-guard as wrappers
  03-rules-as-data-validation.md   ← structural-diff: many rule types, one walk
  04-capability-agent-template.md  ← the 5-agent duplication (the weak spot)
  05-bundle-as-public-surface.md   ← @rlynjb/aptkit-core re-export boundary
```

**Pass 1** (`audit.md`) is fixed: one section per design lens, same shape every
repo. **Pass 2** is the discovered patterns — named after design moves AptKit
actually makes. The file list itself is a finding: a deep module, a decorator
stack, a rules engine, a template that *should* be an abstraction but isn't,
and a public surface.

---

## Reading order

1. **`00-overview.md`** — the whole repo's design shape in one page, modules
   ranked by depth. Start here.
2. **`audit.md`** — the 8-lens walk. The capstone red-flags section at the end
   is the actionable index; if you read one thing, read that.
3. **`01`** then **`04`** — the best example (deep module) and the worst
   (agent duplication), back to back. The contrast is the lesson.
4. **`02`, `03`, `05`** — in any order.

---

## Cross-links

- **`.aipe/study-system-design/`** — same repo, higher altitude. Where this
  guide asks "is `runAgentLoop` a deep module?", system-design asks "where do
  the package boundaries sit and how does a request flow through them?" Rule
  of thumb: module/interface/complexity findings live here; service/
  architecture/flow findings live there.
- **`.aipe/study-ai-engineering/`** — the AI-specific reading of the same
  code: why the agent loop forces a synthesis turn, how structured generation
  retries, what the eval seam buys. This guide treats those as design objects
  (is the loop deep? does the validator leak?); the AI guide treats them as AI
  mechanics.
- **APOSD** (Ousterhout) — the source. Every red flag named here is defined
  there in ~15 pages. Read chapters 4 (deep modules), 5 (information hiding),
  and the red-flags appendix first.
