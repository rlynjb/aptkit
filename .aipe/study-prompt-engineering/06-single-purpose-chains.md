# 06 — Single-purpose chains

**Subtitle:** single-purpose chains — one capability, one job, composed
(Language-agnostic)

## Zoom out, then zoom in

One chain, one job. aptkit's organizing unit is the *capability* — a prompt
package + tool policy + loop config + validator, each owning exactly one
job: classify intent, answer a query, monitor anomalies, diagnose, recommend,
RAG-answer. Compose them into longer flows, but never load two jobs into one
prompt.

```
  Zoom out — capabilities as single-job units

  ┌─ Capability registry (each = ONE job) ──────────────────────┐
  │  ★ intent classifier   → one word out                        │ ← we are here
  │  ★ query agent         → prose answer over read-only tools    │
  │  ★ anomaly-monitoring  → severity-sorted anomalies            │
  │  ★ diagnostic          → one tested Diagnosis                 │
  │  ★ recommendation      → ≤3 grounded recommendations          │
  │  ★ rag-query           → cited answer from the knowledge base  │
  └───────────────────────────┬──────────────────────────────────┘
                              │ composed
  ┌─ Flow ────────────────────▼───────────────────────────────────┐
  │  classify intent → query agent (framed by that intent)        │
  └────────────────────────────────────────────────────────────────┘
```

Zooming in: a single-purpose chain is the pipeline pattern — each stage does
one transformation, and stages compose. The payoff is debuggability (you
know exactly which stage failed), model-routing (a tiny model for the
classifier, a bigger one for generation), and cheap iteration (you tune one
prompt without disturbing the others).

## Structure pass

**Layers.** Capability (one job) → flow (capabilities composed) →
observability (each stage's events tagged with its own capabilityId).

**Axis — when a flow produces a bad answer, which stage do you blame?**
Trace it:

```
  Axis: "where did this failure originate?"

  one mega-prompt doing 3 jobs → UNKNOWN (could be any of the 3)   ✗
  classify intent (one job)    → check the one-word output         ✓
  query agent (one job)        → check the tool calls + final text  ✓
  each stage = its own capId   → trace events pinpoint the stage    ✓
```

**Seam.** The boundary between stages is the load-bearing one. Because each
stage has its own `capabilityId`, its own tool policy, and its own
validator, the seam between them is a clean contract — one stage's output is
the next stage's input, and a failure is localized to one side of the seam.

## How it works

You already build pipelines this way in a frontend: a `.map().filter().reduce()`
chain where each step does one transform, and when the result is wrong you
know which step to inspect. A single-purpose chain is that, with each step a
model call. Let's walk it.

### Step 1 — the smallest possible job: the intent classifier

The cleanest example in the repo does exactly one thing — turn a query into
one of three words:

```ts
// packages/agents/query/src/intent.ts:17
const response = await model.complete({
  system: 'Classify the user query as exactly one word: monitoring ... ' +
          'diagnostic ... or recommendation ... Reply with ONLY the one word.',
  messages: [{ role: 'user', content: query }],
  maxTokens: 16,                          // ← one job, tiny budget
  signal: options.signal,
});
return parseIntent(text);                 // ← robust parse: substring match
```

One job, 16-token budget, a forgiving parser (`parseIntent` substring-matches
and defaults to `diagnostic`). This is a chain you can hand to the smallest,
cheapest model you have — it doesn't need a frontier model to pick one of
three words. That's the model-routing payoff in one function.

### Step 2 — compose: classifier feeds the query agent

The classifier's output frames the next stage. The query agent takes the
intent and threads it into its prompt:

```ts
// packages/agents/query/src/query-agent.ts:78
const intent = runOptions.intent ?? 'diagnostic';   // from the classifier
const system = renderPromptTemplate(this.prompt, { schema, project_id, intent });
```

```
  Pattern — two single-purpose stages composed

  ┌─ stage 1: classify ──┐  one word   ┌─ stage 2: answer ────────┐
  │ tiny model           │ ──────────► │ bigger model + tools      │
  │ system: "one word"   │  "diagnostic"│ system framed by intent  │
  │ maxTokens: 16        │             │ maxTurns: 8, maxToolCalls:6│
  └──────────────────────┘             └───────────────────────────┘
   each stage: own prompt, own budget, own failure surface
```

The query agent's prompt even says what to do with the framing: "Use that
classification to frame your answer, but answer the actual question"
(`query.ts:26`). One job per stage; the seam between them is a single typed
value (the `Intent`).

### Step 3 — each capability carries its own least-privilege policy

Single-purpose isn't just about the prompt — it's about the *grant*. The
RAG-query agent may only search the knowledge base:

```ts
// packages/agents/rag-query/src/rag-query-agent.ts:15
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   // ← exactly one tool
};
```

The query agent gets a broad read-only allowlist (`query-agent.ts:10`); the
RAG agent gets one tool. The tool policy *is* the job boundary expressed as a
capability grant. A stage can't reach outside its job because it has no tool
to do so. That's the debugging-and-blast-radius payoff: a stage that
misbehaves can only misbehave within its grant.

### Step 4 — the failure mode of multi-purpose chains

What you're avoiding: the mega-prompt that classifies *and* queries *and*
recommends in one call. Three problems, each concrete:

- **Brittleness.** One instruction added for the recommend job perturbs the
  classify job — the "add one more instruction" drift from concept 1, now
  three-way entangled.
- **Expensive failures.** When the combined output is wrong, you re-run the
  whole expensive call to debug, and you can't tell which job failed.
- **Harder iteration.** You can't tune the classifier without risking the
  recommender — there's no seam to isolate against.

The single-purpose decomposition pays for itself the first time a flow
breaks and you can point at exactly one stage.

### The principle

**Decompose by job, compose by contract.** Each stage owns one
transformation, one prompt, one budget, one tool grant — and the seam
between stages is a typed value, not a tangle. This is the same instinct
that makes you write small pure functions instead of one 300-line one: the
failure surface shrinks to one stage, and you can route, test, and iterate
each independently.

## Primary diagram

The capability unit and a composed flow, every boundary labelled.

```
  Single-purpose chains in aptkit

  capability = prompt package + tool policy + loop config + validator
  ┌──────────────────────────────────────────────────────────────┐
  │ ONE capability, ONE job:                                       │
  │   intent classifier  → Intent (one word)   tools: none, mt:16  │
  │   query agent        → prose answer         tools: read-only   │
  │   rag-query          → cited answer         tools: search only │
  │   diagnostic         → Diagnosis            validator-gated    │
  │   recommendation     → ≤3 recs              validator-gated    │
  └────────────────────────────┬──────────────────────────────────┘
        composed by typed contract │
  ┌─ Flow ────────────────────▼───────────────────────────────────┐
  │  classifyIntent(q) ──Intent──► QueryAgent.answer(q, {intent})  │
  │  each stage: own capabilityId on every trace event            │
  └────────────────────────────────────────────────────────────────┘
   failure localizes to ONE stage; each stage routes to its own model
```

## Elaborate

The pipeline-of-single-purpose-stages pattern is the spine of LangChain's
"chain" abstraction and every production agent system that survived past a
demo. The transferable lesson is the same one from microservices and from
Unix pipes: a component that does one thing is testable, replaceable, and
debuggable; a component that does five is none of those.

aptkit's specific encoding — capability = prompt + policy + loop + validator
— ties the single-purpose principle to least-privilege security (concept 12,
and study-security). The tool policy is the job boundary *and* the trust
boundary at once. The model-routing payoff connects to token budgeting
(concept 4): a one-word classifier on a tiny local model costs almost
nothing, freeing budget for the generation stage that needs it.

## Interview defense

**Q: Why decompose an agent into single-purpose chains instead of one
prompt?**

Three concrete payoffs. Debuggability: when a flow fails you know which stage
failed, because each stage has its own capabilityId, prompt, and validator.
Model-routing: a tiny model classifies, a big model generates — you don't pay
frontier prices for picking one of three words. Iteration: you tune one
prompt without perturbing the others, because the seam between stages is a
typed value, not a tangled mega-prompt.

```
  mega-prompt: 3 jobs → fail → which job? unknown → re-run all
  3 chains:    fail → that stage's capId in the trace → fix one
```

Anchor: "aptkit's unit is capability = prompt + tool policy + loop +
validator. The intent classifier is one word out, 16-token budget,
tiny-model-routable; the query agent it feeds is a separate capability."

**Q: What's the failure mode you're avoiding?**

The multi-purpose chain: brittle (one job's instruction perturbs another),
expensive to debug (re-run the whole call, can't localize the failure), and
hard to iterate (can't tune one job without risking the rest). The fix is
one job per capability with a typed contract at the seam.

Anchor: "Add-one-instruction drift, three-way entangled — the seam between
stages is what you give up by merging them."

## See also

- [01-anatomy.md](01-anatomy.md) — the add-one-instruction drift, now
  multiplied across jobs
- [03-prompts-as-code.md](03-prompts-as-code.md) — the capability unit
- [07-output-mode-mismatch.md](07-output-mode-mismatch.md) — the contract at
  the seam between stages
- study-agent-architecture — multi-agent orchestration of these capabilities
