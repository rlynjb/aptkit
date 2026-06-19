# 01 — Multi-Agent Research Assistant

> The fan-out + synthesis template. When the interviewer wants "deep research,"
> they want one supervisor splitting a question into independent sub-questions,
> many workers chasing them in parallel, and one merge step that produces a
> cited answer. AptKit has the worker half (agentic retrieval) and none of the
> coordination half.

---

- **The prompt:**
  "Design a system that answers a complex research question by gathering from
  multiple sources and synthesizing."

- **Standard architecture:**
  A supervisor decomposes the question into independent sub-questions, fans them
  out to parallel worker agents — each doing agentic RAG (tool-calling
  retrieval, not a single embedding lookup) over one source — and then
  synthesizes the workers' findings into a single answer with citations. The
  workers are independent because the sub-questions are independent; that
  independence is what makes parallelism safe and what justifies multi-agent at
  all.

  ```
    Fan-out + synthesis: research assistant

                       ┌──────────────────────┐
        question ─────▶│      Supervisor      │
                       │  decompose into N    │
                       │  independent subqs   │
                       └──────────┬───────────┘
                  fan-out (parallel, no shared state)
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
     ┌────────────┐        ┌────────────┐        ┌────────────┐
     │  Worker A  │        │  Worker B  │        │  Worker C  │
     │ agentic RAG│        │ agentic RAG│        │ agentic RAG│
     │  source 1  │        │  source 2  │        │  source 3  │
     └─────┬──────┘        └─────┬──────┘        └─────┬──────┘
           │ findings + cites    │                     │
           └─────────────────────┼─────────────────────┘
                                 ▼
                       ┌──────────────────────┐
                       │      Supervisor      │
                       │  synthesize answer   │
                       │  with citations      │──────▶ answer + provenance
                       └──────────────────────┘
  ```

- **Data model:**
  A `Question`, a list of `SubQuestion`s (each tagged with the source/tool scope
  it should hit), per-worker `Finding`s carrying the claim plus its provenance
  (which source, which tool call, which row), and a final `Answer` that holds the
  synthesized text plus the citation list assembled from the findings.
  Provenance must survive the whole way through — a synthesis step that drops the
  source links is the most common way these systems lose trust.

- **Key components:**
  - **Decomposer** — splits the question into independent sub-questions.
    *Decision: how independent are the sub-questions?* If they actually depend on
    each other, you don't have fan-out, you have a pipeline, and parallelism is a
    lie. Decompose only along genuine independence.
  - **Worker agent** — a bounded ReAct loop doing agentic retrieval over one
    source. *Decision: what's each worker's tool scope?* Scoping each worker to a
    source family is what keeps its context small and its retrieval focused.
  - **Synthesizer** — merges findings, resolves conflicts, attaches citations.
    *Decision: what happens when two workers disagree?* You need an explicit
    conflict policy (prefer-recent, prefer-authoritative, surface-both), not
    whatever the model happens to do.
  - **Provenance tracker** — carries source links from tool result to citation.

- **Scale concerns:**
  Fan-out multiplies token cost linearly with worker count; the synthesis context
  grows with the *sum* of all worker findings and can blow the context window
  faster than any single worker. Parallel workers also multiply provider
  rate-limit pressure and tail latency (you wait for the slowest worker). Past a
  point, more workers add noise the synthesizer must filter, not signal.

- **Eval framing:**
  Score the final answer for faithfulness (every claim traceable to a cited
  source) and completeness (did it cover the sub-questions). Eval the decomposer
  separately — bad decomposition poisons everything downstream — and eval each
  worker's retrieval in isolation against a fixed source. A replay harness that
  pins each worker's tool results makes the whole fan-out deterministic and
  testable.

- **Common failure modes:**
  Over-decomposition (splitting a simple question into N redundant workers that
  all retrieve the same thing); lost provenance (synthesis produces fluent text
  with no traceable citations); synthesis context overflow; one worker's
  hallucination contaminating the merged answer with no way to attribute it;
  workers with overlapping scope doing duplicate work.

- **Applies to this codebase:** **Partially.**
  AptKit's query agent (`packages/agents/query/src/query-agent.ts:75`,
  `.answer(question, { intent })`) is a single-agent agentic-retrieval loop over
  ~35 read-only analytics tools — that is exactly *one worker*, over *one source
  family*. It does the agentic-RAG half well: it tool-calls against analytics
  APIs (not vector retrieval — there are no embeddings or vector DB in this repo)
  inside the bounded `runAgentLoop`. What's missing is the entire coordination
  layer: there is no supervisor decomposing the question, no fan-out to parallel
  workers, and no citations/provenance attached to the answer. So the worker
  primitive exists; the research-assistant *topology* does not.

- **How to make it apply:**
  Add a supervisor capability that decomposes a question into sub-questions, then
  fans out multiple `QueryAgent` instances each scoped to a different tool subset,
  and merges their answers with provenance. The seam that makes this cheap is
  already in place: `filterToolsForPolicy` in
  `packages/tools/src/tool-policy.ts:11` scopes the tool catalog per capability
  via an allowlist, so each fan-out worker is just a `QueryAgent` constructed with
  a narrower `ToolPolicy` (e.g. revenue tools vs. retention tools vs. acquisition
  tools). The query agent already returns text; the real work is (1) the
  decomposer prompt, (2) threading source provenance through tool results into
  citations — the `CapabilityEvent` trace
  (`packages/runtime/src/events.ts`, `tool_call_start`/`tool_call_end`) already
  records which tool produced which result, so the provenance data exists and
  just needs to be carried into the answer. See
  [03 — Sequential Pipeline](../03-multi-agent-orchestration/03-sequential-pipeline.md)
  and [01 — When NOT to Go Multi-Agent](../03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md)
  for why this repo deliberately stayed single-agent.
