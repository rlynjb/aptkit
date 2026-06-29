# Prompt Engineering — study guide for aptkit

Thirteen concepts, written in a working-AI-engineer voice, anchored to
real files in this repo. Not blog-post prompt advice — the kind that
survives a model upgrade and a production on-call rotation.

This guide is grounded in aptkit specifically: a provider-neutral agent
toolkit where the most interesting prompt-engineering surface is the
**Gemma tool-call emulation** (`packages/providers/gemma/src/gemma-provider.ts`)
— rendering tool JSON schemas into the system prompt because a local model
has no native tool API — plus **structured-output-with-retry**
(`packages/runtime/src/structured-generation.ts`), **versioned prompt
packages** (`packages/prompts/src/`), **profile injection**
(`packages/context/src/profile-injector.ts`), and the **eval loop** that
gates all of it (`packages/evals/src/`).

## Reading order

Operational discipline first (you cannot iterate prompts you cannot
measure or version), specific techniques after.

| # | File | One line |
|---|------|----------|
| — | [00-overview.md](00-overview.md) | The whole prompt surface of aptkit in one map |
| 1 | [01-anatomy.md](01-anatomy.md) | The four sections of a production prompt, and how mixing them causes drift |
| 2 | [02-structured-outputs.md](02-structured-outputs.md) | Tool calling vs JSON-in-text, schema enforcement, validate-and-retry |
| 3 | [03-prompts-as-code.md](03-prompts-as-code.md) | Prompts as version-controlled source with id/version/capability provenance |
| 4 | [04-token-budgeting.md](04-token-budgeting.md) | Counting tokens, allocating the window, lost-in-the-middle, the 80% rule |
| 5 | [05-eval-driven-iteration.md](05-eval-driven-iteration.md) | The golden set, the regression suite, iterate against scores not vibes |
| 6 | [06-single-purpose-chains.md](06-single-purpose-chains.md) | One capability, one job — debuggable, model-routable, cheap to iterate |
| 7 | [07-output-mode-mismatch.md](07-output-mode-mismatch.md) | When one chain emits JSON and the next expects prose, the parser breaks |
| 8 | [08-few-shot.md](08-few-shot.md) | Examples constrain output harder than instructions — and where aptkit stops short |
| 9 | [09-chain-of-thought.md](09-chain-of-thought.md) | Reasoning prompts, when they help, and putting reasoning in a structured field |
| 10 | [10-self-critique.md](10-self-critique.md) | Self-critique, self-consistency, and the blind-spot problem |
| 11 | [11-meta-prompting.md](11-meta-prompting.md) | Using an LLM to write prompts — and aptkit's slot for it |
| 12 | [12-prompt-injection-defense.md](12-prompt-injection-defense.md) | Author-side defenses: hierarchy, delimiters, output structure as a cage |
| 13 | [13-forbidden-patterns.md](13-forbidden-patterns.md) | Rotating formulas so repeated generation does not converge on one voice |

## Cross-links to neighboring guides

- **study-ai-engineering** — the production-serving and RAG sections; this
  guide's structured-output and injection-defense concepts meet the
  runtime-side validation and trust-boundary work there.
- **study-agent-architecture** — the agent loop, agentic retrieval, and
  ReAct-style control that the prompts in this guide drive.
- **study-testing** — the replay-centric eval backbone that concept 5
  (eval-driven iteration) depends on, walked in full.

## `not yet exercised` in this repo

- Prompt caching (`cache_control` on the static prefix) — no usage anywhere
  in `packages/`.
- Few-shot examples spliced into the rendered system prompt — the slot
  exists (`PromptPackage.examples`) but feeds evals, not the prompt.
- Explicit forbidden-openings / rotating-formula lists — the closest live
  mechanism is round-robin variant angles in `content-generation-workflow.ts`.
- Automated prompt optimization and systematic cross-model prompt-drift
  gating.
