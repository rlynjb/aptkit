# Tech Support Chatbot System Design

- **The prompt:** "Design a tech support chatbot for a product. It must answer customer questions, escalate when it can't, and learn from agent corrections."

- **Standard architecture:**

  ```text
  Support chatbot pipeline
  ────────────────────────────────────
  User message
    │
    ▼
  ┌──────────────────────────────────┐
  │ Intent classification            │
  │  (heuristic + LLM)               │
  └──────────────┬───────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────┐
  │ RAG over knowledge base          │
  │  (docs, past tickets, runbooks)  │
  └──────────────┬───────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────┐
  │ LLM response generation          │
  │  (constrained to retrieved KB)   │
  └──────────────┬───────────────────┘
                 │
            ┌────┴─────┐
            │          │
   confident▼          ▼ unsure / out-of-scope
       Respond     ┌──────────────────┐
                   │ Escalate to      │
                   │ human agent      │
                   └────────┬─────────┘
                            ▼
                   Agent answer logged
                   for KB update
  ```

- **Data model:**
  - Knowledge base: docs, FAQs, past ticket resolutions, each chunked, embedded, indexed.
  - Conversation history per user with `{turn, role, content, tools_called, confidence_score, escalated}`.
  - Escalation log linking bot conversations to human-resolved outcomes — the training signal for improvement.
  - Feedback log: thumbs-up/down per response, free-text agent corrections.

- **Key components:**
  - *Intent classification*: detect category (billing, technical, account, out-of-scope) before retrieval. Decision: heuristic keyword first, LLM classifier on ambiguous cases.
  - *RAG retrieval*: hybrid retrieval over the KB, scoped by intent to reduce noise. Decision: chunk by section, not by token.
  - *Response generation*: LLM constrained to cite retrieved chunks. Decision: refuse if no chunk clears the relevance threshold — escalate rather than hallucinate.
  - *Escalation*: rule-based gate (out-of-scope intent, confidence below threshold, or "agent please") triggers handoff with full context.
  - *Feedback loop*: agent corrections logged as gold-standard responses, fed back into the eval set, used to find KB gaps.

- **Scale concerns:**
  - At ~10k conversations/day: LLM cost dominates. Cache common Q-A pairs, route easy questions to a cheaper model.
  - At ~100 escalations/day: human agents become the bottleneck. Prioritize the queue by user value; surface the bot's draft so the agent edits instead of types.
  - At ~1M KB chunks: retrieval latency grows. Tiered retrieval (intent-scoped first, full corpus on miss), pre-compute embeddings for hot entries.

- **Eval framing:**
  - Offline: golden set of resolved tickets, bot answer vs human answer, rubric-scored.
  - Online: resolution rate without escalation, time to resolution, CSAT.
  - Adversarial set: prompt injection ("ignore previous instructions"), out-of-scope questions, hostile users.

- **Common failure modes:**
  - Hallucinated answers when the KB has nothing relevant. Mitigation: relevance threshold gates the response, refuse + escalate.
  - Prompt injection in user messages. Mitigation: sanitize, never let the LLM emit privileged actions (passwords, refunds).
  - Stale KB — bot describes a deprecated feature. Mitigation: freshness SLA, re-embed on doc change within 24h.
  - Tone drift across conversations. Mitigation: system prompt defines persona; eval rubric scores tone adherence.

- **Applies to this codebase:** **Partially — this is AptKit's closest AI-side template match.** The **query agent** (`packages/agents/query/src/query-agent.ts`) is structurally the chatbot pattern minus the escalation half. It has:
  - **Intent classification, heuristic + LLM**, exactly as the template draws it. `packages/agents/query/src/intent.ts` exposes `parseIntent()` (keyword heuristic: `monitoring` / `recommendation` / `diagnostic`) and `classifyIntent()` (a one-word LLM classification call). This is the "heuristic first, LLM on ambiguous cases" decision made real.
  - **Tool-augmented answer generation** in place of RAG-over-KB. Instead of retrieving KB chunks, the agent calls a read-only allowlist of ~49 analytics tools (`queryToolPolicy`) inside `runAgentLoop` and synthesizes prose with a `synthesisInstruction` that tells it to "cite the key numbers you found."
  - **A refuse-don't-hallucinate behavior.** When the loop produces nothing usable, the agent returns `FALLBACK_ANSWER = 'I was unable to find enough data to answer that question.'` That is the "better to escalate than hallucinate" instinct, expressed as an honest fallback.
  - **Least-privilege as the injection defense.** The template says "never let the bot emit privileged actions." AptKit enforces this at the seam: every query tool is read-only (`list_*`, `get_*`, `execute_analytics`), filtered by `filterToolsForPolicy` (`packages/tools`). The model physically cannot mutate the workspace, which is the structural version of the chatbot's "no refunds/passwords" rule.

  What is missing, and why it is only partial: AptKit answers over **ecommerce analytics tools, not a support knowledge base** — the domain is "why did revenue drop," not "how do I reset my password." And there is **no escalation gate, no human handoff, and no feedback loop.** The agent never decides "I am unsure, route this to a human"; it just returns the fallback string. There is no conversation history persisted per user, no confidence score on the answer, and no agent-correction log feeding the eval set. So the left two-thirds of the diagram (intent → retrieve → answer → refuse) is built; the right third (escalate → human → log → learn) is absent.

- **How to make it apply:** Two additive changes, both reusing infrastructure that already exists:
  1. **Add an escalation gate.** Today the query agent returns either an answer or `FALLBACK_ANSWER`. Replace that binary with a confidence-tiered decision: when the loop exhausts its `maxToolCalls` (6) without grounding, or when `classifyIntent` returns low confidence, emit an escalation `CapabilityEvent` (extend the union in `packages/runtime/src/events.ts`) instead of swallowing it as the fallback string. The Studio UI (`apps/studio`) already renders trace events, so an "escalated" marker would surface for free.
  2. **Add feedback logging.** Persist a per-answer feedback record (thumbs-up/down, optional correction) as NDJSON alongside the replay artifacts in `artifacts/replays/`. Then close the loop the same way AptKit already closes its eval loop: promote a corrected answer to a fixture via `scripts/promote-replay-to-fixture.mjs`, so the correction becomes a deterministic regression test through `FixtureModelProvider`. That is the chatbot's "agent corrections feed the eval set," implemented with AptKit's existing replay-to-fixture pipeline.

  RAG itself (chunk + embed the support KB) is the third piece, and it lives in [`../03-retrieval-and-rag/`](../03-retrieval-and-rag/) — AptKit's "retrieval" is currently tool calls, not vector search, so swapping the tool layer for an indexed KB is what turns this from analytics Q&A into a true support chatbot.
