# Lost in the middle (position bias in long context)

**Industry names:** lost-in-the-middle, positional bias, primacy/recency in context · *Industry standard*

## Zoom out, then zoom in

Fitting content into the window (the previous file) is necessary but not
sufficient. *Where* in the window you put a fact changes how reliably the model
uses it. Models attend best to the very start and the very end of a long context
and worst to the middle — so a critical instruction buried in paragraph 12 of 30
can be effectively invisible even though it's technically "in context." AptKit
assembles its prompts deterministically and keeps them small, which sidesteps the
problem today rather than mitigating it.

```
  Zoom out — where position bias would bite

  ┌─ Prompt-assembly layer (prompts/* + schemaSummary) ───────────┐
  │  renderPromptTemplate: system + {schema} + {diagnosis} + …     │ ← we are here
  │  ★ ordering of content within the prompt = position risk ★     │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ assembled into one system string
  ┌─ Runtime layer ────────────────▼────────────────────────────────┐
  │  messages[] (tool results appended in arrival order)            │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ model.complete()
  ┌─ Model ────────────────────────▼────────────────────────────────┐
  │  attention curve: strong at edges, weak in the middle           │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: lost-in-the-middle is the empirical finding that a model's ability to use
a fact drops sharply when that fact sits in the *middle* of a long context, even
within the window's nominal limit. The question this file answers: does AptKit do
anything about it? Honest answer — *not directly*. There's no reranking, no
retrieval ordering, no "put the important thing last" logic. AptKit gets away with
it because its prompts are small enough that the middle isn't a graveyard yet. This
file teaches the foundation and marks the mitigation as not-yet-exercised.

## Structure pass

**Layers.** Two matter: the *prompt-assembly* layer (where content order is
decided — the system template and the rendered variables) and the *runtime* layer
(where tool results are appended in arrival order). Position bias is a property of
how these two order content before it reaches the model.

**Axis — guarantees / how reliably will the model use this token?** Trace it. A
token at the *start* of the prompt: high reliability (primacy). A token at the
*end*, just before the question: high reliability (recency). A token in the
*middle* of a long prompt: degraded — best-effort at best. So "in the context" is
not a uniform guarantee; reliability varies by position, and nothing in AptKit
flattens that curve.

```
  One question — "how reliably is this token used?"  (by position)

  ┌─ start of prompt ───┐  → HIGH (primacy)
  ┌─ middle of prompt ──┐  → DEGRADED (the failure zone)
  ┌─ end / near query ──┐  → HIGH (recency)

  same window, same tokens — position changes the guarantee
```

**Seams.** The seam where this *could* be controlled is prompt assembly —
`renderPromptTemplate` and `schemaSummary` decide what lands where. Today that seam
makes no position-aware decisions; it interpolates variables wherever the template
author placed them. The mitigation, when needed, would live exactly here: a
reordering step that pushes the highest-value content to the edges.

## How it works

You already know recency bias in a chat: you remember the last thing said and the
first thing said, and the middle blurs. Transformer attention over a long sequence
behaves similarly — strong at the ends, weak in the middle. The practical
consequence: *where* you place a fact is a design decision, not a cosmetic one.

### Move 1 — the mental model

```
  The attention curve over a long context

  reliability
     high │█                                           █
          │ █                                         █
          │  █                                       █
          │   ██                                   ██
      low │     ████████████████████████████████████
          └──────────────────────────────────────────► position
            start            MIDDLE             end
                         (the danger zone)

  a fact placed here ──┘  is technically present, practically ignored
```

The lesson in one line: the window is not uniform real estate. The edges are
prime; the middle is the cheap seats. Put what matters where the model looks.

### Move 2 — the mechanism and the mitigation it implies

**Why the middle fades.** Bridge from a long meeting where you recall the open and
the close but not minute 40 — attention over a long sequence concentrates at the
boundaries. As context grows, the absolute amount of "middle" grows, so the
fraction of content in the weak zone grows with it. Boundary condition: this is a
*long-context* phenomenon — at small prompt sizes there's barely any middle, so the
effect is negligible. That's precisely AptKit's situation.

```
  Pattern — middle grows with context length

  short prompt:   [start][end]                  ← almost no middle, low risk
  long prompt:    [start][······ middle ······][end]  ← big middle, high risk
                          ↑ value placed here is at risk
```

**The mitigation AptKit does NOT do.** Bridge from search-result ranking — the
standard fix is *ordering by importance toward the edges*: rerank retrieved chunks
so the most relevant land first and last, or restructure the prompt to put the
critical instruction at the very end (just before the question). AptKit has neither
a reranker nor any retrieval ordering — there's no retrieval at all (see
`../04-agents-and-tool-use/05-agent-memory.md`). Boundary condition: with no
retrieval and small prompts, there's nothing to rerank and little middle to lose
to — so the absence is *currently* harmless, not currently broken.

```
  Comparison — the standard mitigations vs AptKit

  STANDARD MITIGATION                AptKit TODAY
  ──────────────────────────────     ────────────────────────────────
  rerank chunks → best at edges      no retrieval, nothing to rerank
  critical instruction last          template order is author-chosen,
  (just before the question)          not position-optimized
  shorten context (less middle)      ✓ prompts ARE small (sidesteps it)
  ──────────────────────────────     ────────────────────────────────
  → not yet exercised in AptKit; foundation taught, mitigation deferred
```

**What AptKit does that helps by accident.** Bridge from keeping a function short —
the `schemaSummary` renderer injects workspace metadata into the prompt
*deterministically and compactly*. Because the schema summary is small (not a dump
of every event and field), the resulting prompt has little middle to lose content
in. Boundary condition: this is mitigation-by-smallness, not mitigation-by-design —
if a workspace's schema summary grew large, the middle would start to matter and
nothing would push the important parts to the edges.

```
  Layers-and-hops — deterministic, small prompt assembly

  ┌─ workspace ─┐ schemaSummary(workspace)  ┌─ renderPromptTemplate ─┐
  │  descriptor │ ─────────────────────────►│  {schema} interpolated │
  └─────────────┘  (compact, deterministic) └──────────┬─────────────┘
                                                        ▼ one system string
                                              small enough that the
                                              "middle" barely exists
```

### Move 2.5 — current state vs future state

This concept is *built-but-not-exercised* — there's nothing to migrate, only a
mitigation to add if and when prompts grow.

```
  Phase A (now)                      Phase B (if prompts grow large)
  ────────────────────────────       ────────────────────────────────
  small prompts, no reranking        a position-aware assembly step:
  middle is ~empty → no live issue   - rank prompt sections by importance
  schemaSummary is compact           - place critical bits at edges
  (mitigation = smallness)           - (with retrieval) rerank chunks
                                     cost: a reorder pass at the
                                     renderPromptTemplate seam
  what DOESN'T change: the prompt template authors, the agents,
  the tools — only the assembly order gains a ranking step
```

The takeaway: the fix is local. It slots into the prompt-assembly seam without
touching agents or tools. You add it when measurement says the middle is costing
you — not before.

### Move 3 — the principle

Position is a parameter you control, so spend it. The edges of the context are your
highest-attention real estate; put the instruction or fact you most need obeyed
where the model actually looks — at the start, and especially at the end just before
the question. The cheapest mitigation of all is the one AptKit relies on: keep the
prompt small, so there's no middle to get lost in. Reranking and edge-placement are
what you reach for *after* you've measured a long-context problem — premature
position-engineering on a small prompt is wasted effort.

## Primary diagram

The full picture: where content lands, where attention is strong, and the deferred
mitigation seam.

```
  Lost-in-the-middle — full picture

  PROMPT ASSEMBLY (the controllable seam)
  renderPromptTemplate: system [start] + {schema} + {diagnosis} + [task, end]
        │  (today: author-ordered, NOT importance-ordered)
        ▼
  ASSEMBLED CONTEXT mapped onto the attention curve
  ┌──────────────────────────────────────────────────────────────────┐
  │ [HIGH attention]  ····· [LOW attention: middle] ····· [HIGH]       │
  │  system top                  buried facts            task/question │
  └──────────────────────────────────────────────────────────────────┘
        │
        ▼ AptKit today: prompts small → middle ≈ empty → no live problem
  MITIGATION (not yet exercised):
    rerank to edges · critical-instruction-last · (with §03 retrieval) chunk ranking
```

## Implementation in codebase

**Use cases.** Every agent renders a system prompt by interpolating a compact
`schemaSummary` plus task variables (the diagnosis, the category checklist, the
intent) via `renderPromptTemplate`. Because the schema summary is deliberately
small and the prompts are short, no agent currently suffers measurable
middle-loss — the mitigation work is deferred, not done.

**Deterministic, position-naive assembly**, `packages/prompts/src/types.ts:24-32`:

```
  prompts/types.ts  (lines 24-32) — renderPromptTemplate

  export function renderPromptTemplate(template, variables) {
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
      const value = variables[name];
      return value === undefined ? match : value;        ← interpolate in place
    });
  }
       │
       └─ this is the assembly seam. It places each variable EXACTLY where
          the template author wrote {schema}, {diagnosis}, etc. — no
          importance ranking, no edge-placement. If a mitigation were
          added, it would wrap or precede this call.
```

The template order is author-controlled. In the recommendation prompt, for
instance, `{diagnosis}` sits mid-document and `{schema}` is placed last —
`packages/prompts/src/recommendation.ts:38-76`. That ordering is a human choice, not
a position-bias optimization; today it's fine because the whole prompt is short.

**Compact-by-design metadata**, the `schemaSummary` renderer:

```
  packages/agents/*/src/schema-summary.ts  (re-export)

  export { schemaSummary } from '@aptkit/context';
       │
       └─ schemaSummary produces a COMPACT workspace summary (horizon +
          available fields), not a full dump. Small output = small prompt
          = negligible middle. This is mitigation-by-smallness — accidental,
          not position-aware. Grow the summary and the middle starts to matter.
```

There is no reranker, no retrieval-ordering step, and no "put critical content
last" pass anywhere in the prompts or agents packages. The mitigation is genuinely
absent — and, given small prompts, currently harmless.

## Elaborate

"Lost in the Middle" is the title of Liu et al. (2023), which measured the U-shaped
accuracy curve directly: models retrieving a fact from a long context were most
accurate when the fact was first or last, and notably worse when it was in the
middle — sometimes worse than having no context at all. The finding reshaped RAG
practice: it's *why* retrieval pipelines rerank, and why "stuff everything in the
context" is a worse strategy than "retrieve a few relevant chunks and order them
well."

AptKit's honest position is the right one for its scale: the cheapest mitigation is
a short prompt, and it has that. Reranking and edge-placement earn their complexity
only once you have long contexts (typically from retrieval) where the middle is real
estate you're actively losing. Building position-engineering on a small,
hand-authored prompt would be premature optimization. The discipline is to *measure
first* — and AptKit hasn't reached the scale where the measurement would flag a
problem.

Adjacent concepts: the finite window this bias lives inside (`01-context-window.md`),
the retrieval layer that would produce long, rerank-worthy context (section 03 —
RAG), and prompt chaining as a way to keep each step's prompt short
(`03-prompt-chaining.md`).

## Project exercises

*Provenance: Phase 2 — Context and prompts (C2.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. Case B — the mitigation is not yet exercised;
these introduce it.*

### Exercise — measure the U-curve on an AptKit agent (Case B)

- **Exercise ID:** `[B2.3]` Phase 2, lost-in-the-middle concept
- **What to build:** An eval that inflates a system prompt with filler around a
  single load-bearing instruction, sweeps that instruction's position from start to
  middle to end, and measures whether the agent obeys it at each position.
- **Why it earns its place:** You can't justify a mitigation you haven't measured.
  Reproducing the U-curve on AptKit's own agent proves the effect is (or isn't) live
  at current prompt sizes — the evidence that gates the next exercise.
- **Files to touch:** `packages/evals/src/*` (a new positional eval),
  a fixture provider in `packages/providers/*`.
- **Done when:** The eval reports obedience rate by position and shows whether the
  middle degrades for the model under test.
- **Estimated effort:** `1–4hr`

### Exercise — importance-ordered prompt assembly (Case B)

- **Exercise ID:** `[B2.4]` Phase 2, position-bias mitigation
- **What to build:** A prompt-assembly helper that takes labelled sections with an
  importance weight and emits them edge-first (highest-importance at the start and
  just before the question, filler in the middle), wrapping `renderPromptTemplate`.
- **Why it earns its place:** This is the standard mitigation, slotted at the exact
  seam where it belongs. It turns "we keep prompts small and hope" into "we place
  what matters where the model looks" — and only after `[B2.3]` says it's needed.
- **Files to touch:** `packages/prompts/src/*` (assembly helper),
  `packages/agents/*/src/*-agent.ts` (adopt it), matching tests.
- **Done when:** Critical instructions render at the edges; the `[B2.3]` eval shows
  improved obedience for the previously-middle case.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: You put a critical instruction in a long prompt and the model ignores it.
Why?**
"Likely lost-in-the-middle. I'd sketch the attention curve:"

```
  reliability:  high █_____________________█ high
                start      MIDDLE (low)     end
  the instruction was in the middle — present but under-attended
```

"Models attend best to the start and end of long context and worst to the middle. A
critical instruction buried mid-prompt is technically in context but practically
ignored. The fix is to move it to an edge — usually last, right before the question
— or to shorten the prompt so there's no middle to lose it in."
*Anchor: the window isn't uniform; the edges are prime real estate.*

**Q: Does AptKit mitigate this?**
"Not directly — and I'd be honest about it. There's no reranker and no
retrieval-ordering; `renderPromptTemplate` (`prompts/types.ts:24`) places variables
wherever the template author wrote them. AptKit gets away with it because the
`schemaSummary` is compact and the prompts are short, so there's barely any middle.
That's mitigation-by-smallness, not by design. If prompts grew — say from retrieval
— I'd add an importance-ordered assembly step at that seam. I'd measure first."
*Anchor: small prompts sidestep it; reranking is for when the context gets long.*

## Validate

- **Reconstruct:** From memory, draw the U-shaped attention curve and mark where a
  buried fact lands. Check against the Move 1 diagram.
- **Explain:** Why is the absence of a reranker currently harmless in AptKit?
  (Prompts are short — compact `schemaSummary` + brief templates — so the middle is
  nearly empty; there's little content in the weak zone and no retrieved chunks to
  rerank. `schema-summary.ts` re-export of `@aptkit/context`.)
- **Apply:** A workspace's schema summary balloons to fill most of the prompt, with
  the task instruction in the middle. What's the predicted symptom, and where's the
  fix? (The model under-uses the buried instruction; fix at the
  `renderPromptTemplate` seam — `prompts/types.ts:24` — by moving the instruction to
  an edge or shortening the schema.)
- **Defend:** Why defer position-engineering instead of building it now? (No
  retrieval and small prompts mean no measurable middle-loss; building it would be
  premature optimization. Measure with `[B2.3]` first, then mitigate with `[B2.4]`.)

## See also

- [01-context-window.md](01-context-window.md) — the finite window this bias lives inside
- [03-prompt-chaining.md](03-prompt-chaining.md) — keeping each step's prompt short
- [../03-retrieval-and-rag/](../03-retrieval-and-rag/) — retrieval and reranking, where this mitigation usually lives
- [../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md) — why there's no retrieval to rerank today
