# Heuristic before LLM — cheap deterministic check before you pay

**Industry names:** routing, pre-filtering, fast-path / cascade, heuristic gate · *Industry standard*

## Zoom out, then zoom in

The cheapest model call is the one you never make. Before AptKit spends tokens, it
runs deterministic string-and-set logic that can either answer outright or prune
work that can't succeed. Two such gates exist in the repo, and both sit *in front*
of the model. Here's where they live.

```
  Zoom out — the gates in front of the model

  ┌─ Agent entry ───────────────────────────────────────────────────┐
  │  query / monitoring request arrives                              │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │
  ┌─ Heuristic gates (deterministic, FREE) ─▼──────────────────────────┐
  │  ★ parseIntent: string-match the intent  ★  ←── THIS CONCEPT       │
  │  ★ runnableRequirements: drop impossible tasks ★                   │
  └───────────────────────────────┬──────────────────────────────────┘
              answered / pruned ───┤─── still ambiguous / runnable
                  │                              │
                  ▼                              ▼ only now…
            (no model call)              ┌─ LLM call (PAID) ──────────┐
                                         │ classifyIntent / agent loop│
                                         └─────────────────────────────┘
```

Zoom in: the pattern is a cascade — try the cheap deterministic check first, fall
through to the expensive LLM only when the cheap check can't decide. AptKit does
this two ways: `parseIntent` is a pure string-match classifier that maps a query
to one of three intents (and only calls the LLM `classifyIntent` as a fallback);
`runnableRequirements` is a set-membership gate that drops tasks the workspace
*can't* support before any agent spends a token on them.

## Structure pass

**Layers.** Two, by cost. The *free layer* (deterministic: string `includes`, set
membership) and the *paid layer* (an LLM call). The free layer runs first and
tries to make the paid layer unnecessary.

**Axis — cost: what does each decision cost?** Trace it. `parseIntent`: a few
`String.includes` calls — effectively free, microseconds. `classifyIntent`: a
network round-trip plus tokens — the fallback you pay for. `runnableRequirements`:
set lookups — free. The agent loop it gates: many model calls — the most
expensive thing in the system. Every gate's job is to keep the cost axis on the
free side as long as it honestly can.

**Seam.** The seam is the fall-through point: `parseIntent` *is* the parser
`classifyIntent` falls back through (the LLM's one-word answer is itself run
through `parseIntent`), and `runnableRequirements` is the filter the agent loop
runs behind. On the cheap side: deterministic, repeatable, free. On the paid
side: the model. The gate decides which side you land on.

## How it works

You've short-circuited an expensive function with a cache check or a cheap guard:
`if (cache.has(key)) return cache.get(key)` before the slow path. A heuristic gate
is the same move applied to an LLM — a fast deterministic check that either
answers or prunes before the paid call.

### Move 1 — the mental model

The cascade: cheap check first, expensive call only on fall-through. The cheap
check is deterministic, so its decisions are free and repeatable.

```
  The cascade — cheap first, pay only on fall-through

  query ─► parseIntent (string match)
              │
        matched a keyword? ── yes ──► return intent   (FREE, done)
              │ no clear match
              ▼
        classifyIntent (LLM, one word)   (PAID — only reached on fall-through)
              │
              ▼
        parseIntent(llm output)          (the LLM's word, re-parsed)
              │
              ▼
        return intent (default: diagnostic on anything unrecognized)
```

The key property: the cheap layer and the expensive layer share the *same output
type* (an `Intent`). `parseIntent` produces it directly *and* normalizes the LLM's
answer into it — so the LLM is just a smarter `parseIntent` for the cases the
string match can't handle.

### Move 2 — the step-by-step walkthrough

#### Gate 1: parseIntent — string match, with a safe default

`parseIntent` lowercases the input and checks for known keywords in priority
order. If it finds `'monitoring'`, `'recommendation'`, or `'diagnostic'`, it
returns that intent. Otherwise it returns `'diagnostic'` — the safe default.

```
  parseIntent — match or default (execution trace)

  "show me what changed (monitoring)"  → includes 'monitoring'   → monitoring
  "what should I do here?"             → no keyword match        → diagnostic ←default
  "RECOMMENDATION please"             → lowercased → 'recommendation' → recommendation
  "why did checkout drop?"            → no keyword match        → diagnostic ←default
```

The boundary condition is the default at the bottom: **on ambiguity, default to
diagnostic.** That's a deliberate choice — diagnostic ("why did something happen")
is the most general lane, so an unrecognized query degrades to the broadest
analysis rather than guessing a narrow one. The same default catches a garbled LLM
response, which is why the LLM path is safe even when the model misbehaves.

#### The LLM fallback shares the parser

`classifyIntent` is the paid path — but it's deliberately *tiny*: `maxTokens: 16`
and a system prompt that says "reply with ONLY one word." Its output isn't trusted
raw; it's fed straight back through `parseIntent`. So the model classifies, and
the same cheap string-match normalizes its word into the typed `Intent` (and
defaults to diagnostic if the model said something off-script).

```
  classifyIntent — the cheap parser wraps the paid call (layers-and-hops)

  ┌─ caller ──┐  query   ┌─ classifyIntent (PAID) ──────┐
  │           │ ───────► │ model.complete({             │
  │           │          │   system: "one word only",   │
  │           │          │   maxTokens: 16 })            │  ← bounded spend
  │           │◄──────── │ → "monitoring"               │
  └───────────┘  Intent  └───────────┬──────────────────┘
                                     │ parseIntent(word)   ← cheap layer again
                                     ▼
                              typed Intent (default diagnostic)
```

`maxTokens: 16` is the cost discipline: even when you pay, you pay almost nothing
— a one-word classification can't run up a long, expensive completion.

#### Gate 2: runnableRequirements — prune the impossible before paying

The other gate is a pre-model filter on *tasks*. Some tasks require workspace
capabilities (specific events, properties, catalogs) that a given workspace may
not have. `runnableRequirements` keeps only the tasks whose required capabilities
are all present — dropping the `'unavailable'` ones — *before* the agent spends
model tokens trying to run them.

```
  runnableRequirements — set-membership prune (pseudocode)

  capabilities = set of available tokens   // event names, props, catalogs
  return requirements.filter(req =>
    requirementCoverage(req, capabilities) !== 'unavailable')
  // requirementCoverage: every req.requires ∈ capabilities ? (full|limited) : unavailable
```

The point: there is no reason to send a model on a task whose data simply isn't
there. Filtering it out deterministically — pure set lookups — means the model is
only ever asked to do things that *could* succeed. The anomaly monitor uses this
to drop ecommerce categories the workspace can't cover before it scans.

### Move 3 — the principle

Don't pay the LLM for a decision a string match or a set lookup can make. The
model is the most expensive and least deterministic component you have; put cheap,
deterministic logic in front of it to answer the easy cases and prune the
impossible ones, and route to the model only what genuinely needs its judgment.
Two design tells make AptKit's gates good: the cheap and expensive layers share an
output type (so the model is a drop-in for the hard cases), and ambiguity has a
safe default (so a fall-through never crashes — it degrades).

## Primary diagram

The full two-gate picture, free layer in front of paid layer.

```
  Heuristic-before-LLM — both gates

  ┌─ Gate 1: intent routing (per query) ─────────────────────────────┐
  │  parseIntent(query)  — String.includes, lowercased               │
  │     match? ── yes ──► Intent  (FREE)                              │
  │     no ──► classifyIntent  (PAID, maxTokens:16, "one word")       │
  │              └─► parseIntent(word) ─► Intent (default: diagnostic)│
  └───────────────────────────────────────────────────────────────────┘

  ┌─ Gate 2: task coverage (before the agent loop) ──────────────────┐
  │  runnableRequirements(tasks, capabilities)  — set membership      │
  │     keep tasks whose required capabilities are present            │
  │     drop 'unavailable' ─► model never sees impossible tasks       │
  └───────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼  only runnable, routed work reaches…
                          ┌─ the agent loop (PAID, many calls) ─┐
                          └──────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** `parseIntent` routes a free-form query into one of three agent
lanes before the query agent runs; `classifyIntent` is the paid fallback when a
caller wants the model to decide. `runnableRequirements` is used by the anomaly
monitor (`categories.ts`) to drop ecommerce categories the workspace can't cover,
so the monitoring agent never spends a model call on a category whose data is
absent.

**Gate 1, the free path**, `packages/agents/query/src/intent.ts:4-10`:

```
  packages/agents/query/src/intent.ts  (lines 4-10)

  export function parseIntent(raw: string): Intent {
    const text = raw.trim().toLowerCase();
    if (text.includes('monitoring'))      return 'monitoring';
    if (text.includes('recommendation'))  return 'recommendation';
    if (text.includes('diagnostic'))      return 'diagnostic';
    return 'diagnostic';                  ← DEFAULT on ambiguity (deliberate)
  }
       │
       └─ Three string checks and a default. Costs microseconds, no network.
          The final 'diagnostic' is the safe lane — an unrecognized query
          degrades to the broadest analysis rather than a wrong guess.
```

**Gate 1, the paid fallback**, `packages/agents/query/src/intent.ts:12-28`:

```
  packages/agents/query/src/intent.ts  (lines 17-28)

  const response = await model.complete({
    system: 'Classify the user query as exactly one word: monitoring …'
          + ' Reply with ONLY the one word.',
    messages: [{ role: 'user', content: query }],
    maxTokens: 16,                        ← cost cap: a one-word answer
  });
  …
  return parseIntent(text);               ← the LLM's word, re-parsed (and
                                            defaulted) by the SAME cheap fn
       │
       └─ Even the paid path is cheap (16 tokens) and its output is
          normalized by parseIntent — so the model is just a smarter
          string-matcher for the cases includes() can't resolve.
```

**Gate 2, the coverage prune**, `packages/tools/src/coverage-gate.ts:73-78`:

```
  packages/tools/src/coverage-gate.ts  (lines 73-78)

  export function runnableRequirements<T extends CoverageRequirement>(
    requirements: readonly T[],
    capabilities: ReadonlySet<string>,
  ): T[] {
    return requirements.filter((requirement) =>
      requirementCoverage(requirement, capabilities) !== 'unavailable');
  }
       │
       └─ Pure set membership (requirementCoverage checks every required
          token ∈ capabilities). Drops impossible tasks BEFORE the agent
          loop spends a single model token on them.
```

The anomaly monitor reaches for it at
`packages/agents/anomaly-monitoring/src/categories.ts:118` (`runnableCategories`),
filtering ecommerce categories down to the runnable set before scanning.

## Elaborate

This is the cascade / fast-path pattern: a cheap classifier or filter in front of
an expensive one, where the cheap stage handles the easy majority and only the
residual reaches the expensive stage. In LLM systems it shows up as routing (cheap
model or rules decide which expensive model or tool to invoke) and as
pre-filtering (drop work that can't succeed). The economic logic is the same as a
cache or a `WHERE` clause that runs before an expensive join: do the cheap
elimination first.

AptKit's two gates illustrate the two flavors. `parseIntent`/`classifyIntent` is
*routing* — same output type at both stages, model as fallback. `runnableRequirements`
is *pruning* — eliminate impossible work so the model's budget is spent only on
viable tasks. Both share the discipline that the cheap stage is deterministic
(repeatable, free, testable without a model) and the expensive stage is the one
you'd rather not reach. The safe-default rule (`diagnostic` on ambiguity) is the
detail that makes the routing robust: a heuristic that can't classify must
degrade, not throw.

Adjacent: the agent loop that runs behind these gates
(`../04-agents-and-tool-use/03-react-pattern.md`); the tool-policy allowlist that
*also* sits in front of the model, scoping which tools it can see
(`08-provider-abstraction.md` touches the same `packages/tools` boundary);
temperature on the classifier (`03-sampling-parameters.md` — the classifier wants
temperature 0). Prompt design for the one-word classifier is prompt-engineering
territory (`.aipe/study-prompt-engineering/`, *not yet generated*).

## Project exercises

*Provenance: Phase 1 — LLM foundations (C1.x). No `aieng-curriculum.md` present;
IDs are by-phase convention. Case A — both gates exist; these sharpen them.*

### Exercise — confidence-aware intent routing

- **Exercise ID:** `[C1.8]` Phase 1, heuristic-before-LLM
- **What to build:** Make `parseIntent` return a confidence signal (e.g. exact
  keyword hit = high, no match = low). Only fall through to `classifyIntent` when
  confidence is low, and skip the LLM entirely on a high-confidence keyword hit —
  making the cheap-first cascade explicit rather than caller-driven.
- **Why it earns its place:** It turns an implicit cascade into an explicit one
  and surfaces the cost decision ("when is the LLM worth paying for?") as code, not
  convention — exactly the routing judgment interviews probe.
- **Files to touch:** `packages/agents/query/src/intent.ts`,
  `packages/agents/query/test/intent.test.ts`.
- **Done when:** A test shows a query containing `'monitoring'` resolves without
  any model call, and an ambiguous query triggers the fallback.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: How do you keep LLM costs down on routing decisions?**
"Cheap-first cascade. I'd sketch it:"

```
  query ─► string-match ── hit ──► intent  (FREE)
                        └ miss ──► LLM (16 tokens) ─► re-parse ─► intent
```

"`parseIntent` in `intent.ts:4` is three `String.includes` checks plus a safe
default — free and deterministic. Only when it can't decide do we call
`classifyIntent`, and even that is capped at `maxTokens: 16` with a 'one word
only' prompt. The LLM's answer goes back through `parseIntent`, so the model is
just a smarter string-matcher for the hard cases."
*Anchor: the cheapest model call is the one you never make.*

**Q: What stops an agent from burning tokens on a task it can't possibly do?**
"A coverage gate in front of the loop. `runnableRequirements` in
`coverage-gate.ts:73` filters tasks by set membership — every required capability
must be present in the workspace — and drops the `'unavailable'` ones before the
agent loop runs. The anomaly monitor uses it to prune categories the workspace
can't cover. Deterministic prune, then pay." *Anchor: don't pay the model to
attempt the impossible — eliminate it for free first.*

## Validate

- **Reconstruct:** Write `parseIntent` from memory — the three checks and the
  default. Check `packages/agents/query/src/intent.ts:4-10`.
- **Explain:** Why does `classifyIntent` run its own output back through
  `parseIntent`? (To normalize a free-text model answer into the typed `Intent`
  and apply the same safe default if the model went off-script —
  `intent.ts:28`.)
- **Apply:** A query reads "why did revenue dip last week?" — no intent keyword.
  Where does it land, and at what cost? (No keyword → `parseIntent` returns
  `'diagnostic'` for free; the LLM is only invoked if the caller explicitly calls
  `classifyIntent`. `intent.ts:9`.)
- **Defend:** Why prune tasks with `runnableRequirements` before the loop instead
  of letting the model discover the data is missing? (The model would spend tool
  calls and tokens failing; a set-membership prune is free and exact —
  `coverage-gate.ts:73`.)

## See also

- [03-sampling-parameters.md](03-sampling-parameters.md) — the classifier wants temperature 0
- [06-token-economics.md](06-token-economics.md) — the cost these gates avoid
- [08-provider-abstraction.md](08-provider-abstraction.md) — the tool-policy allowlist, another pre-model gate
- [../04-agents-and-tool-use/03-react-pattern.md](../04-agents-and-tool-use/03-react-pattern.md) — the paid loop the gates protect
