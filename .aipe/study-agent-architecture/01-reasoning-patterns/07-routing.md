# 07 — Routing

*Routing / intent classification / LLM router — Industry standard (router chains;
the "classify then dispatch" pattern).*

## Zoom out, then zoom in

Routing is the one place AptKit lets a model *pick a path* — but read carefully
*what* it picks, because the honest answer is smaller than the name suggests.

```
  Where routing sits, and what it actually controls

  ┌─ Studio / caller ────────────────────────────────────────┐
  │  free-form question                                       │
  └───────────────────────────┬───────────────────────────────┘
                              ▼
  ┌─ ★ ROUTING (query/src/intent.ts) ★ ─────────────────  ← here
  │  parseIntent (heuristic)  +  classifyIntent (LLM)         │
  │  output: an intent STRING ('monitoring'|'diagnostic'|     │
  │          'recommendation')                                │
  └───────────────────────────┬───────────────────────────────┘
                              ▼  feeds the string into ONE agent's prompt
  ┌─ QueryAgent.answer(question, {intent}) ──────────────────┐
  │  same agent runs regardless; the string only BIASES the  │
  │  system prompt                                            │
  └──────────────────────────────────────────────────────────┘
```

Here's the load-bearing honesty for this file: AptKit's router **picks an intent
string, not an agent.** The string is fed into the *query agent's* system prompt
to bias *how* it answers (`query-agent.ts:78-83`). The same `QueryAgent` runs no
matter what the router decides. So this is *classification that tunes a prompt*,
not *dispatch that selects a handler.* The textbook router — "classify, then
route to one of N different agents" — is the bridge case in SECTION C
(`../03-multi-agent-orchestration/`), and AptKit doesn't do that yet.

Frontend anchor: textbook routing is `react-router` — the URL picks *which
component mounts*. AptKit's router is more like passing a `variant="diagnostic"`
prop into one component that's always mounted — same component renders, the prop
just changes its behavior. Know the difference; interviewers probe exactly here.

## Structure pass

Trace the **control axis** — "what does the routing decision actually switch" —
to locate the gap between the name and the reality.

```
  Control axis: what the routed decision switches

  Layer                  Decision switches…              Switches the agent?
  ─────────────────────  ──────────────────────────────  ───────────────────
  textbook router        which of N agents/handlers runs  YES
  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   ─ ─ ─ ─ ─ ◄ SEAM
  AptKit intent router   a STRING in one agent's prompt    NO
```

The seam is whether the decision crosses into *handler selection*. Textbook
routing crosses it; AptKit's stops short — the decision stays inside one agent
as a prompt variable. This is a deliberate, modest design: AptKit only has a
query agent exposed to free-form questions, so there's nothing to dispatch
*to* yet. The router is built to *grow into* dispatch later (the intents already
name the three other agents), but today it tunes a prompt.

## How it works

### Move 1 — the mental model

A router is a cheap classifier in front of expensive work: a small, fast
decision that picks a label, and the label steers what happens next. AptKit
layers two classifiers — a free heuristic first, an LLM fallback — and both emit
the *same* label space.

```
  Routing = cheap classify, then steer on the label

  raw text
     │
     ▼
  ┌─────────────────┐   label    ┌───────────────────────────┐
  │ CLASSIFY        │ ─────────▶ │ STEER on label             │
  │ heuristic, then │            │ (here: inject into prompt; │
  │ LLM fallback    │            │  textbook: pick an agent)  │
  └─────────────────┘            └───────────────────────────┘
```

### Move 2 — the moving parts

**Heuristic-first: `parseIntent`**

```
  raw text ─▶ lowercase ─▶ substring match
     "monitoring" in text? ──▶ 'monitoring'
     "recommendation"?     ──▶ 'recommendation'
     "diagnostic"?         ──▶ 'diagnostic'
     else                  ──▶ 'diagnostic'   (default)
```

Pseudocode: a few `if (text.includes(...))` checks with a default. Zero model
calls, instant, free. This is the cheap fast path — if the word is literally in
the input, you never pay for a model. The default-to-`diagnostic` encodes a
product bet: "why did X happen" is the most common ask.

**LLM fallback: `classifyIntent`**

```
  raw text ─▶ ONE model.complete (maxTokens: 16)
            system: "reply with ONLY one word: monitoring/diagnostic/recommendation"
            ─▶ raw word ─▶ parseIntent(word)   ← reuses the SAME parser
```

Pseudocode: `word = await model.complete({system: classifyPrompt, maxTokens:16});
return parseIntent(word)`. Note `maxTokens: 16` — this is a *deliberately tiny*
call, cents not dollars, because a router must be cheap relative to the work it
gates. And it pipes its output back through `parseIntent`, so the LLM's free-form
word gets normalized by the same substring matcher — one canonical label space,
two ways to reach it.

**Steer: feed the label into the prompt**

```
  intent string ─▶ renderPromptTemplate(prompt, { intent }) ─▶ system prompt
                ─▶ same QueryAgent runs, biased by the string
```

Pseudocode: `system = render(prompt, {intent}); runAgentLoop({system, ...})`.
This is the step that *isn't* dispatch. The string becomes a template variable.
The agent's behavior shifts; the agent itself does not.

### Move 3 — the principle

A good router is cheaper than what it gates and emits one canonical label —
heuristic-first then LLM-fallback gives you free hits with a smart backstop; just
be honest about whether the label switches a *handler* or merely a *prompt*.

## Primary diagram

The two-tier classifier, the shared label space, and the honest stopping point —
the label tunes a prompt, it does not pick an agent.

```
  AptKit routing — two-tier classify, then prompt-bias (NOT dispatch)

  raw question
       │
       ▼
  ┌──────────────┐  match?  yes ─────────────────────┐
  │ parseIntent  │ (free, substring)                  │
  └──────┬───────┘                                    │
         │ no clear match                              │
         ▼                                             ▼
  ┌──────────────┐  word   ┌──────────────┐    intent string
  │ classifyIntent│ ──────▶│ parseIntent  │ ──▶ 'diagnostic' | ...
  │ LLM, 16 tok  │         │ (normalize)  │           │
  └──────────────┘         └──────────────┘           ▼
                                          renderPromptTemplate({intent})
                                                       │
                                                       ▼
                              QueryAgent.answer — SAME agent, biased prompt
                              ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
                              (textbook router would branch to 3 agents HERE)
```

Everything above the dashed line exists; the branch-to-three-agents below it is
SECTION C's job.

## Implementation in codebase

**Use case: a free-form question needs the right *framing* before the query
agent answers it.** "What changed last week" wants a monitoring framing; "why
did revenue drop" wants a diagnostic one. The router picks the framing label.

`packages/agents/query/src/intent.ts:4` — the free heuristic path:

```ts
// intent.ts:4-10 — substring match, zero model calls, defaults to diagnostic
export function parseIntent(raw: string): Intent {
  const text = raw.trim().toLowerCase();
  if (text.includes('monitoring')) return 'monitoring';
  if (text.includes('recommendation')) return 'recommendation';
  if (text.includes('diagnostic')) return 'diagnostic';
  return 'diagnostic';                                  // ← product-bet default
}
```

`intent.ts:12` — the LLM fallback, deliberately tiny, normalized through the
same parser:

```ts
// intent.ts:12-29 — one cheap classify call, output piped back through parseIntent
export async function classifyIntent(model, query, options = {}): Promise<Intent> {
  const response = await model.complete({
    system: 'Classify the user query as exactly one word: monitoring ... diagnostic ... recommendation ... Reply with ONLY the one word.',
    messages: [{ role: 'user', content: query }],
    maxTokens: 16,                                      // ← router must be cheap
    signal: options.signal,
  });
  const text = /* extract text blocks */;
  return parseIntent(text);                             // ← one canonical label space
}
```

Where the label is *used* — and where it stops short of dispatch —
`packages/agents/query/src/query-agent.ts:78-83`:

```ts
// query-agent.ts:78-83 — the intent becomes a PROMPT VARIABLE, not a handler choice
const intent = runOptions.intent ?? 'diagnostic';
const system = renderPromptTemplate(this.prompt, {
  schema: schemaSummary(this.options.workspace),
  project_id: this.options.workspace.projectId,
  intent,                                               // ← biases the prompt; same agent runs
});
```

There is no `if (intent === 'monitoring') return monitoringAgent.scan()` anywhere
— the string only flows into the template. That absence is the whole honest
point of this file.

## Elaborate

**Origin.** Router chains (LangChain's `RouterChain`, `MultiPromptChain`)
formalized "classify the input, then dispatch to the matching sub-chain." The
heuristic-first-then-LLM layering is a standard cost optimization: pay for the
model only when cheap rules can't decide — the same instinct as a cache before a
network call.

**Adjacent concepts.** The textbook *agent* router (classify → run one of N
*agents*) is the bridge to multi-agent orchestration: a supervisor is a router
whose labels are workers (`../03-multi-agent-orchestration/`). AptKit's router is
the *degenerate* case — N=1 agent, the label only tunes its prompt. Semantic
routing (embed the query, nearest-neighbor against labeled exemplars) is the
vector-based cousin; AptKit uses substring + a tiny LLM call instead, which is
cheaper and good enough for three coarse intents.

## Interview defense

**Q: "You said you have routing — does it pick which agent runs?"**

```
  what the label switches, honestly

  AptKit:   label ─▶ prompt variable ─▶ SAME QueryAgent (no handler switch)
  textbook: label ─▶ pick 1 of N agents  (handler switch)
```

Anchor: "It's intent *classification* that biases one agent's prompt — it picks a
string, not an agent; turning it into real dispatch is a SECTION C change, not a
done thing." Saying this unprompted is the credibility move.

**Q: "Why two classifiers instead of just the LLM?"**

```
  parseIntent (free) ─▶ hit?  yes ─▶ done, $0
                          no  ─▶ classifyIntent (LLM, 16 tokens)
```

Anchor: "Heuristic-first means I pay for the model only on ambiguous inputs — a
router has to be cheaper than the work it gates, or it's not worth running."
Surfaces the skeleton part: `classifyIntent` is a *single* `model.complete`
(`intent.ts:17`), not a `runAgentLoop` — routing is a chain step, not an agent
(tie back to `01-chains-vs-agents.md`).

## Validate

- **Reconstruct:** Draw the two-tier classifier and mark where the LLM output is
  re-normalized (`intent.ts:28`, `return parseIntent(text)`).
- **Explain:** Why is `classifyIntent` a chain step, not an agent? (one
  `model.complete`, `maxTokens:16`, no loop, no tools — `intent.ts:12-23`.)
- **Apply:** You want routing to actually run different agents. What's the
  minimal change and where? (replace the prompt-variable injection at
  `query-agent.ts:80-83` with a switch dispatching to `scan`/`investigate`/
  `propose` — i.e., promote the label from prompt-var to handler-selector;
  that's the SECTION C supervisor.)
- **Defend:** A reviewer says "you don't really have routing." Concede the
  precise sense and defend what *is* there. (concede: no agent dispatch; defend:
  a real two-tier cost-tiered intent classifier with one canonical label space,
  built to grow into dispatch — `intent.ts:4,12`.)

## See also

- [01-chains-vs-agents.md](01-chains-vs-agents.md) — why `classifyIntent` is a
  chain step, not an agent
- [02-agent-loop-skeleton.md](02-agent-loop-skeleton.md) — the agent the routed
  string feeds into
- `../03-multi-agent-orchestration/` — where routing grows up into a supervisor
  that picks an *agent* (the dispatch this file stops short of)
- `.aipe/study-prompt-engineering/` — how the injected `intent` string shapes the
  query agent's system prompt
