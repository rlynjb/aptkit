# Least-privilege tool policy

**Industry name(s):** capability-scoped allowlist / least-privilege tool
gating · **Type:** Industry standard (principle of least privilege, applied
to agent tool access)

## Zoom out, then zoom in

The model in an agent loop is an attacker you've invited inside. It decides
which tool to call, with what arguments — and if it can reach a tool that
deletes data or writes to prod, a confused or jailbroken model can use it.
The defense is the oldest one in security: give each agent only the tools
its task needs, and make the rest invisible. Here's where that gate sits.

```
  Zoom out — where the tool allowlist lives

  ┌─ Agent layer (per capability) ───────────────────────────┐
  │  RagQueryAgent   →   ★ ragQueryToolPolicy ★              │ ← we are here
  │                      allowedTools: [search_knowledge_base]│
  └──────────────────────────┬────────────────────────────────┘
                             │  filterToolsForPolicy(allTools, policy)
  ┌─ Tool layer ─────────────▼────────────────────────────────┐
  │  InMemoryToolRegistry  (the full catalog — many tools)    │
  └──────────────────────────┬────────────────────────────────┘
                             │  only allowed schemas pass
  ┌─ Runtime layer ──────────▼────────────────────────────────┐
  │  runAgentLoop  →  model.complete({ tools: toolSchemas })  │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: this is the **allowlist** (`ToolPolicy`) — a per-agent declaration
of exactly which tool names the model is allowed to see. The question it
answers: *of every tool registered in the system, which can this agent's
model actually call?* The answer is enforced before the model's first turn,
not checked after it asks.

## Structure pass

**Layers:** the agent owns the *policy* (the allowlist), the tool registry
owns the *catalog* (every registered tool), and `filterToolsForPolicy` is
the *seam* between them — it projects the catalog down to the policy.

**Axis — trust:** trace "what can the model reach?" across the seam.

```
  The trust axis flips at filterToolsForPolicy

  ┌─ registry side ─┐   seam: filter   ┌─ model side ────┐
  │ ALL tools exist │ ═══════╪════════► │ ONLY allowed    │
  │ (full catalog)  │  (it flips)      │ tools visible   │
  └─────────────────┘                  └─────────────────┘
         ▲                                     ▲
         └──── "what can the model reach?" ────┘
               registry: everything · model: the allowlist only
```

Before the seam, the registry holds every tool. After it, the model is
handed only the allowed schemas. The trust answer flips — that's a
load-bearing boundary, worth studying before the loop's internals.

**Seam:** `filterToolsForPolicy` is the single choke point. Every agent
passes its catalog through it; there is no other path from registry to
model. One function to audit.

## How it works

#### Move 1 — the mental model

You already do this in frontend code: a feature flag gates which UI a user
sees, and the un-flagged component never renders — it's not hidden with
CSS, it's never in the tree. The tool allowlist is the same move at the
agent boundary. The model isn't told "you may not call `delete_document`";
the schema for `delete_document` is never put in front of it, so it can't
form the call.

```
  The allowlist as a projection

  policy.allowedTools = { "search_knowledge_base" }

  catalog:  [ search_knowledge_base ]  ──┐
            [ delete_document       ]    │  filter: name ∈ allowed?
            [ write_metric          ]    │
            [ ... 46 more ...       ]  ──┘
                       │
                       ▼
  model sees: [ search_knowledge_base ]   ← only this
```

#### Move 2 — the step-by-step walkthrough

**The policy is a named allowlist, not a denylist.** A `ToolPolicy` is two
fields: which capability it's for, and the set of tool *names* allowed. It
allowlists (name what's permitted) rather than denylists (name what's
forbidden) — the safer default, because a newly added tool is denied until
explicitly granted, never accidentally exposed.

```typescript
// packages/tools/src/tool-policy.ts:4-8
/** Capability-scoped allowlist that keeps agents from seeing tools outside their role. */
export type ToolPolicy = {
  capabilityId: string;            // which agent this policy belongs to
  allowedTools: readonly string[]; // the allowlist — tool NAMES, not handlers
};
```

**The filter projects the catalog to the policy.** `filterToolsForPolicy`
builds a `Set` from the allowlist for O(1) membership, filters the full
catalog to allowed names, then maps each survivor down to just the
provider-neutral schema (`name`, `description`, `inputSchema`) the model
needs — it doesn't even hand over the handler.

```typescript
// packages/tools/src/tool-policy.ts:11-23
export function filterToolsForPolicy(
  allTools: readonly ToolDefinition[],
  policy: ToolPolicy,
): ModelTool[] {
  const allowed = new Set(policy.allowedTools);      // allowlist → Set
  return allTools
    .filter((tool) => allowed.has(tool.name))        // drop anything not allowed
    .map((tool) => ({                                // expose only the schema
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    }));
}
```

**The agent applies its policy before the loop runs.** The rag-query agent
declares the tightest allowlist in the repo — a single tool — then filters
its catalog through it and hands the result to the loop.

```typescript
// packages/agents/rag-query/src/rag-query-agent.ts:14-18
/** Least-privilege grant: this agent may only search the knowledge base. */
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   // exactly one tool
};

// ...inside the agent (rag-query-agent.ts:63-64):
const allTools = await this.options.tools.listTools();
const toolSchemas = filterToolsForPolicy(allTools, ragQueryToolPolicy);
```

The query agent (`packages/agents/query`) is the same shape at a different
scale: ~49 tools, but every one **read-only**. The policy is where
"read-only" is enforced — no write tool is in its `allowedTools`, so no
write tool reaches the model. The capability shape ("prompt package + tool
policy + loop config + validator") makes the allowlist a first-class part
of every agent's definition, not an afterthought.

#### Move 2 variant — the load-bearing skeleton

Strip this to its kernel and three parts remain, each defending a distinct
thing:

- **The allowlist set** — *drop it and the model sees the whole catalog.*
  An anomaly-monitoring agent could suddenly call a write tool meant for a
  different capability. This is the part that contains the blast radius.
- **The name-based filter** — *drop it (e.g. expose handlers directly) and
  there's no projection step; the registry and the model share a trust
  level.* The seam disappears.
- **The schema-only projection** — *drop it and you'd be handing the model
  the executable handler, not a description.* Hardening, not kernel: it
  keeps the model's view to data (schemas) it can reason about, never code.

The skeleton is: **allowlist + filter-by-name + schema-only view.** The
interview-grade detail people forget: a denylist would *fail open* (a new
tool is exposed until someone bans it); this allowlists, so it *fails
closed* (a new tool is invisible until granted).

#### Move 3 — the principle

Least privilege isn't a check you run; it's a *shape* you give the
interface. Make the unsafe thing un-reachable rather than reachable-but-
forbidden. The model can't misuse a tool whose schema it never received —
the same reason a never-rendered component can't be clicked.

## Primary diagram

```
  Least-privilege tool gating — the full picture

  ┌─ Agent (RagQueryAgent) ────────────────────────────────────┐
  │  ragQueryToolPolicy.allowedTools = [search_knowledge_base]  │
  └─────────────────────────────┬──────────────────────────────┘
                                │ filterToolsForPolicy(catalog, policy)
  ┌─ Tool registry ─────────────▼──────────────────────────────┐
  │  [search_knowledge_base] [delete_document] [write_metric]   │
  │   ✓ allowed               ✗ dropped         ✗ dropped       │
  └─────────────────────────────┬──────────────────────────────┘
                                │ toolSchemas = [search_knowledge_base]
  ┌─ Runtime (runAgentLoop) ────▼──────────────────────────────┐
  │  model.complete({ tools: toolSchemas })                     │
  │  → model can ONLY form a search_knowledge_base call         │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the principle of least privilege (Saltzer & Schroeder, 1975)
applied to the LLM-tool boundary — the same idea behind a Unix process
dropping capabilities, or an IAM role scoped to one bucket. What's specific
to agents: the "subject" is a probabilistic model that *will* eventually
ask for something it shouldn't, so the allowlist is doing real work on
every run, not just defending against a rare attacker. It pairs directly
with the bounded loop (`02`): the allowlist limits *what* the model can
reach, the loop limits *how many times* it can reach.

## Interview defense

**Q: How do you stop an agent from calling a tool it shouldn't?**

Allowlist, enforced as a projection before the loop runs. Each agent
carries a `ToolPolicy` naming exactly the tool names it may use;
`filterToolsForPolicy` projects the full registry down to those schemas,
and the model is handed only the survivors. A tool outside the policy isn't
forbidden — it's invisible. The rag-query agent's policy names one tool.

```
  registry ──filter──► [allowed schemas] ──► model
  (everything)          (the allowlist)       (sees only these)
```

*Anchor: filterToolsForPolicy is a fail-closed projection — new tools are
denied by default.*

**Q: Allowlist or denylist — and why does it matter here?**

Allowlist. A denylist fails open: add a new tool and it's exposed to every
agent until someone remembers to ban it. The allowlist fails closed: a new
tool is invisible until a policy explicitly grants it. With a model that
will probe every tool it can see, fail-closed is the only safe default.

*Anchor: allowlist = fail closed; the new-tool case is the tell.*

## See also

- `02-bounded-agent-loop.md` — the loop budget that pairs with the allowlist
- `03-hallucination-tolerant-retrieval.md` — what the one allowed tool does
  with the model's arguments
- `audit.md` lens 7 — tool scope across all agents
- `study-agent-architecture` — the capability shape (policy + prompt + loop)
