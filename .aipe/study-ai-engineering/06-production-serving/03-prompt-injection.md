# Prompt injection

**Subtitle:** Treat model output as untrusted text · the model names, your code runs · *Industry standard*

## Zoom out, then zoom in

Before any defense: prompt injection is when text the model reads convinces it to
do something you didn't authorize. The only durable answer is architectural — the
model never gets to *act*, only to *ask*. Here's where that boundary sits in
aptkit, and it's the strongest story in this whole section.

```
  Zoom out — the model asks, your code decides

  ┌─ Agent ─────────────────────────────────────────────────────┐
  │  system prompt + user question + retrieved chunks (untrusted) │
  └───────────────────────────┬─────────────────────────────────┘
                              │ complete(request)
  ┌─ Model ───────────────────▼─────────────────────────────────┐
  │  emits tool_use block: { name: "x", input: {...} }           │ ← can only NAME
  └───────────────────────────┬─────────────────────────────────┘
                              │ tool_use
  ┌─ Policy + Registry ───────▼─────────────────────────────────┐
  │  ★ name in allowlist? ★ registry has handler? → run it      │ ← YOUR code acts
  │  not allowed / not found → nothing happens                   │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. A naive agent lets the model's output trigger side effects directly
— "the model said delete, so we deleted." aptkit refuses that. The model can only
emit a `tool_use` block *naming* a tool; your code decides whether that name is
allowed and then runs the handler. Three layers enforce it: schema-as-only-output,
least-privilege policy, and the registry. What aptkit does *not* do — sanitize
user input, run an output-safety LLM — is `not yet exercised`, and that's fine
because the structural defense is the real one.

## Structure pass

**Layers.** Agent → model → policy → registry. Each layer narrows what can
happen. The model proposes; the policy filters the menu; the registry is the only
thing that executes.

**Axis — control.** Who decides a side effect runs? Trace it: the model decides
only the *name and arguments* of a tool it wants. The policy decides whether that
name is even *visible*. The registry decides whether a handler *exists* and runs
it. The model has zero execution authority — it can't reach past naming.

**Seam.** The load-bearing boundary is `tools.callTool(name, input)` in the agent
loop (`packages/runtime/src/run-agent-loop.ts:159`). Above it: model output, pure
text, untrusted. Below it: your registered handlers, real effects. The axis "can
this text cause a side effect?" flips exactly here — and only a *registered,
allowed* name crosses.

## How it works

### Move 1 — the mental model

You know parameterized SQL: you never string-concat user input into a query,
because then data becomes code. You send the query *shape* and bind the input as
*data*. aptkit does the same with the model: the model's output is always *data*
(a tool name + JSON args), never *code your runtime evals*. The registry is the
prepared statement — it only runs handlers you registered, with the name as a
bound parameter.

```
  Model output is DATA, not CODE — like a prepared statement

  SQL injection (bad):   "DELETE WHERE id=" + userInput   → input becomes code
  SQL parameterized:     "DELETE WHERE id=?", [userInput] → input stays data

  naive agent (bad):     eval(modelOutput)                → output becomes code
  aptkit registry:       registry.callTool(name, args)    → output stays data
                          (name must be a registered, allowed handler)
```

### Move 2 — the three layers that enforce it

**Layer 1 — schema is the only structured-output path.** The model can't return
free-form JSON that your code trusts. When aptkit needs structured data it goes
through `generateStructured`, which validates every response against a
`JsonValidator` and retries on failure — `packages/runtime/src/structured-generation.ts:85`:

```ts
const rawText = textFromResponse(response);
const parsed = parseValidatedJson(rawText, options.validate);  // validate, don't trust
if (parsed.ok) {
  attempts.push({ attempt, rawText });
  return { ok: true, value: parsed.value, rawText, attempts };  // only typed value escapes
}
// else: record the failure and retry with a strict JSON-only suffix
```

Injected text that produces malformed or off-schema JSON fails validation — it
never becomes a typed value your code acts on. `parseValidatedJson` lives in
`json-output.ts:30`; the validator is the gate.

**Layer 2 — least-privilege tool policy.** Each agent declares the *only* tools it
may see. The model literally cannot name a tool outside the allowlist, because the
schemas are filtered before they're sent. The rag-query agent grants exactly one
tool — `packages/agents/rag-query/src/rag-query-agent.ts:15`:

```ts
/** Least-privilege grant: this agent may only search the knowledge base. */
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   // ← one tool, nothing else
};
```

The filter that enforces it — `packages/tools/src/tool-policy.ts:11`:

```ts
export function filterToolsForPolicy(allTools, policy): ModelTool[] {
  const allowed = new Set(policy.allowedTools);
  return allTools
    .filter((tool) => allowed.has(tool.name))   // ← drop anything not on the list
    .map((tool) => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema }));
}
```

```
  The policy filters the menu BEFORE the model ever sees it

  full registry          policy allowlist        what the model sees
  ┌───────────────┐      ┌──────────────────┐    ┌──────────────────┐
  │ search_kb      │      │ allowed:          │    │ search_kb        │
  │ delete_record  │ ───► │  [search_kb]      │──► │                  │
  │ send_email     │      └──────────────────┘    │ (delete/send      │
  │ ...35 more     │                              │  never offered)   │
  └───────────────┘                              └──────────────────┘
   injection can't name a tool the model was never shown
```

The query agent goes further: its policy lists ~45 tools and *every one* is a
read — `list_*` / `get_*` / `execute_analytics`, never a mutation
(`packages/agents/query/src/query-agent.ts:10`). Even a fully hijacked model
can't write anything, because no write tool is on the menu.

**Layer 3 — the registry is the only thing that executes.** The agent loop never
evals model output. It extracts the named tool and calls the registry, which only
runs a handler if it *exists* — `packages/runtime/src/run-agent-loop.ts:159`:

```ts
const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
```

And the registry's `callTool` — `packages/tools/src/tool-registry.ts:50`:

```ts
async callTool(name, args, options): Promise<ToolCallResult> {
  options?.signal?.throwIfAborted();
  const handler = this.handlers.get(name);     // look up by name
  if (!handler) throw new Error(`tool not found: ${name}`);  // ← unknown name = no-op + error
  const start = performance.now();
  const result = await handler(args, options); // YOUR registered code runs, not model text
  return { result, durationMs: Math.round(performance.now() - start) };
}
```

A name the model invents that isn't registered throws — nothing runs. The model
named; your code decided not to run it.

### Move 3 — the principle

Never let model output trigger a side effect directly. Make every effect pass
through a registry gated by a least-privilege allowlist, and make every
structured value pass through a validator. Then injection's worst case is "the
model names a tool" — and naming is harmless when the menu only holds reads and
the executor only runs registered handlers. That's defense by *architecture*, not
by hoping a sanitizer caught the bad string.

## Primary diagram

```
  Three gates between injected text and a side effect

  untrusted text (user input + retrieved chunks)
        │
        ▼
  ┌─ MODEL ──────────────────────────────────────────────┐
  │ can only emit: tool_use { name, input }  OR  text     │  proposes
  └────────────────────────┬──────────────────────────────┘
                           │
        gate 1 ─ POLICY ───▼─── name on allowlist? (reads only)   filters menu
                           │
        gate 2 ─ VALIDATOR ▼─── structured? validate vs JsonValidator  rejects junk
                           │
        gate 3 ─ REGISTRY ─▼─── handler registered? → run YOUR code   executes
                           │
                           ▼
                    side effect (only if all three gates pass)
   GAP: input sanitization + output-safety LLM = not yet exercised
```

## Elaborate

The reason this is aptkit's strongest serving story is that it doesn't rely on
detecting malicious text at all — it removes the model's authority to act. That's
the difference between a security *control* (a sanitizer you hope is complete) and
a security *boundary* (the model structurally cannot execute). aptkit is missing
the softer controls — it doesn't strip injection patterns from user input and it
doesn't run a second LLM to grade output safety — and both are `not yet
exercised`. But those are depth-in-defense on top of a boundary that already
holds. Read `05-retry-circuit-breaker.md` for how the same loop handles a model
that misbehaves by *failing* rather than by *attacking*.

## Project exercises

### Prove an injected tool name can't escape the policy
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a test that runs the rag-query agent against a
  `FixtureModelProvider` whose recorded response emits a `tool_use` for a tool
  *not* in `ragQueryToolPolicy` (e.g. a fake `delete_record`), and asserts the
  registry throws `tool not found` so no handler runs.
- **Why it earns its place:** turns the architectural claim into a regression
  test — the exact artifact that survives a security review.
- **Files to touch:** new test in `packages/agents/rag-query/test/`, using
  `packages/agents/query/src/fixture-provider.ts` and
  `packages/runtime/src/run-agent-loop.ts:159`.
- **Done when:** the test asserts an unregistered/unallowed tool name produces an
  error result and zero side effects.
- **Estimated effort:** `1–4hr`

### (Case B) Add an output-validation gate for a write-capable agent
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a design note for an agent that *can* mutate, specifying a
  `JsonValidator` on the tool arguments plus a confirmation step before any write
  handler runs — closing the `not yet exercised` input/output-safety gap for the
  one case where reads-only isn't enough.
- **Why it earns its place:** forces the conversation about what changes when an
  agent leaves the read-only allowlist regime.
- **Files to touch:** design note referencing
  `packages/runtime/src/structured-generation.ts:85`,
  `packages/tools/src/tool-policy.ts:11`, and
  `packages/agents/query/src/query-agent.ts:10`.
- **Done when:** the note states which gate (policy / validator / confirmation)
  stops which attack, and why reads-only agents don't need the last one.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "How does aptkit stop prompt injection from triggering a destructive action?"**
By removing the model's authority to act. The model can only emit a `tool_use`
block *naming* a tool; a least-privilege policy filters the menu (the rag-query
agent sees one tool; the query agent sees ~45, all reads); and the registry only
runs *registered* handlers. The worst an injection achieves is naming a tool — and
naming is harmless when the menu holds no writes.

```
  model:    "call delete_record"   (just text — a request)
  policy:   delete_record not on allowlist → never offered → model can't name it
  registry: even if named, no handler registered → throws → nothing runs
```
Anchor: *`run-agent-loop.ts:159` — the model names; `callTool` decides.*

**Q: "You don't sanitize input or run an output-safety model — isn't that weak?"**
Those are softer controls, and they're `not yet exercised`. But they sit *on top
of* a boundary that already holds: the model can't execute anything, only propose
a name through three gates. A sanitizer is a control you hope is complete; the
registry + read-only allowlist is a boundary that's complete by construction.

```
  sanitizer:  detect bad text  → hope you caught it all   (control, not built)
  boundary:   model can't act  → naming is harmless        (built, structural)
```
Anchor: *defense by architecture beats defense by detection.*

## See also

- `01-llm-foundations/04-structured-outputs.md` — the validator gate in full
- `04-agents-and-tool-use/02-tool-calling.md` — what a `tool_use` block is
- `05-retry-circuit-breaker.md` — handling a model that fails, not attacks
