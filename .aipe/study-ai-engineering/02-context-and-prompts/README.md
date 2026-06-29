# 02 — Context and prompts

> Anchor: LLM application engineering (loopd-shaped).
> Curriculum: Phase 1 (context window, prompt chaining).

How aptkit manages the finite context window and composes multi-step work.
The standout here is the **context-window guard**
(`packages/providers/local/src/context-window-guard.ts`) — a wrapper
provider that estimates token count and fails loud before a request blows
the window.

## Files

- `01-context-window.md` — the finite container; the char-ratio guard that protects it.
- `02-lost-in-the-middle.md` — position bias; why aptkit keeps `top_k` small and floors it.
- `03-prompt-chaining.md` — the analytics pipeline (monitor → diagnose → recommend) as a chain of capabilities.

Self-contained per concept.
