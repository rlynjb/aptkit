# 02 — Agent Memory Tiers

*Agent memory / memory tiers / "what the agent remembers" — Pattern + honest
in-codebase (the three-tier model is universal; AptKit implements exactly one
tier).*

## Zoom out, then zoom in

"Memory" in agents is an overloaded word, and the fastest way to think clearly
about it is to separate it by *lifetime* — how long a piece of information
survives. Three tiers fall out, and most production confusion comes from
conflating them. AptKit is a clean teaching case because it implements exactly
one tier and is honest about the other two.

```
  Memory tiers by lifetime (longest-lived at the bottom)

  ┌─ WORKING memory ── lives for ONE run ──────────────────────────────┐
  │  the messages[] array: user + assistant + tool_result blocks        │
  │  born when runAgentLoop starts, GONE when it returns                 │
  │  ★ AptKit implements THIS tier, and only this tier ★                 │
  └───────────────────────────────┬─────────────────────────────────────┘
                                  │  would survive past one run...
  ┌─ EPISODIC memory ── lives across runs/sessions ────────────────────┐
  │  "what happened last time": prior runs, past judgments, history     │
  │  NOT in AptKit (the rubric agent's history tools are HOST-provided)  │
  └───────────────────────────────┬─────────────────────────────────────┘
                                  │  ...and would survive indefinitely
  ┌─ LONG-TERM memory ── lives indefinitely, semantic ─────────────────┐
  │  facts/embeddings in a vector store, retrieved by similarity        │
  │  NOT in AptKit (no vector store, no cross-session persistence)      │
  └─────────────────────────────────────────────────────────────────────┘
```

The frontend anchor: working memory is `useState` inside a mounted component —
it lives while the component is mounted and vanishes on unmount. Episodic memory
is `localStorage` — it survives the page reload. Long-term memory is the backend
database your app queries by key or similarity. AptKit has `useState` and stops
there.

## Structure pass

Trace the **persistence axis** — *where does the data physically live, and what
event destroys it.* This is the seam between "in the function" and "outside it."

```
  The persistence axis: where memory lives and what kills it

  Tier        Lives in                  Destroyed by            In AptKit?
  ──────────  ────────────────────────  ──────────────────────  ──────────
  working     messages[] (JS array,      runAgentLoop returns    YES (line 94)
              in-function, in-RAM)        (GC'd)
  ─ ─ ─ ─ ─   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  ─ ─ ◄ SEAM
  episodic    a store the HOST owns       host policy             NO (host-only)
              (DB, cache, file)
  long-term   a vector DB / KV store      never (until evicted)   NO
```

The seam is the `return` statement of `runAgentLoop`. Above it: `messages[]`
holds the agent's full run memory. Below it — the instant the function returns —
that array is garbage collected. There is no write-through to any store. That
single fact is the whole memory story: AptKit's memory is the working tier, and
its lifetime is one function call.

## How it works

### Move 1 — the mental model

Each tier is a different scope of *recall*. Working memory recalls "this run."
Episodic recalls "past runs." Long-term recalls "everything I was ever told."
You add a tier only when the agent demonstrably needs to recall beyond the scope
it has — and each tier you add is a store you now own, write to, evict from, and
secure.

```
  Memory tiers as widening recall scopes (PATTERN)

  query about THIS run        ──▶ WORKING   (just read messages[])
  "did we see this before?"   ──▶ EPISODIC  (query a runs store)
  "what do we know about X?"  ──▶ LONG-TERM (similarity search a vector DB)

  scope widens ───────────────────────────────────────────▶
  cost & ownership widen with it (each tier = a store you maintain)
```

The discipline: don't add episodic/long-term because it sounds smart. Add it
when a run *fails for lack of cross-run recall* — otherwise you've bought a
database, a staleness problem, and a privacy surface for nothing.

### Move 2 — the tiers, one at a time

**Tier 1 — WORKING memory (the only one AptKit has)**

```
  messages[] IS working memory; it accumulates then dies

  runAgentLoop starts
       │
  messages = [ userPrompt ]                    ← born (line 94)
       │  each turn: push assistant, push tool_result
  messages = [ user, asst, tool_result, asst, tool_result, ... ]
       │
  runAgentLoop returns ──▶ messages GC'd       ← dies; nothing persisted
```

Pseudocode: `messages = [userPrompt]; loop pushes turns; return; // array gone`.
The model "remembers" everything within a run because the whole array is re-sent
each turn. It remembers *nothing* across runs because the array doesn't outlive
the call.

**Tier 2 — EPISODIC memory (absent; what it would look like)**

```
  episodic = a store the agent reads AND writes across runs

  run N:   ... → write { runId, outcome, anomalies } to a runs store
  run N+1: read recent runs ──▶ inject into context ──▶ "last time, X happened"
       ▲
   AptKit has neither the write nor the read; messages[] dies on return
```

Pseudocode (hypothetical): `before run: history = store.recent(); after run:
store.append(result)`. AptKit does neither. The closest-looking thing — the
rubric agent's `get_recent_judgments` / `get_user_pattern_history` — is a *tool*
the host wires in, not a memory store AptKit owns (next section).

**Tier 3 — LONG-TERM memory (absent; what it would look like)**

```
  long-term = embed facts, retrieve by similarity, no fixed schema

  fact ──▶ embed ──▶ vector store
  query ──▶ embed ──▶ nearest-neighbor search ──▶ relevant facts into context
       ▲
   AptKit has no embeddings, no vector store, no semantic recall
```

Pseudocode (hypothetical): `relevant = vectorStore.search(embed(query), k=5)`.
AptKit's "retrieval" is tool-calling over analytics APIs plus the deterministic
schema summary — not similarity search.

### Move 3 — the principle

Memory is recall scoped by lifetime, and every tier past working memory is an
*owned store* with its own cost, staleness, and privacy burden. The honest
default is working-only; you escalate to episodic/long-term only when a concrete
failure forces it.

## Primary diagram

AptKit's actual memory architecture — one tier, drawn against the two it omits.

```
  AptKit memory: working tier only

  ┌─ run #1 ──────────────┐   ┌─ run #2 ──────────────┐   ┌─ run #3 ─────┐
  │ messages = [...]      │   │ messages = [...]      │   │ messages=[..]│
  │ (lives here only)     │   │ (fresh, knows nothing │   │  (fresh)     │
  │                       │   │  of run #1)           │   │              │
  └───────────┬───────────┘   └───────────────────────┘   └──────────────┘
              │ return
              ▼
        [ GARBAGE COLLECTED ]   ← no episodic write, no long-term store
                                  run #2 starts with a blank slate

  ┌─ EPISODIC store ──┐   ┌─ LONG-TERM vector store ──┐
  │   (does not exist) │   │      (does not exist)      │
  └────────────────────┘   └────────────────────────────┘
```

Each run is independent. Run #2 cannot know what run #1 found, because the only
memory was `messages[]` and it died on return. That isolation is *by design* for
a single-agent analytics tool — and it's exactly why the latent pipeline
(`../03-multi-agent-orchestration/03-sequential-pipeline.md`) passes data by
*return value*, not by a shared memory store.

## Implementation in codebase

**Use case — working memory is `messages[]`, full stop.**
`packages/runtime/src/run-agent-loop.ts:94`:

```ts
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }]; // line 94
// ... each turn:
messages.push({ role: 'assistant', content: response.content });          // line 124
// ... after tool calls:
messages.push({ role: 'user', content: toolResults });                    // line 189
// ...
return { finalText, toolCalls, parsed };                                   // line 201 ← messages dies
```

Line 94 is the birth, lines 124/189 are the accumulation, line 201 is the death.
There is no `store.save(messages)` anywhere — search the runtime and you won't
find a persistence call. That absence *is* the architecture.

**The closest thing to episodic memory — and why it isn't AptKit's.**
`packages/agents/rubric-improvement/src/rubric-improvement-agent.ts:17-24`:

```ts
allowedTools: [
  'get_recent_judgments',        // ← reads PRIOR judgments...
  'get_user_pattern_history',    // ← reads PRIOR user patterns...
  'get_rubric_definition',
  'get_current_attempt_context',
  'save_judgment',               // ← even writes one back
  'generate_next_scenario',
] as const,
```

This *looks* like episodic memory: the agent can read recent judgments and even
`save_judgment`. But it's a **tool policy** (an allowlist of tool *names*), not a
memory store AptKit implements. The handlers behind those names are wired by the
host (`InMemoryToolRegistry` in tests, real services in production) — AptKit
defines the *interface* the agent reaches through, never the store. So the
honest classification: AptKit gives the rubric agent a *door* to host-provided
episodic data; it does not own the room behind it. Cross-link to
`03-tool-calling-and-mcp.md` for why a tool name is not a capability.

**Not yet exercised: episodic memory (AptKit-owned).** No agent reads its own
prior runs from a store AptKit maintains; `messages[]` dies on return and nothing
writes it through. See SECTION F (`../06-orchestration-system-design-templates/`)
for the runs-store design.

**Not yet exercised: long-term / vector memory.** No embeddings, no vector store,
no similarity recall anywhere in the repo. See SECTION F.

## Elaborate

**Origin.** The working/episodic/long-term split is borrowed from cognitive
science and adopted by agent frameworks (LangChain memory, the MemGPT/letta line
of work). The useful engineering insight is that they differ by *lifetime and
retrieval method*, not by importance.

**Adjacent — why working-only is often right.** Cross-run memory is a liability
until it's an asset: it goes stale, it leaks data across users/sessions (a
privacy surface), and it makes runs non-reproducible. A stateless agent is
trivially reproducible — which is exactly what makes AptKit's deterministic
replay eval possible (`04-agent-evaluation.md`). Statelessness and testability
are the same property.

**Adjacent — the message array as the only memory ties directly to context
engineering.** Working memory *is* the dynamic half of the context window
(`01-context-engineering.md`); growing `messages[]` is the same as growing the
window, which is why the budgets bound both at once.

## Interview defense

**Q: "What kind of memory does your agent have?"**

```
  working ONLY: messages[] (run-agent-loop.ts:94), dies on return
  episodic: NO   long-term: NO   vector store: NO
```

Anchor: "Working tier only — the message array, scoped to one run, garbage
collected on return. No episodic, no long-term, no vector store. That's a
deliberate choice for a stateless, reproducible analytics agent."

**Q: "But the rubric agent has `get_recent_judgments` — isn't that memory?"**

```
  tool NAME in a policy  ≠  a memory store AptKit owns
  rubric-improvement-agent.ts:17 = allowlist; handler is HOST-provided
```

Anchor: "That's a host-provided tool, not an AptKit memory store. AptKit defines
the door — the tool interface — but never owns the room behind it. It's the
closest thing to episodic memory and it's still not one."

**Q: "When would you add episodic or long-term memory?"**

```
  add a tier ONLY on a concrete failure of recall:
    runs repeat work  ──▶ episodic (a runs store)
    needs semantic fact recall ──▶ long-term (vector store)
  each tier = a store you own, evict, and secure
```

Anchor: "When a run fails for lack of cross-run recall — not before. Each tier is
a database with staleness and privacy costs, so working-only is the honest
default." This is the load-bearing judgment: memory is a liability you add on
evidence, not a feature you add by default.

## Validate

- **Reconstruct:** Draw the three tiers by lifetime and mark which AptKit has
  (working: yes, line 94; episodic: no; long-term: no).
- **Explain:** Why does run #2 know nothing about run #1?
  (`run-agent-loop.ts:201` — `messages[]` is the only memory and it's GC'd on
  return; no write-through store exists.)
- **Apply:** You want the diagnostic agent to avoid re-investigating an anomaly
  it concluded on yesterday. Which tier, and where does it read? (episodic — a
  runs store read before the loop and injected into the prompt; AptKit doesn't
  have it yet — SECTION F.)
- **Defend:** A teammate calls the rubric agent "stateful because it has
  `save_judgment`." Correct them. (`rubric-improvement-agent.ts:17-24` — that's a
  tool *name* in an allowlist; the store is host-provided, AptKit owns no memory.)

## See also

- [01-context-engineering.md](01-context-engineering.md) — working memory is the
  dynamic half of the context window
- [03-tool-calling-and-mcp.md](03-tool-calling-and-mcp.md) — why a tool name in a
  policy is not a capability AptKit owns
- [04-agent-evaluation.md](04-agent-evaluation.md) — statelessness is what makes
  deterministic replay possible
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — `messages[]` birth and
  death in the kernel
- `../03-multi-agent-orchestration/03-sequential-pipeline.md` — why agents pass
  data by return value, not shared memory
- `.aipe/study-ai-engineering/` — the agent-memory two-layer split, taught from
  first principles
