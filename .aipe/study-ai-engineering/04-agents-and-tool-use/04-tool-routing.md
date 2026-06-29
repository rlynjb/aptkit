# Tool routing

**Subtitle:** Tool selection / routing · least-privilege policy + LLM-within-allowlist · *Industry standard (aptkit's twist: the policy sets the menu)*

## Zoom out, then zoom in

Tool routing is the question "given a request, which tool runs?" The textbook split
is heuristic routing (rules pick the tool) vs LLM routing (the model picks). aptkit's
real answer is neither pure case: a per-capability **policy** decides the *menu* of
tools a capability may even see, and the LLM picks *within* that menu. Routing here
is least-privilege first, model-choice second.

```
  Zoom out — routing is menu (policy) + pick (LLM)

  ┌─ Capability ───────────────────────────────────────────────┐
  │  ToolPolicy { capabilityId, allowedTools }                  │
  │        │ filterToolsForPolicy(allTools, policy)             │
  │        ▼                                                    │
  │  ★ the MENU — only the tools this role may see ★            │ ← we are here
  └───────────────────────────┬─────────────────────────────────┘
                              │ toolSchemas (the filtered menu)
  ┌─ Agent loop / model ──────▼─────────────────────────────────┐
  │  the LLM PICKS one of the allowed tools each turn           │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. Most "routing" content debates heuristic vs LLM as if you must choose
one. aptkit shows the production answer: bound the choice with a policy so the model
*can't* pick a tool outside its role, then let the model route within the allowlist.
There's also a real heuristic router in the repo — `parseIntent` — that classifies
intent before/around the LLM. So aptkit teaches both: heuristic-front/LLM-back as the
general pattern, and its own version as policy-bounded LLM routing.

## Structure pass

**Layers.** Registry (all tools) → policy filter (the allowlist) → agent loop (offers
the menu) → model (picks). Plus a side path: an intent classifier that routes the
request to a capability before any of this.

**Axis — who can choose a given tool.** Trace the freedom to call `delete_everything`:
the registry holds it; `filterToolsForPolicy` (`tool-policy.ts:11`) drops it for any
capability whose `allowedTools` omits it; so by the time the model sees `toolSchemas`,
that tool *isn't in the array* and the model literally cannot name it. The axis "is
this tool callable here?" is decided at the policy filter, not by the model and not
by a runtime check.

**Seam.** `filterToolsForPolicy(allTools, policy)` (called in every agent, e.g.
`rag-query-agent.ts:64`, `query-agent.ts:77`). Above it: the full registry. Below it:
a model that only ever sees its role's tools. That filter is the routing boundary —
it's *allowlist construction*, run before the model gets a vote.

## How it works

### Move 1 — the mental model

You know route guards / RBAC from web apps: a middleware decides which endpoints a
role can hit *before* the handler runs, so an unauthorized request never reaches the
logic. A tool policy is the same guard for tools. `allowedTools` is the role's
permission set; `filterToolsForPolicy` is the middleware that strips everything else
out of the menu. The model is the user clicking a link — it can only click links the
guard left on the page.

```
  Tool policy ≈ an RBAC route guard

  all routes (tools)  ──► guard (allowlist filter) ──► only permitted routes shown
                                                            │
                                                       user (model) clicks one
```

### Move 2 — the routing mechanisms

**Mechanism 1 — the policy filters the menu (least privilege).** A `ToolPolicy` is a
capability id plus an allowlist; the filter keeps only matching tools and maps them
to provider-neutral schemas (`tool-policy.ts:11`):

```ts
export function filterToolsForPolicy(allTools, policy): ModelTool[] {
  const allowed = new Set(policy.allowedTools);
  return allTools
    .filter((tool) => allowed.has(tool.name))     // drop anything not on the allowlist
    .map((tool) => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema }));
}
```

The model never sees a tool outside its role — not "is told not to call it," but
*cannot name it*, because it's absent from the array passed to `model.complete`.

```
  Policy filter — the model's menu is pre-trimmed

  registry: [search, list_*, get_*, execute_*, ... 45 tools]
       │ filterToolsForPolicy(allTools, policy)
       ▼
  toolSchemas: [ only the role's allowed tools ]  ─► model.complete(tools: toolSchemas)
```

**Mechanism 2 — the menu's *size* is the routing decision.** Compare two capabilities.
rag-query allows exactly one tool (`rag-query-agent.ts:15`):

```ts
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   // a one-item menu
};
```

With a one-item menu there's nothing to route — the only choice is *whether* to call
it. The query agent's menu is ~45 read-only `list_*`/`get_*`/`execute_*` tools
(`query-agent.ts:10`), so the model genuinely routes among them per turn. Same loop,
same filter; the policy's breadth decides how much routing the model actually does.

```
  Menu size sets the routing burden

  rag-query  : [search_knowledge_base]                    → no routing (1 choice)
  query      : [list_dashboards, get_trend, ...~45 tools] → real LLM routing per turn
```

**Mechanism 3 — heuristic routing up front (`parseIntent`).** Before the LLM picks a
tool, a keyword heuristic routes the *request type*. `parseIntent`
(`query/src/intent.ts:4`) keyword-matches a query into one of three intents:

```ts
export function parseIntent(raw: string): Intent {
  const text = raw.trim().toLowerCase();
  if (text.includes('monitoring')) return 'monitoring';
  if (text.includes('recommendation')) return 'recommendation';
  if (text.includes('diagnostic')) return 'diagnostic';
  return 'diagnostic';                                   // default
}
```

This is the classic heuristic-front pattern: cheap keyword rules pick the lane, then
the LLM does the fine-grained work inside it. (There's also `classifyIntent` in the
same file — an LLM-front variant that asks the model for one word, then runs it
through the *same* `parseIntent` to normalize. So aptkit has both a pure-heuristic and
an LLM-then-heuristic router for intent.)

```
  Heuristic-front / LLM-back routing

  query ─► parseIntent (keyword rules) ─► intent lane (monitoring|diagnostic|recommendation)
                                              │ feeds the system prompt
                                              ▼
                                       LLM routes among the lane's allowed tools
```

**Mechanism 4 — the two routers compose.** Intent routing (which lane) and policy
routing (which menu) stack: the intent shapes the prompt/behavior, the policy bounds
the toolset, and only then does the LLM pick a tool. The result is "policy-bounded LLM
routing plus an intent heuristic" — not a single router but a small pipeline.

```
  The full routing pipeline

  request
    │ parseIntent (heuristic)            ← which lane?
    ▼
  intent ─► system prompt
    │ filterToolsForPolicy (allowlist)   ← which menu?
    ▼
  toolSchemas ─► model picks a tool      ← which tool? (LLM, bounded)
```

### Move 3 — the principle

Don't let the model route from the universe of tools — route from a role-scoped
allowlist, and use cheap heuristics for coarse lane selection where keywords suffice.
The win is twofold: least privilege caps the blast radius of a bad pick (the query
agent literally cannot mutate anything — its menu is all read-only `list_*`/`get_*`),
and a smaller menu makes the model's routing more reliable (fewer wrong tools to pick).
The interview signal is framing routing as *menu construction* before model choice:
the policy is a security and reliability decision, not a prompt-engineering one.

## Primary diagram

```
  Tool routing — policy sets the menu, LLM picks within it

  ┌─ parseIntent (heuristic, intent.ts) ─────────────────────────────────┐
  │  keyword rules ─► lane (monitoring | diagnostic | recommendation)     │
  └───────────────┬───────────────────────────────────────────────────────┘
                  │ shapes the system prompt
  ┌─ filterToolsForPolicy (allowlist, tool-policy.ts) ───────────────────┐
  │  registry (all tools) ─► keep only policy.allowedTools                │
  │   rag-query: [search_knowledge_base]   (1 → no routing)               │
  │   query:     [~45 read-only list_*/get_*]   (many → real routing)     │
  └───────────────┬───────────────────────────────────────────────────────┘
                  │ toolSchemas (the trimmed menu)
  ┌─ Agent loop / model ─▼───────────────────────────────────────────────┐
  │  the LLM picks one allowed tool each turn — cannot name a dropped one │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The field talks about "router" patterns (a model or rules dispatching to handlers)
and "tool selection" (the model choosing among many tools). aptkit collapses the
risk in tool selection by making it least-privilege: the allowlist is the same idea
as a scoped OAuth token or an IAM policy — the agent is granted only the tools its
job needs. This is also the security story (see `01-llm-foundations` / the security
study): the smallest credible cause of damage in an agent is a tool it shouldn't have
been able to call, and the policy filter removes that class entirely. Heuristic
routing (`parseIntent`) is the cheap front door; when keywords aren't enough,
`classifyIntent` shows the LLM-as-router variant feeding the same normalizer. Read
`02-tool-calling.md` for how the picked tool is actually invoked, and
`06-error-recovery.md` for why least privilege limits the blast radius of a bad call.

## Project exercises

### Add a runtime assertion that the model never called a tool outside its policy
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** in the loop, before `callTool`, assert the chosen tool is in the
  capability's `allowedTools`; emit a `warning` event and refuse if not (defense in
  depth behind the menu filter).
- **Why it earns its place:** the filter trims the menu, but a belt-and-suspenders
  runtime check is what you'd actually ship for a security-sensitive agent; it shows
  you don't trust a single layer.
- **Files to touch:** `packages/runtime/src/run-agent-loop.ts`,
  `packages/tools/src/tool-policy.ts`, `packages/runtime/test/`.
- **Done when:** a fixture where the model names a disallowed tool produces a warning
  and an error observation instead of executing it.
- **Estimated effort:** `1–4hr`

### Replace `parseIntent`'s keyword match with a confidence-scored router
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** when `parseIntent`'s keywords don't match (it currently defaults
  to `diagnostic`), fall back to `classifyIntent` (the LLM router) instead of the
  silent default, and record which router decided.
- **Why it earns its place:** "cheap heuristic first, LLM only on ambiguity" is the
  production routing pattern; wiring the fallback and the attribution shows you can
  compose routers by cost.
- **Files to touch:** `packages/agents/query/src/intent.ts`,
  `packages/agents/query/src/query-agent.ts`, the query agent's `test/`.
- **Done when:** a no-keyword query routes via the LLM and the trace records
  `router: llm`, while a keyword query records `router: heuristic`.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "How does your agent decide which tool to call — heuristic or LLM?"**
Both, layered. A `ToolPolicy` filters the registry to the capability's `allowedTools`
*before* the model gets a vote — `filterToolsForPolicy` builds the menu, so the model
can only pick tools its role permits (rag-query sees one tool; query sees ~45
read-only ones). Within that menu the LLM routes per turn. And `parseIntent` is a
keyword heuristic that picks the request's lane up front. So it's policy-bounded LLM
routing plus a heuristic intent router — not one or the other.

```
  parseIntent (heuristic lane) → filterToolsForPolicy (allowlist menu) → LLM picks within menu
```
Anchor: *the policy sets the menu; the LLM only picks from it.*

**Q: "What stops the model from calling a tool it shouldn't?"**
It never sees it. `filterToolsForPolicy` drops any tool not in `allowedTools`, so the
`toolSchemas` array passed to `model.complete` doesn't contain it — the model can't
name a tool that isn't in its menu. That's least privilege: the query agent's whole
menu is read-only `list_*`/`get_*`, so it structurally cannot mutate state. It's the
same idea as a scoped token — grant only what the role needs, and a bad pick can't
reach a dangerous tool.

```
  registry → filter by allowedTools → model's menu excludes the dangerous tool entirely
```
Anchor: *least privilege at the menu — a tool that's absent can't be misrouted to.*

## See also

- `02-tool-calling.md` — how the routed tool is actually invoked
- `01-agents-vs-chains.md` — the loop the routed tools run inside
- `06-error-recovery.md` — least privilege limits the blast radius of a bad call
- `03-react-pattern.md` — the per-turn Action where routing happens
- `05-agent-memory.md` — `search_memory` as a policy-gated tool
