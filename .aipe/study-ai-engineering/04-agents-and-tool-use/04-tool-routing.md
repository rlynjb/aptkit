# Tool routing and least-privilege allowlists (which tools, locked down how?)

**Industry names:** tool selection / routing, least-privilege tool scoping, capability allowlisting · *Industry standard*

## Zoom out, then zoom in

A workspace exposes dozens of tools. The recommendation agent has no business
touching the customer-events tools; the anomaly monitor has no business listing
email campaigns. Tool routing decides which tools each capability gets — and in
AptKit the answer is enforced *before the provider ever sees the request*. The
model literally cannot request a tool it wasn't handed.

```
  Zoom out — where tool routing lives

  ┌─ Routing layer (intent + policy) ─────────────────────────────┐
  │  parseIntent → which capability     ★ ToolPolicy allowlist ★    │ ← we are here
  │  coverage-gate runnableRequirements → which TASKS can run       │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ filterToolsForPolicy(allTools, policy)
  ┌─ Agent layer ──────────────────▼────────────────────────────────┐
  │  toolSchemas = ONLY the allowed tools                           │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ passed into runAgentLoop
  ┌─ Provider layer ───────────────▼────────────────────────────────┐
  │  model.complete({ tools: toolSchemas })  ← sees the subset only │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: routing has two distinct jobs. First, **pick the capability** — is this
a monitoring, diagnostic, or recommendation request? AptKit does that with a cheap
heuristic first (`parseIntent`), LLM classification as the fallback. Second,
**scope the tools** — once you know the capability, hand the model *only* the
tools that role is allowed to call. That second job is the security-shaped one,
and it's the heart of this file: least privilege, enforced at the schema boundary.

## Structure pass

**Layers.** Three: *intent routing* (which capability handles this request),
*coverage gating* (which tasks can even run against this workspace), and *policy
filtering* (which tools the chosen capability may see). They run in that order and
each narrows the input to the next.

**Axis — trust / what can the model reach?** Trace it down. At the registry, *all*
tools exist (full surface). At the policy filter, the surface is cut to the
allowlist (recommendation 13, query ~49, anomaly 4). At the provider, the model
sees *only* that subset — it cannot name a tool it never received. The reachable
surface shrinks monotonically at every layer; nothing widens it back.

```
  One question — "what tools can the model reach?"

  ┌─ registry ──────┐  → ALL tools (full catalog)
  └─────────────────┘
  ┌─ policy filter ─┐  → ONLY allowedTools (13 / 49 / 4)
  └─────────────────┘
  ┌─ provider ──────┐  → exactly the filtered subset — can't request more
  └─────────────────┘
```

**Seams.** The load-bearing seam is `filterToolsForPolicy` — the boundary where
the full catalog becomes the per-capability subset. Trust flips across it: above
it, every tool is callable; below it, only the allowlist. A second seam is the
coverage gate, which runs *before* the model spends a single token and removes
tasks the workspace can't support. Both seams are pre-model — that's what makes
them cheap and tamper-proof.

## How it works

You already know route handlers and middleware: a request comes in, a router
picks the handler, and middleware can reject it before the handler runs. Tool
routing is that, with two twists — the "router" can be a cheap string check or an
LLM, and the "middleware" is an allowlist that decides which *tools* (not which
handler) the model gets to see.

### Move 1 — the mental model

```
  Routing = two decisions, narrowing the surface

  request ──► (1) WHICH capability?
              heuristic parseIntent ─ cheap, first try
                    │ ambiguous?
                    ▼
              LLM classifyIntent ─ fallback, costs a call
                    │
                    ▼ capability chosen
              (2) WHICH tools may it see?
              filterToolsForPolicy(allTools, policy.allowedTools)
                    │
                    ▼
              toolSchemas = the allowed subset ONLY
                    │
                    ▼
              model never sees — never can request — the rest
```

The mental shift: routing isn't just "pick the handler." It's "pick the handler
*and* clamp what that handler's model can reach." The clamp is the security
property.

### Move 2 — the moving parts, one at a time

**Heuristic-first intent routing.** Bridge from a switch statement — before paying
for an LLM call, AptKit checks the raw query for keywords: contains "monitoring"?
route to monitoring; "recommendation"? route there; else default to diagnostic.
It's `parseIntent`, a pure string check, zero cost. Only when you want real
classification do you call the model (`classifyIntent`), whose output is *also*
fed through `parseIntent` to normalize it to one of three words. Boundary
condition: the heuristic is intentionally dumb — it's a fast path, not the final
word; the LLM classifier exists for the ambiguous cases.

```
  Pattern — heuristic before LLM (cost-first routing)

  query ──► includes "monitoring"? ──yes──► monitoring
                │ no
                ├──► includes "recommendation"? ──yes──► recommendation
                │ no
                ├──► includes "diagnostic"? ──yes──► diagnostic
                │ no
                └──► default: diagnostic        (zero model calls so far)

  want a real call? classifyIntent → model → parseIntent(its 1 word)
```

**Least-privilege policy filtering.** Bridge from Unix file permissions — each
capability owns a `ToolPolicy`: a `capabilityId` and a frozen `allowedTools` list.
`filterToolsForPolicy` takes the *full* catalog and the policy, builds a `Set` of
allowed names, and returns only the tools whose name is in the set — re-shaped as
neutral `ModelTool` schemas. The model is then handed *only* that subset.
Boundary condition: there is no "allow all" escape hatch and no way for the model
to request outside the set — an off-list name simply isn't in `toolSchemas`, so
the model never learns the tool exists.

```
  Layers-and-hops — the catalog shrinks to the allowlist

  ┌─ ToolRegistry ─┐  hop1: listTools() → ALL tools   ┌─ filter ───────┐
  │  full catalog  │ ─────────────────────────────────►│ allowed = Set( │
  └────────────────┘                                   │  policy.allowed)│
                                                        └──────┬─────────┘
                                            hop2: keep only name ∈ allowed
                                                               ▼
                                                    ┌─ toolSchemas ──────┐
                                                    │ recommendation: 13 │
                                                    │ query: ~49         │
                                                    │ anomaly: 4         │
                                                    └──────┬─────────────┘
                                            hop3: passed to model.complete({tools})
                                                           ▼
                                                    model sees the subset ONLY
```

**Pre-model coverage gating.** Bridge from a feature flag check — before the agent
spends *any* tokens, the coverage gate asks "can this workspace even run this
task?" Each task declares the capabilities it `requires` (event names, properties,
catalogs). `runnableRequirements` filters out any task whose required capabilities
are absent — the workspace simply lacks the data. The model is never asked to
attempt work it can't do. Boundary condition: a task with *partial* coverage
(`limited`) still runs; only `unavailable` tasks are dropped, so the gate is a
floor, not a perfectionist.

```
  Pattern — coverage gate filters tasks pre-model

  for each task requirement:
    requires ⊆ workspace capabilities?
        │ no  → 'unavailable' → DROPPED (never sent to the model)
        │ yes
        └─ enriches ⊆ capabilities?  no → 'limited' (runs, partial)
                                     yes → 'full'   (runs, complete)
```

### Move 3 — the principle

Route by the cheapest signal that works, and scope by least privilege enforced at
the layer the model can't reach past. Heuristic-first routing means you don't pay
for an LLM to answer a question a keyword check could. Allowlist filtering means a
capability — even one driving a model that's been prompt-injected — can only ever
request the tools its role was granted, because the rest never reach the provider.
And coverage gating means you never burn tokens on work the data can't support.
The unifying idea: decide *before* the expensive, untrusted step, not during it.

## Primary diagram

The full routing path: intent → coverage → policy → bounded subset to the model.

```
  Tool routing — full picture

  ROUTING LAYER
  request ─► parseIntent (heuristic, free) ─┐
            classifyIntent (LLM, fallback) ─┴─► capability chosen
                                                     │
  COVERAGE GATE (pre-model, pre-token)               │
  runnableRequirements(tasks, workspace.capabilities)│ drop 'unavailable'
                                                     ▼
  POLICY FILTER (the trust seam)
  filterToolsForPolicy(allTools, capability.policy)
        recommendationToolPolicy → 13 tools
        queryToolPolicy          → ~49 tools
        anomalyMonitoringPolicy  → 4 tools
                                                     │
  AGENT + RUNTIME                                    ▼
  runAgentLoop({ toolSchemas: <subset only> })
                                                     │ model.complete({ tools })
  PROVIDER                                           ▼
  model sees ONLY the subset — cannot request anything outside it
```

## Implementation in codebase

**Use cases.** Three capabilities, three deliberately different blast radii. The
anomaly monitor is the tightest — 4 tools, all read-only analytics — because a
scanner needs almost nothing. The recommendation agent gets 13 read-only *discovery*
tools (list/get scenarios, segments, campaigns) so it can check what already
exists without duplicating live work. The query agent is the widest — ~49 tools —
because free-form NL questions can touch almost any read surface. Nobody gets a
write tool; that's the policy doing its job.

**The policy filter — the trust seam**, `packages/tools/src/tool-policy.ts:11-23`:

```
  packages/tools/src/tool-policy.ts  (lines 11-23)

  export function filterToolsForPolicy(
    allTools: readonly ToolDefinition[],
    policy: ToolPolicy,
  ): ModelTool[] {
    const allowed = new Set(policy.allowedTools);   ← the allowlist as a Set
    return allTools
      .filter((tool) => allowed.has(tool.name))      ← keep only allowed names
      .map((tool) => ({ name: tool.name,             ← reshape to neutral schema
        description: tool.description ?? '',
        inputSchema: tool.inputSchema }));
  }
       │
       └─ this is the seam. Anything not in `allowed` is gone before the
          model is called. There is no "all" mode and no model path to
          request a dropped tool — it isn't in the returned array.
```

**The per-capability policies** — each agent owns one, declared right next to its
class:

```
  recommendation-agent.ts:19-36   13 read-only discovery tools
  query-agent.ts:10-50            ~49 read-only tools (broadest)
  monitoring-agent.ts:12-20        4 analytics tools (tightest)

  // monitoring-agent.ts:11 says it plainly:
  // "Least-privilege tool grant for anomaly scanning.
  //  Provider adapters only see these tools."
```

Each `scan()`/`propose()`/`answer()` calls
`filterToolsForPolicy(allTools, <its policy>)` and passes the result as
`toolSchemas` (e.g. `monitoring-agent.ts:58-59`,
`recommendation-agent.ts:69-70`). The model in that run is structurally limited to
those names.

**Heuristic-first routing**, `packages/agents/query/src/intent.ts:4-29`:

```
  packages/agents/query/src/intent.ts  (lines 4-10, 12-28)

  export function parseIntent(raw: string): Intent {
    const text = raw.trim().toLowerCase();
    if (text.includes('monitoring')) return 'monitoring';     ← free keyword check
    if (text.includes('recommendation')) return 'recommendation';
    if (text.includes('diagnostic')) return 'diagnostic';
    return 'diagnostic';                                       ← safe default
  }

  export async function classifyIntent(model, query) {        ← the LLM fallback
    const response = await model.complete({
      system: 'Classify … as exactly one word …', maxTokens: 16 });
    return parseIntent(text);   ← LLM output normalized through the SAME heuristic
  }
       │
       └─ parseIntent is free and tried first; classifyIntent costs one
          16-token call and is reached for only when you want real
          classification — and its output still passes through parseIntent.
```

**Coverage gating**, `packages/tools/src/coverage-gate.ts:73-78`:

```
  packages/tools/src/coverage-gate.ts  (lines 73-78)

  export function runnableRequirements<T extends CoverageRequirement>(
    requirements: readonly T[],
    capabilities: ReadonlySet<string>,
  ): T[] {
    return requirements.filter(
      (req) => requirementCoverage(req, capabilities) !== 'unavailable');
  }
       │
       └─ runs before the model. A task whose required event/catalog
          capabilities are absent is 'unavailable' and dropped, so no
          tokens are spent asking the model to attempt impossible work.
          The monitoring agent uses this via runnableCategories()
          (monitoring-agent.ts:52-54).
```

## Elaborate

Least privilege is a 1970s security principle (Saltzer & Schroeder): grant a
component the minimum authority it needs, no more. Applied to LLM agents it's
suddenly load-bearing again, because the agent's "authority" is the tool set you
hand it, and the model is an *untrusted* decision-maker — it can be steered by
data it reads (prompt injection). If a hijacked model can only request read-only
tools, the worst case is bounded. AptKit's allowlist is exactly this: the policy
is the capability grant, and `filterToolsForPolicy` is the enforcement point. See
`../06-production-serving/03-prompt-injection.md` — the allowlist is the *first*
real injection defense, precisely because it's enforced where the model can't
reach.

Heuristic-before-LLM routing is the other half: an industry cost pattern (route
the easy cases with a rule, escalate only the hard ones to the expensive model).
AptKit's `parseIntent`/`classifyIntent` pair is a small, honest instance of it.
See `../06-production-serving/02-llm-cost-optimization.md`.

Adjacent concepts: what a tool call physically is (`02-tool-calling.md`), the loop
that runs the allowed tools (`03-react-pattern.md`), and the injection threat the
allowlist defends against (`../06-production-serving/03-prompt-injection.md`).

## Project exercises

*Provenance: Phase 4 — Agents and tool use (C4.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. Case A — routing and policy are
implemented; these strengthen and test them.*

### Exercise — assert no write tool can ever enter a policy

- **Exercise ID:** `[A4.5]` Phase 4, least-privilege concept
- **What to build:** A test (or a build-time check) that scans every declared
  `ToolPolicy.allowedTools` and fails if any name matches a write-shaped prefix
  (`create_`, `update_`, `delete_`, `execute_` except the read-only EQL one). Pin
  the read-only invariant the policies currently uphold by convention.
- **Why it earns its place:** The "all tools are read-only" property is the spine
  of the injection defense but is enforced only by reviewer discipline today. A
  test makes it a guarantee.
- **Files to touch:** `packages/agents/*/src/*-agent.ts` (the policy exports),
  a new `packages/tools/test/tool-policy.test.ts`.
- **Done when:** Adding a write tool to any policy turns the suite red.
- **Estimated effort:** `1–4hr`

### Exercise — promote routing from keyword to embedding similarity

- **Exercise ID:** `[B4.6]` Phase 4, intent-routing concept
- **What to build:** Replace `parseIntent`'s pure keyword check with a small
  embedding-similarity router: precompute embeddings for the three intent
  descriptions, embed the query, route to the nearest — still falling back to the
  LLM `classifyIntent` when similarity is low.
- **Why it earns its place:** Keyword routing misses "what's gone wrong with
  checkout?" (no literal keyword). Embedding similarity is the standard cheap-but-
  smart middle tier between regex and an LLM call — a real cost/quality lever.
- **Files to touch:** `packages/agents/query/src/intent.ts`, an embedding provider
  in `packages/providers/*`, `packages/agents/query/test/intent.test.ts`.
- **Done when:** A keyword-free monitoring question routes to `monitoring` without
  the LLM fallback firing; a test proves it.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: A prompt-injection attack hijacks your model and tells it to delete data.
What happens?**
"Nothing destructive, because of where I enforce the allowlist. I'd draw it:"

```
  registry: ALL tools
       │ filterToolsForPolicy(allTools, policy)   ← trust seam
       ▼
  toolSchemas: read-only subset only
       │ model.complete({ tools: subset })
       ▼
  model can request ONLY what it was handed — no write tool exists to it
```

"Every policy is read-only by design, and `filterToolsForPolicy`
(`tool-policy.ts:11`) runs *before* the provider sees anything. The model can't
request a `delete_` tool because it was never told one exists — it isn't in
`toolSchemas`. The hijack is bounded to read-only requests."
*Anchor: least privilege enforced at a seam the model can't reach past.*

**Q: How do you route without paying for an LLM on every request?**
"Heuristic first. `parseIntent` (`intent.ts:4`) is a free keyword check that
handles the easy cases; I only call the LLM classifier for ambiguous queries, and
even its one-word answer gets normalized back through `parseIntent`. Cheap signal
first, expensive signal only when needed."
*Anchor: route by the cheapest signal that works; escalate, don't default-escalate.*

## Validate

- **Reconstruct:** From memory, write `filterToolsForPolicy` — Set of allowed
  names, filter, reshape. Check against `tool-policy.ts:11-23`.
- **Explain:** Why does the allowlist make a security difference *only because* it
  runs before `model.complete`? (If it ran after, the model would already have
  seen — and could have requested — the full surface. Pre-model means the tool
  never enters the model's reachable set; `tool-policy.ts:11` feeding
  `monitoring-agent.ts:59`.)
- **Apply:** A workspace has no `purchase` event. The anomaly monitor has a
  revenue-drop category requiring `purchase`. What happens? (`runnableRequirements`
  marks it `unavailable` and drops it pre-model — `coverage-gate.ts:73` via
  `runnableCategories`, `monitoring-agent.ts:52` — so no tokens are spent on it.)
- **Defend:** Why does the query agent get ~49 tools but the anomaly monitor only
  4? (Blast radius matches the job: a scanner needs almost nothing; free-form NL
  questions can touch many read surfaces. Least privilege per role —
  `query-agent.ts:10` vs `monitoring-agent.ts:12`.)

## See also

- [02-tool-calling.md](02-tool-calling.md) — what a tool request physically is
- [03-react-pattern.md](03-react-pattern.md) — the loop that runs the allowed tools
- [../06-production-serving/03-prompt-injection.md](../06-production-serving/03-prompt-injection.md) — the allowlist as the first injection defense
- [../06-production-serving/02-llm-cost-optimization.md](../06-production-serving/02-llm-cost-optimization.md) — heuristic-first routing as a cost lever
- [.aipe/study-security/](../../study-security/) — trust boundaries and capability scoping
