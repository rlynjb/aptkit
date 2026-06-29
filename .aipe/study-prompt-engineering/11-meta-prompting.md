# 11 — Meta-prompting

**Industry name:** meta-prompting / prompt generation — *Industry standard*

## Zoom out, then zoom in

Meta-prompting is using an LLM to write or improve the prompts for *another* LLM
call. It earns its keep on the initial drafting of a complex prompt — staring at a
blank prompt is slow, and a model will give you a structured first draft in
seconds. Where it doesn't earn its keep: small tweaks and prompts under high
iteration pressure, where a human edit is faster than a round-trip. The risk I
watch for: prompts that read like *LLM output* — vague, padded, hedge-laden —
instead of like engineering specs. In aptkit there's a building block for
templated prompt assembly, but **no LLM-writes-prompts pipeline is wired** — that
part is `not yet exercised`.

```
  Zoom out — prompt-building machinery vs meta-prompting

  ┌─ Building blocks that exist ──────────────────────────────┐
  │  renderPromptTemplate({var})  — composes a prompt string   │ ← we are here
  │  injectProfile()  — splices me.md INTO a system template   │
  │  buildRubricJudgeSystemPrompt() — assembles a judge prompt  │
  │     from a RubricDefinition (data → prompt)                 │
  └───────────────────────────┬────────────────────────────────┘
  ┌─ True meta-prompting (NOT in repo) ─▼──────────────────────┐
  │  human writes goal → LLM drafts prompt → human reviews →    │
  │  prompt enters the codebase as a PromptPackage              │  (not yet exercised)
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the repo's prompts are *programmatically assembled* (data structures
rendered into prompt strings) but *human-authored*. `buildRubricJudgeSystemPrompt`
(`rubric-judge.ts:107`) is the closest thing — it turns a structured
`RubricDefinition` into a prompt — which is meta-*construction* but not
LLM-driven meta-*generation*.

## The structure pass

**Layers:** the goal (what the prompt should do) → the draft (who writes it:
human or LLM) → the codebase prompt (the reviewed artifact).

**Axis — who authors the prompt text?** This is the axis that separates what
exists from what doesn't:

```
  Axis: "who writes the prompt string?"

  ┌─ Programmatic assembly (SHIPPED) ─┐  seam  ┌─ LLM generation (NOT shipped) ─┐
  │ data → prompt via code            │ ══╪══► │ goal → LLM drafts prompt        │
  │ rubric-judge: RubricDefinition    │ flips  │ → human reviews → codebase      │
  │   → system prompt                 │        │ (meta-prompting proper)         │
  │ injectProfile: profile → template │        │   not yet exercised             │
  └───────────────────────────────────┘        └──────────────────────────────────┘
```

**Seam:** the authoring boundary. On the shipped side, *code* assembles prompts
from structured data — deterministic, reviewable, no model in the loop. On the
unshipped side, a *model* would draft the prompt. **Why the distinction matters:**
programmatic assembly is safe and testable (the same `RubricDefinition` always
yields the same prompt); LLM generation needs a human-review gate or you ship
prompts that read like LLM output.

## How it works

### Move 1 — the mental model

You already use code generators — a scaffolding CLI writes boilerplate you then
edit, a schema generates types. Meta-prompting is a code generator where the
generator is an LLM and the artifact is a prompt. The non-negotiable, same as any
generated code: a human reviews it before it enters the repo.

```
  Pattern — meta-prompting workflow (the proper form)

  human: writes the GOAL ("a prompt that classifies support tickets")
        │
        ▼
  LLM: drafts a candidate prompt
        │
        ▼
  human: REVIEWS + edits (this gate is mandatory)
        │
        ▼
  codebase: prompt enters as a versioned PromptPackage (concept 03)
```

### Move 2 — walking what exists

**Programmatic prompt assembly (the shipped cousin).**
`buildRubricJudgeSystemPrompt` (`rubric-judge.ts:107`) is a pure function:
`RubricDefinition` in, system-prompt string out. It renders dimensions, scales,
verdicts, checks, and calibration examples into a structured prompt
deterministically:

```
  Inline annotation — rubric-judge.ts:107 prompt-from-data

  const dimensions = rubric.dimensions.map(d => `${d.id} ${d.label}: ...`);  ← data → text
  const verdicts   = rubric.verdicts.map(r => `- ${r.verdict}: ...`);
  const outputShape = { dimensions: ..., verdict: ..., fix: '', reasoning: '' };
  return [ `You are a rubric judge for: ${rubric.title}.`, ...,
           'Use exactly this shape:', JSON.stringify(outputShape) ].join('\n');
  // → one rubric definition → one deterministic prompt. No LLM authored this.
```

This is meta-prompting's safe half: prompts built *from structure*, so changing a
rubric changes its prompt without hand-editing the string. **What breaks without
it:** every new rubric needs a hand-written prompt, and the prompts drift apart.

**Profile injection as templated composition.** `injectProfile`
(`context/src/profile-injector.ts:25`) splices a profile document (me.md) into a
system template before rendering (`rag-query-agent.ts:56`). It's pure
string-in/string-out and runs *before* `renderPromptTemplate` so placeholders
survive (`:30` comment). This is prompt *composition* — assembling a final prompt
from parts — which is the mechanical substrate meta-prompting builds on.

**What's NOT here.** No tool, script, or slash command in this repo asks an LLM to
*write* a prompt that then becomes a `PromptPackage`. The prompts in
`packages/prompts/src/*.ts` are hand-authored. So the full meta-prompting loop
(goal → LLM draft → review → codebase) is `not yet exercised`.

### Move 3 — the principle

**Meta-prompting is a generator pattern, and like any generator its output must
pass a human review gate before it's trusted.** It's a drafting accelerant, not
an authoring replacement — it shines on cold-start complex prompts and wastes
time on small edits. The repo's shipped half (prompts assembled from structured
data) is the deterministic, testable foundation; the LLM-driven half is a roadmap
item with one hard rule attached: review, or you ship prompts that read like an
LLM wrote them.

## Primary diagram

```
  Meta-prompting in aptkit — shipped vs roadmap

  SHIPPED: programmatic assembly (code writes prompts from data)
  ┌────────────────────────────────────────────────────────────┐
  │ RubricDefinition ──buildRubricJudgeSystemPrompt──► prompt   │
  │ profile (me.md) ──injectProfile──► template ──render──► sys │
  │   deterministic · testable · no model in the loop           │
  └────────────────────────────────────────────────────────────┘

  ROADMAP: meta-prompting proper (LLM writes prompts)   [not yet exercised]
  ┌────────────────────────────────────────────────────────────┐
  │ goal → LLM draft → HUMAN REVIEW (gate) → PromptPackage      │
  │   risk: prompts that read like LLM output, not specs        │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Meta-prompting spans a spectrum: at the deterministic end, templating systems
assemble prompts from structured config (this repo's `buildRubricJudgeSystemPrompt`
and `renderPromptTemplate`); at the autonomous end, frameworks like DSPy
*optimize* prompts against a metric with no human in the draft loop (the fully
automated form, which the spec lists as out of scope and the repo doesn't touch).
The pragmatic middle — human writes the goal, LLM drafts, human reviews — is what
most teams actually use, because it captures the drafting speedup while keeping
the review gate that prevents LLM-flavored prompt rot. The risk is real: an
unreviewed LLM-drafted prompt tends to be longer, vaguer, and more hedge-laden
than a human spec — exactly the qualities a good prompt avoids.

## Interview defense

**Q: When does meta-prompting help and when does it hurt?** Helps for the initial
draft of a complex prompt (beats a blank page). Hurts on small tweaks and
high-iteration prompts where a human edit is faster than a model round-trip. And
it always needs a human review gate — unreviewed LLM-drafted prompts read like
LLM output, not engineering specs.

```
  goal → LLM draft → [HUMAN REVIEW] → codebase
                        the mandatory gate
```
*Anchor: programmatic assembly exists (`rubric-judge.ts:107`,
`profile-injector.ts:25`); LLM-driven generation is not yet exercised.*

**Q: The part people forget?** The **review gate**, and the distinction between
*assembling* a prompt from data (deterministic, safe — what the repo does) and
*generating* one with an LLM (needs review). Conflating them is how unreviewed,
LLM-flavored prompts sneak into a codebase.

## See also

- `03-prompts-as-code.md` — the PromptPackage a meta-prompt would become.
- `05-eval-driven-iteration.md` — evals are how you'd validate a generated prompt.
- `01-anatomy.md` — `injectProfile` composes the system section.
- `08-few-shot.md` — `buildRubricJudgeSystemPrompt` also splices examples.
