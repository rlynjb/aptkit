# Tool-policy least privilege

*Capability-scoped allowlist · Industry standard (least privilege / principle of least authority)*

## Zoom out, then zoom in

Here's the whole agent stack, with one box marked. The model is talking to a tool registry that knows about every tool in the system. The question this concept answers: **of all those tools, which ones is *this* agent allowed to call?**

```
  Zoom out — where the policy sits

  ┌─ Capability (agent) layer ──────────────────────────────┐
  │  RagQueryAgent.answer(question)                         │
  └───────────────────────────┬─────────────────────────────┘
                              │ builds toolSchemas
  ┌─ Tools layer ─────────────▼─────────────────────────────┐
  │  ALL registered tools  ──►  ★ filterToolsForPolicy ★    │ ← we are here
  │                              (allowlist intersection)    │
  │  result: only the tools this capability may call         │
  └───────────────────────────┬─────────────────────────────┘
                              │ toolSchemas sent to model
  ┌─ Model layer ─────────────▼─────────────────────────────┐
  │  model sees ONLY the filtered list; calls by name        │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: this is **least privilege applied to a model instead of a user**. You've used least privilege before — a read-only database user, an API token scoped to one repo, a React component that only gets the props it needs. Same idea, new subject: the agent is the principal, the tools are the resources, and the policy is the grant. The model can request whatever it wants; it only ever *sees* what the policy permits, and the registry refuses anything off-list.

## The structure pass

Layers: **capability → tools → model**. Trace one axis — **trust** ("what can each side reach?") — across them and watch where it flips.

```
  axis traced = "what can the model reach?"

  ┌─ registry (all tools) ─┐   seam    ┌─ what the model sees ─┐
  │  ~49 read-only tools   │ ═══╪════►  │  exactly the allowed  │
  │  (full catalog)        │ (flips)    │  subset (1 for rag)   │
  └────────────────────────┘            └───────────────────────┘
            ▲                                      ▲
            └────── same axis, two answers ────────┘
              → filterToolsForPolicy is the seam:
                study the contract before either side
```

The seam is `filterToolsForPolicy`. On the registry side the answer to "what's reachable" is *everything*; on the model side it's *the allowlist*. The trust answer flips across that boundary — which is exactly what makes it load-bearing. Two enforcement points hang on this seam: the *filter* (what the model is shown) and the *registry guard* (what the registry will actually execute). Both matter, and the next block walks why you need both.

## How it works

#### Move 1 — the mental model

The shape is an **intersection**: take the full set of tools, intersect with the policy's allowlist, hand the model only the result. Then a second, independent check at execution time — defense in depth — refuses any name that slipped through.

```
  Pattern — allowlist intersection + execution guard

   all tools        policy.allowedTools         shown to model
   ┌─────────┐      ┌──────────────┐            ┌──────────┐
   │ search  │      │ search       │  ∩    →     │ search   │
   │ refund  │  ∩   │              │            └──────────┘
   │ delete  │      └──────────────┘
   │ ...49   │
   └─────────┘
        │
        │  model later asks for "refund" anyway?
        ▼
   registry.callTool("refund")  ──► throws "tool not found: refund"
        (second gate: the model can't call what it can't see —
         and can't reach what isn't registered for it)
```

The kernel: a `Set` membership test. Everything else is plumbing.

#### Move 2 — the step-by-step walkthrough

**Step 1 — the policy is a named grant.** A `ToolPolicy` is two fields: the capability it belongs to, and the tools it allows. From `packages/tools/src/tool-policy.ts:5-8`:

```ts
export type ToolPolicy = {
  capabilityId: string;            // who this grant is for
  allowedTools: readonly string[]; // the whitelist, by tool name
};
```

This is the grant written down. `readonly` signals it's not mutated at runtime — the policy is fixed per capability, the way a scoped API token's scopes are fixed when minted.

**Step 2 — the filter is a set intersection.** `filterToolsForPolicy` (`tool-policy.ts:11-23`) builds a `Set` from the allowlist and keeps only the tools whose names are in it:

```ts
export function filterToolsForPolicy(allTools, policy): ModelTool[] {
  const allowed = new Set(policy.allowedTools);          // O(1) membership
  return allTools
    .filter((tool) => allowed.has(tool.name))            // intersection
    .map((tool) => ({ name, description, inputSchema })); // provider-neutral schema
}
```

The `.map` strips each tool down to the schema the model needs (name, description, input schema) — the model never sees the *handler*, only the *interface*. What breaks if you remove the `.filter`: the model is handed all ~49 tools and can call any of them.

**Step 3 — the grant is tight in practice.** The rag-query agent's policy is one tool (`packages/agents/rag-query/src/*`):

```ts
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   // exactly one
};
// ...later:
const toolSchemas = filterToolsForPolicy(allTools, ragQueryToolPolicy);
```

A RAG agent's whole job is "search, then answer." It needs exactly one tool. Granting it one tool means a hijacked or confused model has exactly one lever to pull. This is the 6th agent built to this `capability = prompt + policy + loop config + validator` shape, so the allowlist discipline is consistent across the toolkit.

```
  Layers-and-hops — the grant flowing to the model

  ┌─ Capability ─┐  hop 1: filterToolsForPolicy(all, policy)  ┌─ Tools ──┐
  │ rag-query    │ ──────────────────────────────────────►   │ registry │
  │ allowlist=[1]│                                            └────┬─────┘
  └──────────────┘  hop 2: [search_knowledge_base] only ◄─────────┘
         │
         │ hop 3: toolSchemas → model.complete({ tools })
         ▼
  ┌─ Model ──────┐  model can name only what it was shown.
  │ Gemma/Claude │  off-list name → registry throws (hop 4, the guard)
  └──────────────┘
```

**Step 4 — the second gate (defense in depth).** Even if a tool name reached the model some other way, `InMemoryToolRegistry.callTool` (`tool-registry.ts:50-59`) looks the name up in its handler map and throws `tool not found: <name>` on a miss. The filter controls *visibility*; the registry controls *executability*. You want both: visibility alone fails open if the model is told about a tool through another channel; executability alone means the model wastes turns guessing at tools it can't use.

#### Move 3 — the principle

Least privilege doesn't care whether the principal is a human, a service, or a language model. The discipline is identical: enumerate what this actor needs to do its job, grant exactly that, deny by default, and enforce the deny at the resource (the registry), not just at the menu (the filter). For an agent, the payoff is concrete: it caps the blast radius of every failure mode above it — a hallucination, a prompt injection, a buggy prompt — to the set of tools you deliberately handed over.

## Primary diagram

```
  Tool-policy least privilege — full picture

  ┌─ Tools layer ──────────────────────────────────────────────┐
  │  registry: all ~49 tools registered                        │
  │       │                                                     │
  │       │  filterToolsForPolicy(allTools, ragQueryToolPolicy) │
  │       ▼                                                     │
  │  allowed = Set(["search_knowledge_base"])                  │
  │  shown to model = [search_knowledge_base]   ◄── grant       │
  └───────────────────────────┬─────────────────────────────────┘
                              │ toolSchemas (interfaces only)
  ┌─ Model layer ─────────────▼─────────────────────────────────┐
  │  model calls "search_knowledge_base"  → registry runs it    │
  │  model calls "delete_everything"      → "tool not found"    │
  └──────────────────────────────────────────────────────────────┘
       visibility gate (filter)  +  executability gate (registry)
```

## Elaborate

Least privilege is one of the oldest ideas in security (Saltzer & Schroeder, 1975) — grant the minimum authority needed, nothing more. What's new is applying it to an LLM, where the "principal" is non-deterministic and will, with some probability, *try* to do the wrong thing. That probability is exactly why the allowlist matters more for an agent than for a deterministic service: a service only does what its code says; a model does what it decides, so the grant is the only hard bound. Read this alongside `02-bounded-agent-loop.md` (how *many times* the model may act) and `study-agent-architecture` (the same registry seen as architecture rather than as a control).

## Interview defense

**Q: How do you stop an LLM agent from doing something destructive?**
You don't trust the model — you bound it. Per-capability tool allowlist: the agent only sees the tools its job needs (the rag-query agent sees exactly one, `search_knowledge_base`), and the registry refuses any name off the list. The model is a non-deterministic principal, so the grant is the only hard guarantee.

```
   all tools ──filter(allowlist)──► what model sees ──► registry guard
                                    (1 tool)            (throws off-list)
```
*Anchor: visibility gate plus executability gate — least privilege with defense in depth.*

**Q: Why two checks — isn't the filter enough?** The filter controls what the model is *told about*; the registry controls what *runs*. If a tool name reaches the model through any other path (a stale prompt, an injected instruction), the filter doesn't stop the call — the registry's `tool not found` does. The load-bearing part people forget is the second gate: enforce the deny at the resource, not just the menu.

## See also

- `02-bounded-agent-loop.md` — caps *how often* the model acts, complementing *what* it can act on.
- `03-hallucination-tolerant-tool-args.md` — hardens the one tool rag-query *is* allowed to call.
- `04-app-id-tenancy-without-rls.md` — the authz gap at the storage layer, contrasted with this authz win at the tool layer.
- `audit.md` lens 2 (authorization) and lens 7 (LLM/agent security).
