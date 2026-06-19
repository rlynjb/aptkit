# Prompt Engineering — AptKit

A per-repo study guide for prompt engineering, anchored to the real code in
the AptKit monorepo (`@rlynjb/aptkit-core`). Written in a working-AI-engineer
voice: production scars, operational failure modes, demo-vs-prod discipline.

Every concept file follows the shared 11-block concept template
(`specs/format.md`): zoom out → structure pass → how it works → primary
diagram → implementation in this repo (real `file:line`, real prompt text) →
elaborate → interview defense → validate → see also.

## What this repo actually exercises

AptKit packages reusable AI-agent capabilities. The prompt-engineering surface
lives in three places:

- `packages/prompts/src/*` — four versioned `PromptPackage`s (query,
  recommendation, monitoring, diagnostic), each a system prompt + variables +
  examples, rendered with `{var}` substitution.
- `packages/runtime/src/*` — the loop that forces a final-answer turn
  (`buildSynthesisInstruction`), the JSON extractor (`parseAgentJson`), and the
  structured-generation retry (`generateStructured`).
- `packages/agents/*/src/*` — per-agent wiring: synthesis instructions,
  recovery re-prompts that re-inject prior tool results, intent classification,
  and the rubric LLM-judge.

This is prompts-as-versioned-code with a parse-and-retry boundary, not a
tool-calling-for-output / `response_format` system. Where the repo does
something the literature warns against, or skips something the literature
recommends, the files say so.

## Reading order

Operational discipline first, specific techniques after.

| # | File | One line |
|---|------|----------|
| — | [00-overview.md](00-overview.md) | The whole prompt surface in one map |
| 01 | [01-anatomy.md](01-anatomy.md) | The four sections of every AptKit system prompt |
| 02 | [02-structured-outputs.md](02-structured-outputs.md) | JSON-in-a-fence + validate-at-the-boundary + retry |
| 03 | [03-prompts-as-code.md](03-prompts-as-code.md) | `PromptPackage` — id, version, capabilityId provenance |
| 04 | [04-token-budgeting.md](04-token-budgeting.md) | Context guard, usage ledger, the char/3 heuristic |
| 05 | [05-eval-driven-iteration.md](05-eval-driven-iteration.md) | Replay → eval → promote → deterministic fixture |
| 06 | [06-single-purpose-chains.md](06-single-purpose-chains.md) | One capability, one job; monitor → diagnose → recommend |
| 07 | [07-output-mode-mismatch.md](07-output-mode-mismatch.md) | Prose vs JSON, declared per capability |
| 08 | [08-few-shot.md](08-few-shot.md) | `PromptExample[]`, EQL recipes, rubric calibration |
| 09 | [09-chain-of-thought.md](09-chain-of-thought.md) | Hypotheses-before-tools; reasoning as a JSON field |
| 10 | [10-self-critique.md](10-self-critique.md) | Self-critique & self-consistency — **not yet exercised** |
| 11 | [11-meta-prompting.md](11-meta-prompting.md) | Code that builds prompts from rubric definitions |
| 12 | [12-prompt-injection-defense.md](12-prompt-injection-defense.md) | Author-side defenses — **mostly not yet exercised** |
| 13 | [13-forbidden-patterns.md](13-forbidden-patterns.md) | Rotation/forbidden openings — **not yet exercised** |

## Cross-links to neighboring guides

- `../study-system-design/` — the agent loop, provider abstraction, replay
  backbone as system-design patterns.
- AI-engineering and agent-architecture guides (when generated) cover the
  runtime-side defenses (output validation, never letting model output trigger
  side effects) that complement the author-side prompt work here.

## Honest gaps

Concepts the repo does not yet exercise, named per file rather than invented:
self-critique / self-consistency (10), explicit prompt-injection defenses (12),
forbidden-pattern rotation (13), and within concept 4: real tokenizer counting,
prefix-cache directives. Concept 2 uses JSON-in-fence rather than provider
tool-calling-for-output. These are the buildable targets.
