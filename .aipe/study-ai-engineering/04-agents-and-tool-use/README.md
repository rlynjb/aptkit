# 04 — Agents and tool use

How a model stops being a chatbot and starts *doing* things: it asks to call a
tool, your code runs it, the result goes back, and the loop repeats until the
model has an answer. Everything in AptKit's agent layer is one engine —
`runAgentLoop` — wearing different prompts and different tool allowlists.

Read `03-react-pattern.md` first. It is the core primitive; the other five files
are the concepts that hang off it (what a chain is and isn't, what a tool call
physically is, how tools get routed and locked down, what the agent remembers,
and how it recovers when something breaks).

## Files

- **[01-agents-vs-chains.md](01-agents-vs-chains.md)** — A chain is steps *you*
  hard-code; an agent is a loop where the *model* decides each step and how many.
  Verdict: AptKit is the agent shape, not chains — but each agent is
  single-purpose.
- **[02-tool-calling.md](02-tool-calling.md)** — The brain/hands split. The model
  emits a `tool_use` block; your code runs the tool; the result goes back as a
  `tool_result`. Tools are vendor-neutral schemas; adapters translate to/from
  Anthropic and OpenAI shapes.
- **[03-react-pattern.md](03-react-pattern.md)** — ★ **THE CORE PRIMITIVE.** The
  bounded agent loop: ReAct (Thought/Action/Observation) plus a turn budget, a
  tool-call budget, and a forced synthesis turn. Every other file in this
  section references it.
- **[04-tool-routing.md](04-tool-routing.md)** — Heuristic vs LLM routing, and
  least-privilege tool allowlists. The provider only ever *sees* the tools a
  capability is allowed to call. Plus pre-model coverage gating.
- **[05-agent-memory.md](05-agent-memory.md)** — Short-term (the in-context
  `messages` array) vs long-term (retrieved). AptKit has only short-term — and
  that honesty is the lesson.
- **[06-error-recovery.md](06-error-recovery.md)** — The failure-mode table:
  what the loop handles (tool error, budget exhaustion, unparseable output,
  provider failure) and what it doesn't (per-tool timeout, repeated-tool loops).

## Reading order

```
  Start → 01 (is it even an agent?) → 02 (what's a tool call?)
        → 03 (THE LOOP — read this twice)
        → 04 (which tools, locked down how?)
        → 05 (what does it remember?)
        → 06 (what happens when it breaks?)
```
