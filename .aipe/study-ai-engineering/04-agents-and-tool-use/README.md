# 04 — Agents and tool use

> Anchor: LLM application engineering (agentic retrieval + analytics agents). ·
> Curriculum: Phase 4 (no curriculum file in repo; exercises cite real paths).

The other heart of aptkit. Six capabilities run the same bounded agent loop, and
the standout engineering is that the **default model has no native tool-calling**:
Gemma can't take a `tools` array, so the provider renders tools into the system
prompt and parses a JSON tool call back out, with a bounded retry nudge and a
graceful text fallback. That's the most distinctive thing in the repo, and it
lives in `02-tool-calling.md`.

The signature retrieval bug — a hallucinated `filter` argument wiping every result
— is an agent error-recovery story; it lives in `06-error-recovery.md`.

## Files (self-contained per concept)

1. `01-agents-vs-chains.md` — the loop vs the line; aptkit has both
2. `02-tool-calling.md` — Gemma's emulated tool-calling; the most distinctive file
3. `03-react-pattern.md` — thought/action/observation in the agent loop
4. `04-tool-routing.md` — least-privilege tool policies; heuristic vs LLM routing
5. `05-agent-memory.md` — episodic memory reusing the retrieval contracts (zero new infra)
6. `06-error-recovery.md` — bounded turns, forced synthesis, the hallucinated-filter bug + fix
