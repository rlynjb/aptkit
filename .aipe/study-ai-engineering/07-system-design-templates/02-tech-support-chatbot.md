# Design a Tech Support Chatbot

- **The prompt:** "Design a tech support chatbot for a product. It must answer customer questions, escalate when it can't, and learn from agent corrections."

- **Standard architecture:**

```
        user message + history
                 │
                 ▼
   ┌──────────────────────────┐
   │ Intent classification     │  heuristic gate → LLM fallback
   └────────────┬─────────────┘
                │
                ▼
   ┌──────────────────────────┐
   │ RAG over knowledge base   │  embed → ANN → top-k chunks
   └────────────┬─────────────┘
                │
                ▼
   ┌──────────────────────────┐
   │ LLM response, constrained │  answer ONLY from retrieved chunks
   │ to retrieved KB           │
   └────────────┬─────────────┘
                │
        confident & grounded?
          ┌─────┴─────┐
        yes           no
          │            │
          ▼            ▼
      respond     ┌──────────────┐
          │       │ Escalate to   │
          │       │ human agent   │
          │       └──────┬───────┘
          │              │ agent answers
          │              ▼
          │       ┌──────────────┐
          └──────▶│ Feedback log  │──▶ KB update / re-embed
                  └──────────────┘
```

- **Data model:**
  - KB chunk `{id, text, embedding, source_doc, version}` — the answer corpus, embedded and indexed.
  - conversation history `{conv_id, turn, role, content, tools_called, confidence, escalated}` — the running context plus the decisions made each turn.
  - escalation log `{conv_id, reason, queued_at, agent_id, resolved_at}` — what the bot couldn't handle and what happened next.
  - feedback log `{conv_id, bot_answer, agent_correction, ts}` — agent edits that become new KB content / golden-set entries.

- **Key components:**
  - Intent classification — routes the turn (in-scope / out-of-scope / chitchat / needs-human); choice: heuristic rules first, LLM only on the ambiguous tail — cheaper, deterministic for the common cases, and the rules double as an audit trail.
  - RAG over KB — retrieves the chunks the answer must be grounded in; choice: hard relevance threshold on the top chunk so an empty/weak retrieval *cannot* reach the generator.
  - Constrained LLM response — generates an answer cited to retrieved chunks only; choice: instruct refuse-if-unsupported and run a no-free-form-privileged-action policy so the bot can't be talked into doing things.
  - Confidence + escalation gate — decides respond vs. hand off; choice: gate on retrieval relevance *and* model self-report, not either alone — self-report is gameable, retrieval score is blind to phrasing.

- **Scale concerns:**
  - At ~10k conversations/day LLM inference cost dominates the bill → cache common Q/A pairs, route easy intents to a cheaper/smaller model, reserve the strong model for the escalation-adjacent tail.
  - At ~100 escalations/day the human agents are the bottleneck, not the bot → priority queue by severity, and have the bot draft a response the agent edits rather than writes from scratch.
  - At ~1M KB chunks retrieval latency and false-recall climb → intent-scoped tiered retrieval (search only the product area the intent implies) instead of one flat index.

- **Eval framing:** Offline: a golden set of resolved tickets, rubric-scored — aptkit *has* a rubric-judge (`/Users/rein/Public/aptkit/packages/agents/rubric-improvement/`, scored against `/Users/rein/Public/aptkit/packages/evals/src/`), which is precisely the offline harness for "was this answer correct, grounded, and on-tone". Online: resolution-rate-without-escalation, CSAT, escalation precision (did escalations actually need a human). Keep an adversarial set: prompt injection, out-of-scope, and known-unanswerable questions — the bot should *refuse*, and refusal is a passing grade.

- **Common failure modes:**
  - Hallucination when the KB is empty — model answers from parametric memory → relevance-threshold gate before the generator; below threshold, escalate, never generate.
  - Prompt injection — user embeds "ignore your instructions" → sanitize input and run no free-form privileged actions; aptkit's tool-allowlist (`runAgentLoop` + tool-policy) is a partial defense here — it bounds *what* the agent can do, not *what it says*.
  - Stale KB — product changed, chunks didn't → re-embed SLA tied to doc edits, version every chunk.
  - Tone drift — answers technically right, brand-wrong → system-prompt persona plus a rubric dimension that scores tone, not just correctness.

- **Applies to this codebase:** `partially`. aptkit has the structural pieces but not assembled as a support product. RAG-over-KB is real (`search-knowledge-base-tool.ts` over the retrieval contracts). Intent classification is real — the query agent (`/Users/rein/Public/aptkit/packages/agents/query/`) does heuristic-plus-LLM intent classification. The rubric-judge gives you offline answer scoring. Episodic conversation memory exists over the retrieval contracts (`/Users/rein/Public/aptkit/packages/memory/`) and maps onto conversation history. The tool-allowlist is a partial injection defense. What's missing: it's a generation/analytics toolkit, not a customer-facing Q&A product — there is no confidence/relevance escalation gate, no human-handoff queue, and no agent-correction feedback loop closing back into the KB.

- **How to make it apply:** Add a confidence/relevance threshold gate to the rag-query agent (`/Users/rein/Public/aptkit/packages/agents/rag-query/`): if the top retrieved chunk's score is below threshold, refuse and emit an escalation event instead of generating. Wire `/Users/rein/Public/aptkit/packages/memory/` in as the conversation-history store so multi-turn context survives. Add an escalation log and a feedback log to buffr's `agents` schema (alongside the existing documents/chunks/conversations/messages tables, store layer at `/Users/rein/Public/buffr/src/pg-vector-store.ts`), and feed agent corrections back as new KB chunks scored by the rubric-judge. The gate is the load-bearing change — everything else is plumbing once a turn can say "I don't know."
