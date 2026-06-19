# 02 — Self-Corrective RAG

## Grading what you retrieved before you trust it — and what AptKit does instead

---

## Zoom out

Plain agentic RAG (file 01) has a blind spot: it assumes every tool result is
worth using. The model queries, the result comes back, it gets stuffed into the
prompt, and the model carries on as if the data were good. But retrieved data is
not always relevant, not always sufficient, sometimes contradictory. Self-
corrective RAG is the family of techniques — CRAG, Self-RAG — that adds a
**grader**: after retrieval, something evaluates whether the retrieved evidence
is actually good enough, and if not, it triggers a re-query, a re-route, or an
abstention.

Here is the honest fact you need up front: **AptKit has no standalone relevance
grader.** There is no component that scores tool results and decides "this
retrieval was bad, query again." So this file does two things — it teaches the
pattern so you can speak to it, and it points at the *closest analog* AptKit
does have: the diagnostic agent's per-hypothesis `supported`/`reasoning`
evaluation, which grades whether gathered evidence supports each candidate cause.

```
  Where self-corrective RAG sits — and where AptKit stops short

  ┌─ Agentic retrieval (02) ──────────────────────────────────────────┐
  │                                                                    │
  │   Agentic RAG (01) ── query → eval → query → synthesize            │
  │        │                                                           │
  │        ├─ ★ Self-corrective RAG ★ ── grade the retrieval,          │
  │        │     re-query if bad        ◄── NOT a component in AptKit   │
  │        │                                                           │
  │        │     closest analog: diagnostic agent grades evidence      │
  │        │     per hypothesis (supported? reasoning?) — diagnosis    │
  │        │     confidence is derived from that grading               │
  │        │                                                           │
  │        └─ Retrieval routing (03) ── pick the tool                  │
  └────────────────────────────────────────────────────────────────────┘
```

You are studying a pattern AptKit *gestures at* but does not *implement as a
distinct stage*. Keep that distinction sharp — it is exactly the kind of thing an
interviewer will probe.

---

## Structure pass

Self-corrective RAG adds one node to the agentic-RAG loop: a **grader** between
"retrieve" and "use." The grader's verdict routes the flow — accept, re-query, or
abstain.

```
  The grader node (canonical CRAG/Self-RAG) — what AptKit lacks as a stage

  retrieve ──► [ GRADE ] ──relevant──► use in answer
                  │
                  ├─ ambiguous ──► re-query / broaden / re-route
                  └─ irrelevant ─► abstain / fall back

  AptKit's actual seam — grading is FUSED into synthesis, not a stage:

  retrieve×N ──► synthesize ──► per-hypothesis { supported, reasoning } ──► confidence
                                          │
                                          └─ low confidence = honest abstention,
                                             NOT a re-query trigger
```

The difference that matters: in canonical self-corrective RAG the grade
*controls the next retrieval* (a bad grade triggers another fetch). In AptKit the
"grade" is produced *during synthesis* and only controls the *reported
confidence* — it never loops back to retrieve more. The correction is "tell the
user how sure you are," not "go get better data."

---

## How it works

### Move 1 — Mental model: a grader is a guard clause on retrieved data

You already write guard clauses on fetched data in a frontend: the response comes
back, you check `if (!data || data.length === 0) return <Empty/>` before
rendering. A relevance grader is that guard clause, applied to retrieved context,
with the model as the predicate.

```
  PATTERN — grade-then-route (canonical self-corrective RAG)

  retrieved evidence
        │
        ▼
   grade(evidence, query)  ── model or heuristic scores relevance/sufficiency
        │
        ├── good ──────────► proceed to synthesis
        ├── partial ──────► augment: re-query, broaden, add a source
        └── bad ──────────► correct: discard, abstain, or fall back
```

In a self-correcting loop, the "partial/bad" branches *re-enter retrieval*. That
edge — grade pointing back at retrieve — is the whole pattern. AptKit's analog
keeps the grade but cuts that edge.

### Move 2 — Step by step

#### **Step 1 — Retrieve candidate evidence (same as agentic RAG)**

The loop gathers evidence by tool-calling, exactly as in file 01. Nothing new yet
— the difference begins after retrieval.

```
  Gather

  loop: model proposes tool → harness fetches → result back   (×≤ budget)
        │
        ▼
  evidence = accumulated tool results
```

```text
# identical to agentic RAG — gather evidence by tool-calling
evidence = runLoopAndCollectToolResults(query, tools)
```

#### **Step 2 — Grade the evidence against each claim**

This is the corrective step. For each thing you want to assert, ask: does the
gathered evidence support it? In canonical CRAG this is a relevance score on
retrieved chunks. In AptKit's analog it is a per-hypothesis judgment baked into
the diagnosis the model emits.

```
  Grade (AptKit analog — per hypothesis)

  for hypothesis in hypothesesConsidered:
      supported = does the evidence back this cause?     (boolean, model-asserted)
      reasoning = why / why not                          (string, model-asserted)
```

```text
# AptKit: the model emits this structure; it is the grade
hypothesesConsidered = [
  { hypothesis: "promo expired", supported: true,  reasoning: "conversions dropped at promo end" },
  { hypothesis: "tracking broke", supported: false, reasoning: "event volume steady" },
]
```

#### **Step 3 — Turn the grade into confidence (not a re-query)**

Here AptKit diverges from canonical self-corrective RAG. Instead of routing a bad
grade back into retrieval, it *derives a confidence level* from the grades:
all hypotheses tested with at least one supported → high; some supported → medium;
none → low. The correction surfaces as honesty about certainty.

```
  Grade → confidence (AptKit, diagnosisConfidence)

  supported = count(h.supported)
  tested    = count(h.reasoning is non-empty)
        │
        ├─ supported ≥ 1 AND tested == all  ──► "high"
        ├─ supported ≥ 1                     ──► "medium"
        └─ else                              ──► "low"
```

```text
if (supported >= 1 && tested === hypotheses.length) return 'high'
if (supported >= 1) return 'medium'
return 'low'
```

#### **Step 4 — Demote on retrieval failure (the one true correction)**

The closest AptKit gets to "the retrieval was bad, distrust it": if *any* tool
call errored during the loop, a high confidence is demoted to medium. The quality
of retrieval directly downgrades the reported certainty — a corrective signal,
even if it never triggers a re-query.

```
  Correct on bad retrieval

  hadErrors = any tool call errored?
        │
        ▼
  confidence == "high" AND hadErrors ──► "medium"   # distrust evidence built on failed fetches
```

```text
const hadErrors = toolCalls.some((call) => call.error)
return { ...diagnosis, confidence: confidence === 'high' && hadErrors ? 'medium' : confidence }
```

### Move 3 — The principle

A retrieval system that never grades its own evidence will state a wrong answer
with the same confidence as a right one — that is the failure mode self-
corrective RAG exists to kill. The general principle: **separate "what the
evidence says" from "how much you should trust it," and let the trust signal be
derived from the evidence, not asserted independently.** The strongest form loops
the trust signal back into retrieval — a low grade buys another fetch. A weaker
but still honest form, which is what AptKit has, lets the trust signal flow only
forward, into a confidence label and an abstention path, so a thin investigation
says "low confidence" instead of bluffing. The genuinely missing piece is the
backward edge: AptKit grades, but the grade never spends another tool call to fix
a weak retrieval. Naming that gap precisely is more valuable than pretending the
component exists.

---

## Primary diagram

The canonical self-corrective loop on top, AptKit's forward-only analog on the
bottom, drawn so the missing backward edge is unmistakable.

```
  Self-corrective RAG: canonical vs AptKit

  CANONICAL (CRAG / Self-RAG)
  ───────────────────────────
  query ─► retrieve ─► GRADE ─┬─ good ───────► synthesize ─► answer
                              │
                              ├─ partial ─┐
                              └─ bad ─────┤
                                          ▼
                                  re-query / re-route  ──┐
                                          ▲              │
                                          └──────────────┘   ← backward edge: grade buys a fetch

  APTKIT (diagnostic agent — closest analog)
  ──────────────────────────────────────────
  anomaly ─► retrieve×≤6 ─► synthesize diagnosis
                                 │
                                 ▼
                      hypothesesConsidered[ {supported, reasoning} ]   ← grade, fused into output
                                 │
                                 ▼
                      diagnosisConfidence()  ──► high / medium / low
                                 │
                                 ├─ hadErrors? high→medium                ← the only correction
                                 │
                                 ▼
                            confidence label        ✗ no backward edge to retrieval
```

The top loop corrects by fetching again. The bottom one corrects by labeling
certainty. Same goal — do not trust bad evidence — different reach.

---

## Implementation in the codebase

There is no grader file to point at, because there is no grader stage. The analog
lives entirely in the diagnostic agent's confidence derivation.

### Use case — Diagnosis confidence derived from evidence grading

The diagnostic agent asks the model to emit, per hypothesis, whether the gathered
evidence supports it. A pure function then grades the whole investigation into a
confidence level.

```text
packages/agents/diagnostic-investigation/src/diagnostic-agent.ts
```

```ts
// :89  derive confidence from the per-hypothesis grades — the analog to a relevance grader
export function diagnosisConfidence(diagnosis: Diagnosis): 'high' | 'medium' | 'low' {
  if (diagnosis.confidence) return diagnosis.confidence;          // :90  model-stated wins
  const hypotheses = diagnosis.hypothesesConsidered ?? [];        // :91  the graded items
  if (hypotheses.length === 0) return 'low';                      // :92  nothing tested → low
  const supported = hypotheses.filter((item) => item.supported).length;          // :93
  const tested = hypotheses.filter((item) => item.reasoning.trim().length > 0).length;  // :94
  if (supported >= 1 && tested === hypotheses.length) return 'high';   // :95  all tested, ≥1 holds
  if (supported >= 1) return 'medium';                                 // :96  partial
  return 'low';                                                        // :97  nothing supported
}
```

- `:89` — this *is* AptKit's self-correction, such as it is. It reads the grades
  the model emitted and turns them into a trust level.
- `:93` — `supported` counts hypotheses the evidence backs. This is the relevance
  judgment, expressed as a boolean per claim instead of a score per chunk.
- `:94` — `tested` counts hypotheses that got actual reasoning. An untested
  hypothesis is an un-graded one; it caps the confidence.
- `:95-97` — the grade-to-confidence mapping. Note what is absent: no branch here
  re-enters retrieval. A `low` return does not buy another tool call.

```ts
// :84  the one corrective edge: demote confidence if retrieval itself failed
const confidence = diagnosisConfidence(diagnosis);
const hadErrors = toolCalls.some((call) => call.error);                    // :84
return { ...diagnosis, confidence: confidence === 'high' && hadErrors ? 'medium' : confidence };  // :85
```

- `:84` — `hadErrors` inspects the retrieval log for failures. Evidence built on a
  failed fetch should not be called high-confidence.
- `:85` — the demotion. This is the closest AptKit comes to "the retrieval was
  bad, so distrust the conclusion" — but it adjusts the *label*, never re-runs the
  *retrieval*.

```ts
// :40  the abstention path — what "bad retrieval" falls back to
const FALLBACK_DIAGNOSIS: Diagnosis = {
  conclusion: 'Insufficient data to determine a cause for this change.',
  evidence: [],
  hypothesesConsidered: [],
  confidence: 'low',
};
```

- `:40-45` — when the loop produces nothing parseable, the agent returns this
  honest abstention (`:82` `parsed ?? FALLBACK_DIAGNOSIS`). In canonical CRAG,
  abstention is one of the grader's three verdicts; here it is the default when
  everything else fails.

---

## Elaborate

- **The grade is self-reported, not independent.** A true CRAG grader is a
  *separate* model call (or a trained scorer) that judges retrieved chunks the
  generator did not write. AptKit's `supported` flags are emitted by the *same*
  model that ran the investigation — there is no second opinion. That is weaker:
  a confidently wrong model grades its own wrong evidence as supported. Say this
  plainly in an interview; it is a real limitation.
- **No re-query edge is a deliberate cost trade, not just a gap.** Adding a
  backward edge means more tool calls and more model round-trips per run. AptKit's
  budgets (`maxToolCalls: 6`) already cap retrieval; a self-correcting re-query
  loop would fight that budget. The forward-only design keeps cost bounded at the
  price of weaker correction.
- **`hadErrors` is the honest core.** Of everything in this file, the line that
  most earns the name "self-corrective" is the high→medium demotion on tool
  errors. It is small, but it is a real "I retrieved badly, so trust me less"
  signal wired from the retrieval log to the output.
- **Where you would add a real grader.** If you were asked to *build* CRAG into
  AptKit, the seam is obvious: after the synthesis turn, a separate grader call
  reads `toolCalls` + `diagnosis`, scores sufficiency, and — if low and budget
  remains — re-enters `runAgentLoop` with a sharpened prompt. The loop and the
  evidence log are already there; only the backward edge is missing.

---

## Interview defense

**Q: "Does your retrieval correct itself if it pulls irrelevant data?"**

> Partially, and I want to be precise about the boundary. There is no standalone
> relevance grader and no re-query-on-bad-grade loop — that canonical
> self-corrective RAG stage is not built. What exists is a forward-only analog in
> the diagnostic agent: the model emits, per hypothesis, whether the gathered
> evidence supports it, and a pure function derives a confidence level from those
> flags. If any tool call errored during retrieval, a high confidence is demoted
> to medium. So the system *grades* its evidence and reports honest confidence —
> including a low-confidence abstention — but it never spends another tool call to
> fix a weak retrieval. The backward edge from grade to retrieval is the missing
> piece.

```
  retrieve → synthesize → {supported, reasoning} per hypothesis → confidence
                                                                      │
                                          hadErrors? high→medium ─────┘
                                          (no edge back to retrieve)
```

**Anchor:** "It is the difference between a guard clause that renders an empty
state versus one that re-fetches. AptKit renders the empty state — it says 'low
confidence, insufficient data' — but it doesn't re-fetch. A full CRAG would
re-fetch. I know exactly where I'd wire that edge, but it isn't there today."

---

## Validate

1. **Spot it** — There is no grader stage. Confirm by absence: search the agents
   and runtime for any post-retrieval scoring call that gates re-query — you will
   find none. The only evidence-grading logic is `diagnosisConfidence` at
   `packages/agents/diagnostic-investigation/src/diagnostic-agent.ts:89`.

2. **Trace it** — Follow a grade to a label. `hypothesesConsidered` carries
   `supported`/`reasoning` (`:91-94`), `diagnosisConfidence` maps them to
   high/medium/low (`:95-97`), and `investigate` applies the error demotion
   (`:84-85`). That is the full corrective path.

3. **Bound it** — Confirm the correction never re-retrieves. In `:95-97` no
   branch calls a tool or re-enters `runAgentLoop`. The abstention bound is
   `FALLBACK_DIAGNOSIS` (`:40`), returned at `:82`. Retrieval spend is still
   capped by `maxToolCalls: 6` (`:74`) regardless of grade.

4. **Break it** — Reason about the weakness. The grade is self-reported by the
   same model (`:91`), so a confidently wrong investigation grades its own bad
   evidence as `supported` and earns `high` — then only `hadErrors` (`:84`) can
   save it, and only if a tool actually errored. Verify there is no independent
   check that would catch a clean-but-wrong retrieval.

---

## See also

- `01-agentic-rag.md` — the retrieval loop this would correct.
- `03-retrieval-routing.md` — choosing the source; a different correction axis.
- `.aipe/study-ai-engineering/03-retrieval-and-rag/` — CRAG and Self-RAG mechanics
  in their canonical, vector-retrieval form.
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — where a re-query edge
  would attach.
- `../agent-patterns-in-this-codebase.md` — the honest patterns inventory.
