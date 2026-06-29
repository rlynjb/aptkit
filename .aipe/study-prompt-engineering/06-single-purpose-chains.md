# 06 — Single-purpose chains

**Industry name:** prompt chaining / pipeline decomposition — *Industry standard*

## Zoom out, then zoom in

The multi-purpose prompt — "classify the intent AND answer the question AND
suggest next steps" — is the prompt that's impossible to debug. When it fails you
can't tell *which* job failed, and when you fix one job you regress another.
**One chain, one job, composed into longer flows.** That's the pattern, and
aptkit is built almost entirely out of it: each agent is one capability with one
job, one prompt package, one tool policy.

```
  Zoom out — the agents as single-purpose chains

  ┌─ Capability layer (each = one job) ───────────────────────┐
  │  classifyIntent   → one word: monitoring/diagnostic/rec   │ ← we are here
  │  monitoring-agent → detect anomalies (no diagnosis)       │
  │  diagnostic-agent → one anomaly → cause (no remediation)  │
  │  recommendation-agent → diagnosis → ≤3 actions            │
  │  rag-query-agent  → question → grounded answer            │
  └───────────────────────────┬────────────────────────────────┘
                              │  each composes ↓
  ┌─ Shared runtime ──────────▼────────────────────────────────┐
  │  runAgentLoop + tool policy + validator                     │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the strongest evidence is the *pipeline* — monitoring → diagnostic →
recommendation is three single-purpose agents chained, and each one's prompt
refuses to do the next one's job ("Do not diagnose causes. Do not propose
actions." — `monitoring.ts`).

## The structure pass

**Layers:** the pipeline (fixed order of chains) → each chain (one prompt, one
job) → the loop (the chain's internal tool calls).

**Axis — what is this chain's single job?** Trace it and the boundaries pop:

```
  Axis: "what is the one job?" — across the pipeline

  ┌──────────────────────────────┐
  │ monitoring-agent             │  → DETECT (and only detect)
  └──────────────────────────────┘
      ┌──────────────────────────┐
      │ diagnostic-agent         │  → EXPLAIN one anomaly (no fix)
      └──────────────────────────┘
          ┌──────────────────────┐
          │ recommendation-agent │  → PROPOSE actions (read-only)
          └──────────────────────┘

  each chain refuses the next chain's job — that refusal IS the boundary
```

**Seam:** the typed handoff between chains. The diagnostic agent takes an
`{anomaly}` (`diagnostic.ts:14`); the recommendation agent takes a `{diagnosis}`
(`recommendation.ts:38`). The output of one chain is the typed input of the next.
**What breaks if a chain does two jobs:** the seam disappears, the handoff is
implicit, and a failure anywhere in the blob is unattributable.

## How it works

### Move 1 — the mental model

You already build pipelines this way in code: small pure functions composed, not
one 500-line function. Each function has one responsibility; you test them
independently; when the pipeline breaks you know which function. A single-purpose
chain is that, with a model in each box.

```
  Pattern — the chain pipeline

  query ──► [classifyIntent] ──► intent
                                   │
  question + intent ──► [query-agent] ──► answer

  anomaly ──► [diagnostic] ──► diagnosis ──► [recommendation] ──► actions
            one job          typed handoff   one job
```

### Move 2 — walking the chains

**The classifier is the purest single-purpose chain.** `classifyIntent`
(`query/src/intent.ts:12`) does exactly one thing: map a query to one of three
words. Its entire system prompt is *"Classify the user query as exactly one word…
Reply with ONLY the one word"* and `maxTokens: 16` (`:22`). **What breaks if you
fold this into the query agent:** you can no longer route on intent before
answering, and you can't swap a cheap model in for just the classification.

**Each agent declares its job in its prompt and refuses the others.** The
diagnostic prompt: *"You do not propose remediation"* (`diagnostic.ts:5`). The
monitoring prompt: *"Do not diagnose causes. Do not propose actions."* The
recommendation prompt: *"You are read-only: you do NOT execute anything"*
(`recommendation.ts:3`). These refusals are the chain boundaries written into the
prompt itself.

**Model routing falls out for free.** Because the classifier is its own chain,
you can run it on a small/cheap model (it returns one word) and reserve a larger
model for generation. The provider seam (`ModelProvider`) makes this a per-chain
choice. **The debugging benefit:** when the pipeline produces a bad recommendation,
you replay the diagnostic artifact in isolation and know immediately whether the
fault was detection, diagnosis, or recommendation.

### Move 3 — the principle

**A chain that does one job can be tested, replayed, routed, and debugged in
isolation; a chain that does three cannot.** The cost of a multi-purpose prompt
isn't paid at write time — it's paid every time it fails and you can't tell which
of its jobs broke. Decompose until each chain has a name you could put on a
function.

## Primary diagram

```
  Single-purpose chains — the analytics pipeline

  WORKSPACE
     │
     ▼
  [monitoring-agent]  job: DETECT      → anomalies[]   (no diagnosis)
     │ pick one anomaly
     ▼
  [diagnostic-agent]  job: EXPLAIN     → diagnosis     (no remediation)
     │ typed handoff {diagnosis}
     ▼
  [recommendation-agent] job: PROPOSE  → ≤3 actions    (read-only)

  each box: one PromptPackage + one toolPolicy + one validator + runAgentLoop
```

## Elaborate

Prompt chaining is the oldest production-LLM pattern (it predates tool calling)
and survives because of debuggability, not capability. The Anthropic prompt guide
calls it "prompt chaining" and recommends it for exactly the reason here: smaller
prompts are more reliable and individually testable. The model-routing payoff
(cheap model for classification, expensive for generation) is the cost lever — in
this repo enabled by the `ModelProvider` swap seam, though the cost-optimal
per-chain model assignment is a config choice the agents leave to the host.

## Interview defense

**Q: Why chain single-purpose prompts instead of one capable prompt?** Debuggability
and routing. When a single-purpose chain fails you know which job failed and can
replay it in isolation; you can also route a cheap model to the cheap job. A
multi-purpose prompt makes failures unattributable and forces one model on every
job.

```
  [detect] → [explain] → [propose]   each refuses the next's job
   replay any box alone · route a model per box
```
*Anchor: `classifyIntent` (`intent.ts:12`); the "do not diagnose/propose"
refusals in `monitoring.ts` / `diagnostic.ts:5`.*

**Q: The part people forget?** The **typed handoff** between chains. The chain
boundary is only real if the output of one is the validated input of the next
(`{anomaly}` → `{diagnosis}`). Without it you've split the prompt but kept the
implicit coupling.

## See also

- `01-anatomy.md` — each chain's prompt has the same four-section anatomy.
- `07-output-mode-mismatch.md` — the typed handoff is where mode mismatches bite.
- `04-token-budgeting.md` — small models for classifier chains save tokens.
- `../study-agent-architecture/` — multi-agent orchestration at depth.
