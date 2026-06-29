# Study — Prompt Engineering (aptkit)

Prompt engineering as a working discipline, anchored to the real prompt-shaped
code in this repo: the Gemma tool-call emulation, the versioned prompt
packages, structured-output-with-retry, profile injection, and the eval scorers
that gate prompt changes.

This guide is written in a **working-AI-engineer voice** — production scars, not
textbook tidiness. Every concept points at a file you can open.

## Reading order

Operational discipline first, specific techniques after.

| # | File | One line |
|---|------|----------|
| — | `00-overview.md` | The whole prompt surface in one map |
| 01 | `01-anatomy.md` | The four sections of a production prompt, and how they drift |
| 02 | `02-structured-outputs.md` | Schema + tolerant parse + retry — not "respond only in JSON" |
| 03 | `03-prompts-as-code.md` | Prompt packages: versioned, provenance-stamped, reviewed |
| 04 | `04-token-budgeting.md` | Counting tokens, the 80% rule, truncation, prefix position |
| 05 | `05-eval-driven-iteration.md` | Golden set + regression suite + rubric-judge gate the prompt |
| 06 | `06-single-purpose-chains.md` | One agent, one job, one capability id |
| 07 | `07-output-mode-mismatch.md` | Text vs JSON vs tool-call — the parser breaks at the seam |
| 08 | `08-few-shot.md` | Examples constrain harder than instructions |
| 09 | `09-chain-of-thought.md` | Reasoning prompts, and the structured-thinking-field trick |
| 10 | `10-self-critique.md` | Critique / vote / N-sample reliability, and its blind spots |
| 11 | `11-meta-prompting.md` | LLMs writing prompts for other LLM calls |
| 12 | `12-prompt-injection-defense.md` | Delimiters, instruction hierarchy, schema-as-cage |
| 13 | `13-forbidden-patterns.md` | Rotating formulas so repeated generation stops sounding the same |

## How the repo grounds each concept

- **Gemma provider** (`packages/providers/gemma/src/gemma-provider.ts`) — tool-call
  emulation is the single richest prompt-engineering artifact here: schemas
  rendered into the system text, a "respond with ONLY a single JSON object"
  instruction, and a `RETRY_NUDGE` corrective re-prompt.
- **Prompt packages** (`packages/prompts/src/*.ts`) — templates as code with
  id/version/capabilityId provenance.
- **Structured generation** (`packages/runtime/src/structured-generation.ts`) +
  **tolerant parse** (`packages/runtime/src/json-output.ts`).
- **Profile injection** (`packages/context/src/profile-injector.ts`) into the
  rag-query agent (`packages/agents/rag-query/src/rag-query-agent.ts`).
- **Forced synthesis** on the loop's last turn
  (`packages/runtime/src/run-agent-loop.ts`).
- **Eval scorers** — `packages/evals/src/rubric-judge.ts`,
  `packages/evals/src/precision-at-k.ts`.

## Cross-links to neighboring guides

- `../study-ai-engineering/` — RAG, agent loop, serving, the eval seam at depth.
- `../study-agent-architecture/` — reasoning patterns and the agentic-retrieval loop.
- `../study-testing/` — fixture-replay, deterministic scorers, regression-from-a-bug.
- `../study-security/` — trust boundaries; the runtime-side complement to
  concept 12's author-side injection defense.

## Honest gaps (`not yet exercised`)

- No few-shot **example library** as infrastructure — examples are inline string
  literals (concept 08).
- No **prompt caching** / `cache_control` anywhere in the repo (concept 04).
- No **automated prompt optimization** (concept 11).
- **Model-specific prompt drift** is real but not systematically tracked —
  no per-model eval matrix (concept 03, 05).
- No **self-critique / self-consistency** loop wired in any agent (concept 10).
