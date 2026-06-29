# Design a technical-support chatbot

- **The prompt:** "Design a support chatbot that answers customer questions from a product knowledge base and escalates to a human when it can't."

- **Standard architecture:** The whiteboard starts with the RAG spine — retrieve from the KB, ground the answer, cite — and then the two things that make it a support system rather than a Q&A toy: an escalation gate and a feedback loop.

  ```
  Support chatbot — grounded RAG with escalation gate
  ┌────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
  │ user   │ → │ intent   │ → │ retrieve │ → │ grounded │
  │ message│   │ classify │   │ from KB  │   │  answer  │
  └────────┘   └────┬─────┘   └──────────┘   └────┬─────┘
                    │                             ▼
                    │                       ┌──────────┐
                    │ (low confidence)      │confidence│
                    └──────────────────────→│   gate   │
                                            └────┬─────┘
                              ┌──────────────────┴─────────────┐
                              ▼ (pass)                         ▼ (fail)
                        ┌──────────┐                    ┌────────────┐
                        │  answer  │                    │ escalate   │
                        │ + cites  │                    │ to human   │
                        └────┬─────┘                    └────────────┘
                             ▼
                        ┌──────────┐
                        │ feedback │ → KB freshness + correction log
                        │   loop   │
                        └──────────┘
  ```

  The gate is the design point: a support bot that answers confidently when it shouldn't is worse than one that escalates.

- **Data model:**
  - KB chunk index (vector store) — embedded doc chunks for retrieval, the answer's evidence.
  - Conversation log — per-session message turns with the retrieved chunks and the cited chunk ids, for audit and replay.
  - Confidence/escalation log — which turns hit the gate and why, to tune the threshold.
  - Correction log — human edits to wrong answers, the label source for both KB gaps and answer-quality eval.
  - KB freshness metadata — per-doc last-updated and source, to enforce a staleness SLA.

- **Key components:**
  - Intent classifier routes the message (FAQ vs account-specific vs out-of-scope); choice: heuristic keyword match before the LLM so the common intents never pay for a model call.
  - Retriever pulls candidate KB chunks for grounding; choice: vector top-k with a minimum-k floor so the answerer always has evidence to cite or explicitly nothing.
  - Grounded answerer generates the reply constrained to retrieved chunks and emits citations; choice: cite-or-refuse — if no chunk supports the claim, say so rather than generate.
  - Escalation gate compares answer confidence to a threshold and routes to a human on failure; choice: refuse-and-escalate beats a low-confidence guess because a wrong support answer costs more than a handoff.

- **Scale concerns:**
  - At ~1k KB docs retrieval quality drops if chunks overlap topics; you need per-product namespacing or metadata filters before the vector search.
  - At ~100 concurrent sessions the LLM answerer is the latency and cost bottleneck; cache answers for repeated FAQ intents and reserve generation for novel queries.
  - At weekly KB churn freshness becomes the dominant failure; without a reindex SLA the bot confidently cites superseded docs.
  - At ~10k daily conversations the correction log is large enough to mine for systematic KB gaps and to fine-tune the gate threshold.

- **Eval framing:** Offline, run a labeled set of question→expected-answer pairs through the pipeline and score retrieval with precision@k/recall@k and answer quality with an LLM-as-judge rubric (grounded? cited? correct?). Online, watch deflection rate (resolved without human), escalation precision (escalations that genuinely needed a human), and thumbs-up/correction rate. The metric that matters is not answer rate — it's correct-or-escalated rate.

- **Common failure modes:**
  - Hallucination — the answerer asserts facts not in the retrieved chunks; mitigate with cite-or-refuse and reject answers whose claims don't map to a chunk.
  - Stale KB — the bot cites a superseded doc; mitigate with a freshness SLA and surfacing last-updated in the citation.
  - Over-escalation — the gate is too conservative and dumps everything on humans; mitigate by tuning the threshold against the escalation-precision metric.
  - Silent wrong answer — confident reply with no human ever correcting it; mitigate with a feedback loop that logs corrections back as labels.

- **Applies to this codebase:** `partially`. The rag-query agent (`packages/agents/rag-query/src/rag-query-agent.ts`) is the RAG-over-KB spine: agentic retrieval with maxTurns 6 and maxToolCalls 4, profile injection, and cited answers grounded in the retrieved chunks via `search_knowledge_base` (`search-knowledge-base-tool.ts:101`, with its minTopK floor and hallucination-tolerant matchesFilter). Intent classification exists as a heuristic+LLM pass (`packages/agents/query/src/intent.ts`), so the front of the funnel is partially shaped. What's missing is everything that makes it a support system: there is no confidence gate, no escalation-to-human path, no feedback/correction loop, and no KB freshness SLA. It answers and cites; it does not know when to stop and hand off.

- **How to make it apply:** Add a confidence threshold to `rag-query-agent.ts` after the answer is assembled — if the cited chunks don't sufficiently cover the answer (or the agent exhausts maxToolCalls without grounding), return a refuse-and-escalate result instead of a guess. Wire corrections and escalations into buffr's `agents.messages` (the conversation log already living in `/Users/rein/Public/buffr/sql/001_agents_schema.sql`) so human edits become labels. Then the rubric-judge eval (`packages/evals/src/rubric-judge.ts`) can score grounded/cited/correct on real traffic. The escalation gate and feedback loop are `not yet exercised`; the RAG spine and intent routing are real.
