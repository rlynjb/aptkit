# 02 — Agentic Support-Task System

> The loop + control-envelope template. The interviewer wants an agent that
> *does things* — refunds, ticket updates, config changes — and knows when to
> stop and hand off to a human. The whole design is about the guardrails around
> the loop, not the loop. AptKit has a textbook control envelope wrapped around a
> loop that can't take any actions, which is exactly half the answer.

---

- **The prompt:**
  "Design an agent that resolves user requests by taking real actions across
  tools, and escalates when it can't."

- **Standard architecture:**
  An intent router classifies the request, hands it to a single ReAct agent that
  tool-calls against real action APIs, and wraps the loop in three guardrail
  layers: input sanitization (before the model sees the request),
  action-gating (a high-risk tool call pauses for human approval), and output
  schema validation (before anything is returned or committed). When the agent
  hits an action it isn't allowed to take or can't complete, it escalates to a
  human rather than guessing.

  ```
    Loop + control envelope: support-task agent

    request
       │
       ▼
    ┌──────────────┐   ┌─────────────────────────────────────────────┐
    │ intent route │──▶│           ReAct loop (bounded)              │
    └──────────────┘   │   ┌─────────────────────────────────────┐   │
                       │   │  model ──▶ tool call ──▶ result      │   │
    guardrails:        │   │     ▲                      │         │   │
      ┌─────────────┐  │   │     └──────────────────────┘         │   │
      │ input sanit.│──┼──▶│         (caps: turns / tool calls)   │   │
      └─────────────┘  │   └─────────────────────────────────────┘   │
      ┌─────────────┐  │             │ high-risk action?             │
      │ action gate │◀─┼─────────────┘                               │
      └──────┬──────┘  │             │ no                            │
             │ yes     │             ▼                               │
             ▼         │       ┌──────────────┐                      │
       ┌──────────┐    │       │ output schema│──▶ result            │
       │  HUMAN   │    │       │  validate    │                      │
       │ approval │    │       └──────────────┘                      │
       └────┬─────┘    └──────────────────┬──────────────────────────┘
            │ deny                         │ can't resolve
            ▼                              ▼
       ┌────────────────────────────────────────┐
       │            HUMAN escalation             │
       └────────────────────────────────────────┘
  ```

- **Data model:**
  A `Request` with classified `Intent`, a running `Transcript` of model turns and
  tool calls, an `Action` record per side-effecting call (with its approval
  status: auto / pending / approved / denied), and an `Outcome` (resolved /
  escalated) with a structured result payload. The action records are the audit
  trail — in a system that takes real actions, "what did it do and who approved
  it" is a first-class data requirement, not logging.

- **Key components:**
  - **Intent router** — classifies the request to pick scope and tools.
    *Decision: route to which tool set / which policy?* Misrouting hands the
    agent the wrong powers.
  - **ReAct loop** — bounded reason-act cycle. *Decision: what are the caps?*
    Max turns and max tool calls are what stop a runaway loop from burning budget
    or thrashing actions.
  - **Action gate** — intercepts high-risk tool calls for approval.
    *Decision: which actions are gated?* Read is free; anything that mutates
    customer state or money gates. This is the single most important decision in
    the system.
  - **Input sanitizer** — strips/neutralizes injection in untrusted input.
    *Decision: what's the trust boundary?* User text reaching the model is
    untrusted; treat it as such.
  - **Escalation gate** — hands off to a human on low confidence or denied
    action. *Decision: what triggers escalation?*

- **Scale concerns:**
  Human approval is the throughput bottleneck — gate too much and humans become
  the queue; gate too little and you ship unsafe actions. Action idempotency
  matters at scale (a retried loop must not double-charge). The escalation queue
  needs its own backpressure. Per-request token cost is bounded by the turn cap,
  which is what keeps cost predictable under load.

- **Eval framing:**
  Score task resolution rate, but weight *unsafe actions* far more heavily —
  a system that resolves 95% of tasks but fires one wrong refund is a failure.
  Eval the action gate adversarially (does it catch the dangerous call), eval the
  intent router for misroutes, and eval escalation precision/recall (does it hand
  off exactly when it should). Replay with pinned tool results to make
  action-gating deterministic in tests.

- **Common failure modes:**
  Prompt injection through unsanitized user input steering the agent to take an
  unauthorized action; the agent taking an irreversible action it shouldn't have
  (missing or mis-scoped gate); over-escalation making the agent useless;
  under-escalation where it confidently does the wrong thing; non-idempotent
  retries double-firing actions.

- **Applies to this codebase:** **Partially.**
  The query agent is genuinely a *correctly-shaped half* of this design. It is
  intent-routed: `classifyIntent` in `packages/agents/query/src/intent.ts:12`
  classifies the question before the loop runs. It is a single-agent ReAct loop
  (`runAgentLoop`, `packages/runtime/src/run-agent-loop.ts:76`) with output
  validation (`packages/agents/query/src/validate.ts`, the
  `parseResult`/recovery seam at `run-agent-loop.ts:192-199`) and a strong tool
  grant: `filterToolsForPolicy` (`packages/tools/src/tool-policy.ts:11`) gives it
  a least-privilege allowlist, and every granted tool is **read-only analytics**
  — so structurally *no action can fire*. The control envelope is all there: caps
  (`maxTurns` default 8 at `run-agent-loop.ts:87`, `maxToolCalls` at line 101),
  forced synthesis (`buildSynthesisInstruction` at line 72, forced at lines
  102-106), and `AbortSignal` cancellation (line 99). What's missing is the
  action half: **no input sanitization** (the query agent is a live
  prompt-injection surface), **no action-gating** (moot today — there are no
  write tools to gate), and **no human escalation gate** (no pause/checkpoint
  anywhere in the loop).

- **How to make it apply:**
  Add write/action tools to the catalog, register them in a `ToolPolicy`, and put
  them behind a human-approval gate with checkpoint/resume in the loop. The hard
  part is mostly done: the control envelope (`run-agent-loop.ts` caps, forced
  synthesis, validate-and-recover) already bounds the loop, and the `ToolPolicy`
  seam (`packages/tools/src/tool-policy.ts:11`) is exactly where you'd scope which
  actions a capability may even see. The net-new work is (1) an input guardrail in
  front of `classifyIntent`, (2) an action-gating step in the tool executor that
  suspends on high-risk tools — `runAgentLoop` has no human-in-the-loop
  pause/checkpoint today, so this is the real addition — and (3) an escalation
  branch on the validation/recovery failure path. See
  [05 — Guardrails and Control](../04-agent-infrastructure/05-guardrails-and-control.md)
  for the full envelope and
  [05 — Reflexion / Self-Critique](../01-reasoning-patterns/05-reflexion-self-critique.md)
  for the confidence-to-escalate signal.
