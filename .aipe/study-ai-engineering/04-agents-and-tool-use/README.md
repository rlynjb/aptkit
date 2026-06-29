# 04 — Agents and tool use

> Anchor: LLM application engineering (loopd-shaped) — Phase 4.
> aptkit's bounded agent loop orchestrates a Gemma LLM (no native tool API)
> over read-only analytics/retrieval tools.

The bounded agent loop (`runAgentLoop`, `packages/runtime/src/run-agent-loop.ts`)
and the **emulated tool calling** on Gemma are the headline here — a model
with no tool API made to call tools by rendering schemas into the system
prompt and parsing JSON back, with a retry nudge and graceful text fallback.

## Files

- `01-agents-vs-chains.md` — the loop vs the linear pipeline; aptkit has both.
- `02-tool-calling.md` — emulated tool calling on Gemma (the crown jewel); native on Anthropic/OpenAI.
- `03-react-pattern.md` — the Thought-Action-Observation loop as `runAgentLoop` runs it.
- `04-tool-routing.md` — the tool-policy allowlist + coverage gate as deterministic routing.
- `05-agent-memory.md` — episodic memory over the retrieval contracts; short-term vs long-term.
- `06-error-recovery.md` — the loop's failure handling: forceFinal, maxToolCalls, parse-retry, hard stop.

Read `02-tool-calling.md` and `03-react-pattern.md` first.
