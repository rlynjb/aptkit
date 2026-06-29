# D — Agent Infrastructure

The cross-cutting disciplines that matter more than any single topology — the parts most practitioners underweight and the parts that separate a demo from a shipped system.

Anchor: single-agent + multi-agent (both).

aptkit exercises most of these in single-agent form: context engineering (`injectProfile`), tool calling under emulation (gemma), agent memory (built, not yet wired), eval (replay-centric), guardrails (the loop's caps + least-privilege policy).

## Files

1. [01-context-engineering.md](01-context-engineering.md) — the discipline RAG and prompt engineering are subsets of. `injectProfile` + prompt packages.
2. [02-agent-memory-tiers.md](02-agent-memory-tiers.md) — memory as a component. **Built (`@aptkit/memory`), not yet wired into an aptkit agent.**
3. [03-tool-calling-and-mcp.md](03-tool-calling-and-mcp.md) — the substrate every pattern runs on; gemma emulates it.
4. [04-agent-evaluation.md](04-agent-evaluation.md) — trajectory, not just output. aptkit's replay-centric backbone.
5. [05-guardrails-and-control.md](05-guardrails-and-control.md) — the control envelope around the loop. aptkit's caps + least-privilege allowlist.
