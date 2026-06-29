# 04 — Agent Infrastructure

**Anchor: single-agent + multi-agent (both).**

The cross-cutting disciplines that matter more than any single topology — the parts most practitioners underweight and the parts that separate a demo from a shipped system. aptkit invests heavily here; this is where the toolkit's real engineering lives.

1. `01-context-engineering.md` — `injectProfile` + `schemaSummary`: what fills the window.
2. `02-agent-memory-tiers.md` — `@aptkit/memory`: built, reuses the retrieval contracts, **not yet wired** into an agent.
3. `03-tool-calling-and-mcp.md` — `ToolRegistry` + policy + the Gemma tool-call emulation.
4. `04-agent-evaluation.md` — the replay-centric eval pipeline; trajectory and precision@k.
5. `05-guardrails-and-control.md` — the control envelope around the loop.
