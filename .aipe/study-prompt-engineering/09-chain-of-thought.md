# 09 — Chain-of-thought (CoT)

**Industry name:** chain-of-thought / step-by-step reasoning — *Industry standard*

## Zoom out, then zoom in

"Let's think step by step" was the magic phrase of 2023. In 2026 it's more
nuanced: frontier models reason internally now, so explicitly asking for CoT
helps cheaper models (like the Gemma this repo defaults to) more than it helps
the big ones. The trap I've hit: asking for reasoning on a *simple* task wastes
tokens and, worse, asking for free-form reasoning when you also need structured
output pollutes your JSON. **The discipline: prompt for reasoning where the task
is genuinely multi-step, and when you need both reasoning and a structured
answer, put the reasoning in a field of the structured output — never in
free-form prose around it.**

```
  Zoom out — reasoning in the agent prompts

  ┌─ Authoring ───────────────────────────────────────────────┐
  │  diagnostic.ts: "Generate 2-3 hypotheses BEFORE the first  │ ← we are here
  │     tool call" + "Recommended approach: 1. ... 2. ..."     │
  │  rubric-judge: reasoning field IN the structured output    │
  └───────────────────────────┬────────────────────────────────┘
  ┌─ Runtime ─────────────────▼────────────────────────────────┐
  │  agent loop: reasoning happens across turns (think→tool→...)│
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the diagnostic agent is the repo's clearest CoT — its prompt
*sequences* the reasoning ("generate hypotheses, then query to falsify each").
The rubric judge shows the structured-CoT move: a `reasoning` field inside the
validated JSON, not loose prose.

## The structure pass

**Layers:** the prompt (asks for or forbids reasoning) → the model (emits
reasoning, internally or visibly) → the consumer (must not choke on the
reasoning).

**Axis — is reasoning free-form prose or a structured field?** This is the axis
that decides whether CoT and structured output can coexist:

```
  Axis: "where does the reasoning go?"

  ┌─ Free-form CoT prose ──┐   seam    ┌─ Structured reasoning field ─┐
  │ "Let's think... <prose>│ ══╪══════► │ {"reasoning":"...",          │
  │  then {json}"          │ flips     │  "verdict":"pass", ...}      │
  │ → POLLUTES the parser  │           │ → parser-safe, still reasons │
  └────────────────────────┘           └───────────────────────────────┘
```

**Seam:** the boundary between reasoning and answer. If reasoning is free-form
prose wrapped around a JSON object, `parseAgentJson` has to carve the JSON out of
the prose (it can, via substring scan — `json-output.ts:17` — but it's fragile).
If reasoning is a *field*, the whole output is one clean object. **What breaks at
the seam:** "think step by step, then return JSON" produces prose-then-JSON that
fights your structured-output contract.

## How it works

### Move 1 — the mental model

You already do this in code reviews: you don't want just the answer, you want the
reasoning that justifies it — but you want it in a structured place (the PR
description), not scrawled across the diff. CoT is asking the model to show its
work; structured CoT is giving the work a designated field so it doesn't bleed
into the answer.

```
  Pattern — reasoning placement

  TASK simple?  ──► skip CoT (wastes tokens)
  TASK multi-step + prose output? ──► "think step by step" inline
  TASK multi-step + structured output? ──► reasoning as a FIELD:
       { "reasoning": "...", "answer": ... }   ← one object, parser-safe
```

### Move 2 — walking the two reasoning styles

**Sequenced CoT (the diagnostic agent).** `diagnostic.ts:17` lays out a
"Recommended approach": *"1. Generate 2-3 hypotheses before the first tool call.
2. Query to falsify each hypothesis. 3. … 4. Conclude with the hypothesis that
best fits the evidence."* This is CoT as an explicit procedure — the prompt
doesn't just say "reason," it scripts the reasoning steps. **Why here:** root-cause
diagnosis *is* multi-step (hypothesize → test → conclude), so the reasoning
earns its tokens. **What breaks without it:** the model jumps to a conclusion and
never falsifies competing hypotheses — the single-hypothesis trap.

**Cross-turn CoT (the agent loop).** In `runAgentLoop`, reasoning is distributed
across turns: the model emits a thought, calls a tool, sees the result, reasons
again (`run-agent-loop.ts:98` loop). Each assistant turn's text is the visible
reasoning, traced as a `step` event (`:128`). The loop *is* a chain-of-thought
spread over tool calls — the ReAct pattern (see `../study-agent-architecture/`).

**Structured reasoning (the rubric judge).** The judgment shape includes a
`reasoning` field and a per-dimension `reason` (`rubric-judge.ts:46`,
`RubricJudgment`). The reasoning lives *inside* the validated JSON:

```
  Inline annotation — rubric-judge.ts:135 output shape

  const outputShape = {
    dimensions: { <dim>: { score: 0, reason: '' } },  ← per-dimension reasoning
    verdict: '...',
    fix: '',
    reasoning: '',                                     ← overall reasoning, a FIELD
  };
  // → the model reasons AND returns clean JSON; parser never sees loose prose
```

This is the move the spec calls out: want both reasoning and a structured answer?
The reasoning goes in a field, not in free prose. The validator (`:206`) even
checks `reasoning` is a string when present.

**When CoT hurts.** The intent classifier (`intent.ts:19`) deliberately forbids
reasoning: *"Reply with ONLY the one word"* with `maxTokens: 16`. Asking a
one-word classifier to reason would waste tokens and risk it emitting the
reasoning instead of the label (an output-mode mismatch, concept 07). Simple
lookups and structured classifiers should *suppress* CoT.

### Move 3 — the principle

**Reasoning is a token spend you make only when the task is multi-step, and you
give it a structured home when you also need a parseable answer.** The modern
caveat matters: on frontier models internal reasoning means explicit CoT buys
less than it used to, but on the cheaper local models this repo targets (Gemma)
it still pays. The durable rule is placement — free-form CoT and structured
output don't mix, so route the reasoning into a field.

## Primary diagram

```
  Chain-of-thought — placement decision across the repo

  intent classifier      → NO CoT  ("one word only", maxTokens:16)
                            simple task, reasoning would waste/pollute

  diagnostic agent        → SEQUENCED CoT in the prompt
                            "1. hypothesize 2. falsify 3. locate 4. conclude"

  agent loop (any)        → CROSS-TURN CoT (think → tool → think), ReAct
                            each assistant turn = a reasoning step (trace)

  rubric judge            → STRUCTURED CoT: reasoning in a JSON FIELD
                            {dimensions:{reason}, reasoning} — parser-safe
```

## Elaborate

The CoT result (Wei et al., 2022) showed step-by-step prompting unlocks
multi-step reasoning in large models; the 2024–2025 shift is that
reasoning-tuned models (the o-series, Claude's extended thinking) do this
internally, so the *explicit* "think step by step" instruction is increasingly
redundant on frontier models but still load-bearing on small/local ones. The
structured-reasoning-field pattern is the production reconciliation of CoT with
tool calling and JSON mode — Anthropic's guidance is exactly this: use a
`<thinking>` region or a dedicated field so reasoning doesn't contaminate the
answer. The agent loop here is the ReAct variant of CoT (reason+act
interleaved), covered at depth in `../study-agent-architecture/`.

## Interview defense

**Q: You need the model to reason AND return JSON — how?** Put the reasoning in a
field of the structured output (`{"reasoning": "...", "answer": ...}`), never as
free-form prose around the JSON. Free prose + JSON fights your parser; a field
keeps one clean object that still carries the reasoning.

```
  ✗ "think step by step\n\n{...}"   → parser carves JSON out of prose (fragile)
  ✓ {"reasoning":"...", "verdict":"..."}  → one object, reasons + parses
```
*Anchor: `rubric-judge.ts:135` (reasoning field) vs `intent.ts:19` (no CoT).*

**Q: When does CoT hurt?** Simple lookups and structured classifiers — it wastes
tokens and risks the model emitting reasoning where you wanted a bare label
(output-mode mismatch). The intent classifier forbids it on purpose. On frontier
models explicit CoT also buys less now that reasoning is internal.

## See also

- `02-structured-outputs.md` — the structured output the reasoning field lives in.
- `07-output-mode-mismatch.md` — free-form CoT + JSON is a mode collision.
- `04-token-budgeting.md` — CoT is a deliberate token spend.
- `../study-agent-architecture/` — the agent loop as ReAct-style CoT.
