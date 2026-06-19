# 07 — System Design Templates (AI side)

These are interview reframes, not new code. Each template takes the same AptKit
agents you already studied in sections 04 and 05 and re-frames them in the fixed
shape interviewers use for AI/LLM system design: requirements → data → architecture
→ scale → eval → failure. Same code, different framing.

The point of a template is to give you a whiteboard structure to fall back on when
an interviewer says "design X." For each one you should be able to draw the standard
architecture in 60 seconds, then answer honestly whether AptKit is that system —
and if it isn't, name the exact refactor that would make it one.

Every file follows the same nine labelled bullets:

1. **The prompt** — the verbatim interview question.
2. **Standard architecture** — the box-and-arrow diagram.
3. **Data model** — what is stored where.
4. **Key components** — named sub-systems, one technical choice each.
5. **Scale concerns** — what breaks first, with concrete thresholds.
6. **Eval framing** — offline/online metrics that matter.
7. **Common failure modes** — what an interviewer probes for, with mitigations.
8. **Applies to this codebase** — `yes` / `partially` / `no`, with a paragraph.
9. **How to make it apply** — the concrete refactor naming real AptKit files.

## Templates

- [01 — Search ranking](./01-search-ranking.md) — Applies: **no / partially**.
  AptKit has no retrieval or ranking layer. The query agent retrieves through
  ~49 read-only tools, which is tool-augmented Q&A, not search ranking.
- [02 — Tech support chatbot](./02-tech-support-chatbot.md) — Applies:
  **partially**. The query agent is structurally close (intent → retrieve →
  answer → fallback) but runs over ecommerce analytics tools, not a support KB,
  and has no escalation or feedback loop.

## Where the honest mapping lives

The two root files describe what AptKit *actually* does:

- [`../ai-features-in-this-codebase.md`](../ai-features-in-this-codebase.md) — the
  five live AI features, their patterns, and per-feature specs.
- [`../ml-features-in-this-codebase.md`](../ml-features-in-this-codebase.md) — the
  honest statement that AptKit ships no trained model.

## Cross-links

- Retrieval / RAG foundations: [`../03-retrieval-and-rag/`](../03-retrieval-and-rag/)
- Agent loop and orchestration: [`../../study-agent-architecture/`](../../study-agent-architecture/)
- Prompt design: [`../../study-prompt-engineering/`](../../study-prompt-engineering/)
- The ML-side parallel templates: [`../09-ml-system-design-templates/`](../09-ml-system-design-templates/)
