# Retrieval-miss diagnosis — reading the trajectory to find a silent zero-result

**Industry names:** trajectory debugging · silent-filter / empty-result bug · agent post-mortem from the trace. **Type:** Project-specific war story over a language-agnostic technique (read the persisted trajectory backward from the symptom).

## Zoom out, then zoom in

This is the one file in the guide built around a *real bug that happened this session* — and the diagnosis path is the lesson. The symptom: the rag-query agent answered **"I couldn't find anything in the knowledge base to answer that"** despite a corpus that obviously contained the answer. No error. No exception. No warning. The agent did everything right and still came up empty. That silence is exactly what makes it a teaching case — the bug had no signal *except* the trace.

Here's where the evidence for this lives, and the seam where it crosses into another repo:

```
  Zoom out — where the diagnosis evidence lives (two repos)

  ┌─ aptkit (this repo) — emits the evidence ───────────────────────────┐
  │  RagQueryAgent.answer() → runAgentLoop → trace.emit(CapabilityEvent) │
  │      tool_call_start { toolName, args }  ← the smoking gun is HERE    │
  │      tool_call_end   { result }          ← result.results = []        │
  └───────────────────────────────────┬──────────────────────────────────┘
                                       │ same CapabilityEvent stream
  ┌─ buffr (sibling repo) — PERSISTS the trajectory ▼───────────────────┐
  │  agents.messages — the saved trajectory you read back after the run  │
  │  ★ the diagnosis happened HERE: trajectory → tool args → 0 results ★ │
  └──────────────────────────────────────────────────────────────────────┘
```

Note the partition: **aptkit emits the trace; buffr persists the trajectory.** The bug surfaced during buffr's "Supabase graduation" end-to-end run (see the commit message on `c5dbf1a`), but the *root cause and the fix* are both in aptkit — in the retrieval tool. This file teaches the diagnosis technique using aptkit's emitted evidence; the persisted-trajectory store itself is buffr's.

Zoom in: the pattern is **diagnosing a silent failure by reading the trajectory backward from the symptom.** No stack trace points at this bug because nothing threw. The only way in is the trace: start at the wrong answer, walk back to the tool call that produced it, and read the *arguments the model actually passed*.

## The structure pass

**Layers, top to bottom of the failure.** Four: the model's decision (it chose to call the search tool), the arguments it emitted, the tool's filter logic, and the vector store's results. Hold one axis constant — **failure: where did it originate vs where did it surface?**

```
  Axis = "where does the failure originate vs surface?" — traced down

  ┌────────────────────────────────────┐
  │ model decides to search            │  → CORRECT (not the bug)
  └────────────────────────────────────┘
      ┌────────────────────────────────┐
      │ model emits args:              │  → ORIGIN: hallucinated a
      │   { query, filter:{textContains}}│    filter key no chunk has
      └────────────────────────────────┘
          ┌────────────────────────────┐
          │ tool's exact-match filter  │  → PROPAGATES: silently
          │   excludes every hit       │    drops all results, no error
          └────────────────────────────┘
              ┌────────────────────────┐
              │ agent: "not available" │  → SURFACES here, far from origin
              └────────────────────────┘

  origin and symptom are THREE layers apart — that distance is why it's hard
```

**The load-bearing seam** is between "model emits args" and "tool's filter logic." The failure *originates* at the model (hallucinated `{textContains: "..."}`) but is *silently amplified* at the filter: an exact-match filter on a key no chunk carries excludes 100% of hits and returns `[]` with no complaint. The diagnosis is finding *which side of that seam* is at fault — and the answer is "both, but the fix goes on the tool side, because you can't stop a weak model from hallucinating."

Hand off: the skeleton is a four-layer failure where origin and symptom are far apart, and the only bridge between them is the trace.

## How it works

#### Move 1 — the mental model

You know the frontend bug where a `.filter()` predicate is subtly wrong and your list renders empty — no error, just nothing? Same shape. The list isn't empty because there's no data; it's empty because the predicate rejected everything. Here the predicate is a metadata filter, the "data" is retrieved chunks, and the empty render is the agent saying "not available."

```
  The silent-empty-result pattern

  good corpus ──► retrieve N hits ──► filter(hit) ──► [] ──► "not available"
                                        │              │
                                  predicate rejects   no error, no warning:
                                  ALL of them         empty is a valid result

  the trap: an empty result is INDISTINGUISHABLE from "nothing matched the query"
            unless you can see the FILTER ARGS — which only the trace has
```

The kernel of the *diagnosis* is three reads, backward:

#### Move 2 — the walkthrough (the diagnosis, step by step)

**Read 1 — start at the symptom, not the code.** The agent returned the `FALLBACK_ANSWER` (`rag-query-agent.ts:31`: "I couldn't find anything in the knowledge base"). That string only appears when `finalText.trim()` is empty *or* when the model genuinely had nothing to ground on (`:82`). So step one is: was retrieval empty, or did the model ignore good retrieval? You cannot tell from the answer alone. *Bridge:* this is the same "is the bug in fetch or in render?" fork you split every frontend data bug on.

**Read 2 — walk back to `tool_call_end`.** The trace's `tool_call_end` event carries `result` (`events.ts:5-12`). Reading it answers Read 1 instantly: `result.results` was `[]`. So retrieval *was* empty — the model didn't ignore data, there was no data to ignore. This narrows the failure from "anywhere in the agent" to "inside the search tool." *Bridge:* you just used the trace the way you'd use a Network tab — inspect the response body of the one call that mattered.

```
  Reading the trace backward — three reads, symptom → cause

  symptom:  finalText == FALLBACK_ANSWER        (rag-query-agent.ts:31,82)
                  ▲
            Read 3│ tool_call_start.args = { query:"...", filter:{textContains:"x"} }
                  │        ← THE SMOKING GUN: a filter key no chunk carries
                  ▲
            Read 2│ tool_call_end.result.results = []   ← retrieval was empty
                  │
            Read 1│ "empty answer" — but WHY empty? (must look further)
                  ▲
                  └─ the answer alone can't tell you; each read up the trace narrows it
```

**Read 3 — read the `tool_call_start.args` — the smoking gun.** The `tool_call_start` event carries the exact `args` the model passed (`events.ts:3`, emitted at `run-agent-loop.ts:147-148`). Reading it: the model passed `filter: { textContains: "moon" }` (or similar) — a filter key that **no chunk in the corpus carries**. That's the root cause in one line. The model hallucinated a plausible-sounding filter field, and the tool's exact-match logic dutifully excluded every hit because no chunk had a `textContains` key equal to that value. *Bridge:* this is "log the actual arguments, not just that the function was called" — the args are the evidence; the call alone is not.

**The fix — move the robustness to the side you control.** You can't stop a weak local model from hallucinating filter keys. So the fix goes in the tool: a filter key now only *excludes* a hit that **has that key with a different value**; keys absent from a chunk's meta are ignored (`search-knowledge-base-tool.ts:101-106`, `matchesFilter`). A hallucinated `{textContains}` that no chunk carries now matches everything instead of nothing. *What breaks without this:* the exact bug — a single invented key silently zeroes retrieval and the agent goes mute on a full corpus.

#### Move 2 variant — the load-bearing skeleton of the diagnosis

The irreducible kernel here isn't a data structure — it's the *diagnostic capability*: **the trace records the model's actual tool arguments, separately from the tool's actual result.** Strip either and the diagnosis dies:

- Drop `tool_call_start.args` and you see retrieval returned `[]` but *never learn why* — you'd suspect the corpus, the embedder, the query, anything but the filter. The args are what point at the filter.
- Drop `tool_call_end.result` and you can't even confirm retrieval was empty — you'd be guessing whether the model ignored data or had none.

Both events together turn a three-layers-deep silent failure into a two-read diagnosis. That's the load-bearing observability property: **arguments and results are captured as distinct events**, so you can stand between them and see exactly where the chain broke.

#### Move 3 — the principle

A silent empty result is the hardest class of bug because *empty is a valid value* — nothing throws, nothing warns. The only defense is a trace that captures **inputs and outputs as separate evidence at every boundary**, so when the output is suspiciously empty you can read the input that produced it. And the fix-side principle: when an untrusted producer (a weak model) feeds a strict consumer (an exact-match filter), put the tolerance on the consumer — *ignore what you don't recognize* rather than *reject everything that doesn't match.*

## Primary diagram

The whole war story — the failure chain and the backward diagnosis — in one frame.

```
  Retrieval-miss diagnosis — the failure (down) read backward (up)

  ┌─ Runtime (aptkit) ──────────────────────────────────────────────────┐
  │                                                                      │
  │  model decides: call search_knowledge_base          ✓ correct        │
  │        │ emits args                                                  │
  │        ▼                                                             │
  │  tool_call_start { args: { query, filter:{textContains:"x"} } } ◄────┼── Read 3
  │        │                                              ✗ ORIGIN        │   (smoking gun)
  │        ▼                                                             │
  │  matchesFilter (OLD): key absent ⇒ exclude ⇒ every hit dropped       │
  │        │                                              ✗ AMPLIFIES     │
  │        ▼                                                             │
  │  tool_call_end { result: { results: [] } }          ◄───────────────┼── Read 2
  │        │                                              (empty, no error)│  (empty? yes)
  │        ▼                                                             │
  │  finalText empty → FALLBACK_ANSWER "not available"  ◄────────────────┼── Read 1
  │                                                       ✗ SURFACES      │   (the symptom)
  └──────────────────────────────────────────────────────────────────────┘
       │ persisted as trajectory in →  buffr agents.messages (where it was read)
       ▼
  FIX (aptkit): matchesFilter (NEW) — absent key ⇒ IGNORE, not exclude
                (search-knowledge-base-tool.ts:101-106) + regression test (:105-117)
```

## Implementation in codebase

**Use cases.** This is the concrete debugging session: during buffr's Supabase-graduation end-to-end run, the rag-query agent went mute on a populated corpus. The diagnosis read the persisted trajectory (buffr's `agents.messages`) — which is the same `CapabilityEvent` stream aptkit emits — backward from the "not available" answer to the hallucinated filter arg. The fix and its regression guard both landed in aptkit's retrieval tool.

**Code side by side — the root cause and its fix.**

```
  packages/retrieval/src/search-knowledge-base-tool.ts  (matchesFilter, 101–106)

  function matchesFilter(hit, filter) {
    // A filter key only excludes hits that HAVE that key with a different value.
    // Keys absent from a chunk's meta are ignored, so a weak model's hallucinated
    // filter (e.g. {textContains: "x"}) can't silently wipe every result.
    return Object.entries(filter).every(
      ([key, value]) => !(key in hit.meta) || hit.meta[key] === value
    );                              │              │
  }                                 │              └─ present-and-equal ⇒ keep
                                    └─ ABSENT key ⇒ short-circuit true ⇒ keep
       │
       └─ the `!(key in hit.meta) ||` is the entire fix. Before, a hallucinated
          key was treated as "must equal X" against a chunk that has no such key,
          so `undefined === "x"` was false ⇒ every hit excluded ⇒ silent [].
          Now an unrecognized key is ignored. (load-bearing: this one clause)
```

The companion change is on the *retrieval-volume* side — the same class of "weak model starves its own retrieval," caught the same way:

```
  packages/retrieval/src/search-knowledge-base-tool.ts  (minTopK floor, 50–51, 80–81)

  const minTopK = Math.max(1, options.minTopK ?? 1);
  ...
  const topK = Math.max(requestedTopK, minTopK);   ← floor the model's top_k
       │
       └─ Gemma tends to pass top_k: 1, starving multi-part questions. The floor
          (set to 4 in ask.ts:48) lifts it back up regardless of what the model asks.
          Same lesson: put the robustness on the side you control, not the model.
```

**The regression guard — the diagnosis locked into a test.**

```
  packages/retrieval/test/search-knowledge-base-tool.test.ts  (105–117)

  test('ignores filter keys absent from chunk metadata
        (a hallucinated filter does not wipe results)', async () => {
    // A weak model invents a filter key no chunk carries. Must NOT zero retrieval.
    const { result } = await registry.callTool(SEARCH_KNOWLEDGE_BASE_TOOL_NAME, {
      query: 'how often does the moon orbit earth',
      filter: { textContains: 'moon' },        ← the exact hallucinated shape
    });
    assert.ok(payload.results.length > 0,      ← the bug would make this 0
      'hallucinated filter key should be ignored, not exclude everything');
  });
       │
       └─ this test IS the prevention half of the incident loop: the bug that
          had no signal now has a permanent one — it fails loudly if reintroduced
```

This is the local-incident loop from `audit.md` lens 7 run end to end: bad run → read trajectory → root cause (hallucinated filter) → fix the tool → lock it with a regression test. The bug that was *invisible* (silent empty result) is now *impossible to reintroduce silently* (a red test).

## Elaborate

This bug is a textbook **Postel's-law inversion gone wrong, then corrected.** The original filter was strict ("be conservative in what you accept") against a producer that is inherently sloppy (an LLM). When the producer can't be made strict, the consumer must be made liberal — "ignore what you don't understand." That's the move in `matchesFilter`.

The deeper lesson is about *where signal lives in agent systems.* Traditional code fails loudly — exceptions, stack traces, non-zero exits. Agent systems fail *quietly*: a model passes a slightly-wrong argument and the system produces a plausible empty or wrong answer with no error anywhere. The defense is structural — capture every tool's inputs and outputs as distinct trace events (`01-structured-trace-events.md`) so the silent failures leave evidence even when they leave no error.

#### The same blind spot, now in memory recall (`@aptkit/memory`)

This war story is about `search_knowledge_base`, but the class is wider than one tool — and `@aptkit/memory` (added since this guide was first written) is the second instance. `search_memory` (`packages/memory/src/memory-tool.ts:34-60`) is a vector-search tool just like `search_knowledge_base`: the model calls it through the same registry, so a recall flows through the same loop and emits the **same two trace events** — `tool_call_start.args` (the recall query the model chose) and `tool_call_end.result` (the recalled exchanges). *Inference, not yet observed:* `search_memory` is exported (`packages/core/src/index.ts:8`) and unit-tested through an `InMemoryToolRegistry` (`packages/memory/test/memory-tool.test.ts:28-31`) but **not yet wired into any agent's loop** — so when an agent does register it, the diagnosis path in this file transfers verbatim, because the loop emits `tool_call_start`/`end` for any registered tool by name (`run-agent-loop.ts:147-179`).

And recall has the *exact* silent-empty failure: `recall()` can return `[]` and the agent can't tell "no relevant past exchange exists" from "a miss." Two places produce the empty, both at `conversation-memory.ts:89-106`:

```
  recall()'s two silent-empty sources — conversation-memory.ts:89-106

  embed(query) ─► no vector? ──► return []          (:91, embedder gave nothing)
       │
       ▼ vector
  store.search(vector, fetchK)  fetchK = max(k*4, 20)   (:94, OVER-FETCH)
       │ hits (may include documents above memory rows)
       ▼
  .filter(h.meta.kind === kind)  ────► [] possible      (:97, KIND-FILTER)
       │                                    │
       ▼ .slice(0, k)                       └─ the over-fetch can come back
  MemoryHit[]  (often shorter than k)          ALL documents, zero memory rows
                                               → recall returns [] unexpectedly
```

The load-bearing line is the same shape as `matchesFilter`: a **post-fetch filter that can legitimately reject everything.** Because the VectorStore contract has no metadata filter, `recall` over-fetches `max(k*4, 20)` then keeps only `meta.kind === kind` rows (`:94-97`). On a store that mixes memory with documents, the top `fetchK` results can be *all documents* — the kind-filter then removes everything and recall returns `[]` even though relevant memory rows exist further down the ranking. That is indistinguishable, from the agent's side, from "this user has no memory." The same diagnosis applies: read `tool_call_start.args` (was the recall query reasonable?) and `tool_call_end.result` (`[]`?), then — because the empty is *inside* recall, not the tool wrapper — suspect the kind-filter-after-over-fetch, exactly where `matchesFilter` was the suspect here. The standing fix-shape is identical: a zero-hit recall on a non-empty memory store deserves a proactive `warning`, not just forensic trace evidence (see `audit.md` red-flag 1).

## Interview defense

**Q: An agent returns "I don't have that information" but the data is clearly in the knowledge base. No errors. How do you debug it?**
Read the trajectory backward from the answer. First confirm whether retrieval was actually empty — look at `tool_call_end.result`. If it's `[]`, the problem is *in retrieval*, not generation. Then read `tool_call_start.args` to see what the model actually passed the search tool. In our case it hallucinated a filter key no chunk carried, and the exact-match filter silently excluded every hit. The load-bearing detail: **the trace captures tool arguments and tool results as separate events**, so you can stand between them and pinpoint that retrieval ran but returned nothing *because of the args* — not because the corpus was empty.

```
  the answer in one picture

  "not available"  →  read tool_call_end.result == []  →  read tool_call_start.args
                            (retrieval WAS empty)          (filter:{textContains} —
                                                            a key no chunk has)
                                                                  │
                                                       fix: ignore unknown filter keys
```

**Anchor:** "Empty is a valid value, so nothing throws — the only thread is the trace. I read the result first to confirm it was empty, then the args to see *why*: a hallucinated filter key the exact-match filter treated as 'must equal,' excluding everything."

**Q: Whose fault was it — the model or the tool? Where does the fix go?**
Both contributed, but the fix goes on the tool. You can't stop a weak local model from inventing plausible filter keys, so you make the consumer tolerant: an unrecognized key is ignored, not treated as an exclusion. Same principle as the `minTopK` floor — put the robustness on the side you control.

## Validate

1. **Reconstruct:** Draw the four-layer failure chain (model decision → args → filter → result) and mark which layer was the *origin* and which was the *symptom* (`search-knowledge-base-tool.ts:101-106` origin-amplifier; `rag-query-agent.ts:31,82` symptom).
2. **Explain:** Why couldn't a stack trace find this bug? (Nothing threw — an empty filtered result is a valid value.) Which two trace events were load-bearing for the diagnosis, and what does each tell you? (`tool_call_start.args` = the hallucinated filter; `tool_call_end.result` = retrieval was empty.)
3. **Apply:** A different agent returns a wrong (not empty) answer. Walk the same backward read — which event do you check first, and what would tell you retrieval was *fine* but the model ignored it? (`tool_call_end.result` non-empty + relevant ⇒ the failure moved to synthesis, not retrieval.)
4. **Defend:** A reviewer says "just validate the model's filter against a known-keys allowlist." Argue why the chosen fix (ignore unknown keys in `matchesFilter`, `:105`) is better for a weak local model than rejecting unknown keys — and what the regression test (`:105-117`) buys you.

## See also

- `01-structured-trace-events.md` — the `tool_call_start`/`tool_call_end` events whose `args` and `result` fields made this diagnosis possible. This war story is the payoff of that primitive.
- `02-replay-artifact-as-snapshot.md` — had this run been saved as an artifact, the whole trajectory (args included) would be in the JSON; the diagnosis is the same read, offline.
- `07-reproduction-spike-harness.md` — the spike tests tool *emission*, not retrieval *correctness*; this bug is exactly the class a pre-build spike can't catch and a trace read can.
- `@aptkit/memory` (`packages/memory/src/conversation-memory.ts:89-106`) — `search_memory` is the second instance of this exact class: a recall that returns `[]` from the kind-filter-after-over-fetch looks the same as "no memory exists," diagnosed by the same `tool_call_start.args` / `tool_call_end.result` read (see the Elaborate section above). Observable via the existing trace once an agent wires the tool.
- `study-ai-engineering` — the retrieval pipeline, the `search_knowledge_base` and `search_memory` tools, hallucinated tool arguments as a failure mode.
- `study-testing` — the regression test as the prevention half of the incident loop.
