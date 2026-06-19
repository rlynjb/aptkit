# 00 — Overview: AptKit through a DSA lens

## The verdict first

AptKit is a small set of data structures used well, not a large set used badly. If you opened every `.ts` file and tallied the structures, the count is short: **`Map` (one, the tool registry), `Set` (allowlists, dedup), discriminated unions (the event and rule streams), arrays-as-logs (the message transcript), modulo round-robin (variant scheduling), and `Array.prototype.sort` comparators (ranking).** That is the working vocabulary. Everything else a textbook would list — trees, heaps, graphs, binary search, dynamic programming — is genuinely absent, and the absence is correct for what this codebase is: a stateless orchestration layer over an LLM, where the expensive thing is a model round-trip, not a CPU cycle.

Here is the whole repo as one DSA picture before we zoom into any single structure.

```
  AptKit — the structures, by layer

  ┌─ Agent capability (per-agent package) ───────────────────────────┐
  │  message array  →  comparator sort + slice (top-k ranking)       │
  │  (transcript log)     anomaly-monitoring, recommendation         │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ calls
  ┌─ Runtime (foundation) ────▼──────────────────────────────────────┐
  │  bounded loop over message array   discriminated union           │
  │  (turn budget = termination)       (CapabilityEvent stream)      │
  │  bounded JSON substring scan       reduce over event log         │
  │  (parseAgentJson)                  (usage-ledger)                 │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ uses
  ┌─ Tools / context / evals ─▼──────────────────────────────────────┐
  │  Map<name,handler>   Set<allowedTools>   Set membership (coverage)│
  │  (registry lookup)   (policy filter)     dotted-path walk (diff)  │
  └───────────────────────────────────────────────────────────────────┘
```

Read it from the bottom: the substrate is `Map` and `Set` lookups and a dotted-path JSON walk. The middle is a bounded loop over an array and a discriminated-union stream. The top is comparator sorts that rank and `slice` that caps. No layer needs an ordered tree, a heap, or a graph traversal — the data is small (≤10 anomalies, ≤3 recommendations, ~49 tools, a handful of events), so linear scans and hash lookups win on both simplicity and real-world speed.

## Ranked findings — what's most consequential

These are ordered by how much they shape the codebase, not alphabetically.

**1. The `Map`-backed `InMemoryToolRegistry` is the most load-bearing structure in the repo.** `packages/tools/src/tool-registry.ts:34` holds `handlers = new Map<string, ToolHandler>()`, and `callTool` (`:50`) is an O(1) `Map.get` followed by an invocation with a wall-clock timing. Every tool the model calls routes through this one `Map`. It is the hot path's only real data-structure lookup. → `02-arrays-strings-and-hash-maps.md`.

**2. `Set` is the repo's correctness primitive, not just a convenience.** Three independent places turn an allowlist or expected-list into a `Set` and ask membership questions: tool-policy least-privilege filtering (`tool-policy.ts:15`), coverage gating (`coverage-gate.ts:42`), and detection scoring's matched/missed/unexpected partition (`detection-scorer.ts:64,80`). The `Set` is what makes "did the model stay inside its allowed tools" an O(1) check instead of an O(n) scan. → `02-arrays-strings-and-hash-maps.md`.

**3. The real cost model is tokens-and-turns, not Big-O.** `run-agent-loop.ts:98` bounds the loop with `turn < maxTurns`, `:101` adds a `maxToolCalls` budget, and `usage-ledger.ts:25` reduces the event stream into a token total that `estimateCost` (`:50`) prices in USD. The asymptotic complexity of any structure here is dwarfed by the cost of one model round-trip. This is the cost axis that actually bites. → `01-complexity-and-cost-models.md`.

**4. Round-robin modulo scheduling is the only non-trivial *algorithm* in the repo.** `content-generation-workflow.ts:148-156` (`planContentVariant`) uses `variantIndex % sections.length` and `variantIndex % angles.length` to fan content variants evenly across sections and angles. It is a clean, classic technique and the closest thing to an "algorithm with a name" outside of sort. → `03-stacks-queues-deques-and-heaps.md`.

**5. Ranking is comparator-sort-then-slice, repeated.** `monitoring-agent.ts:86-88` sorts anomalies by a `severityRank` lookup table descending, then `slice(0, 10)` caps the output — a top-k by full sort. The same shape (sort by a derived key, take a prefix) recurs wherever the repo ranks. No heap-based selection, because k is tiny. → `06-sorting-searching-and-selection.md`.

## The `not yet exercised` list — and when each would matter here

This is the honest half. Each of these is a foundation you've already built in `reincodes`; none appears in AptKit, and here's the trigger that would change that.

```
  foundation            status in aptkit       what would pull it in

  binary search         not yet exercised      sorted artifact index large
                                                enough that linear scan hurts
  heap / priority queue not yet exercised      top-k where k << n and n is
                                                large; bounded-concurrency
                                                scheduler over many tasks
  balanced tree / index not yet exercised      a persistent ordered store of
                                                replays queried by range
  trie                  not yet exercised      prefix routing over hundreds of
                                                tool names or intents
  graph + BFS/DFS       not yet exercised      capability dependencies that
                                                actually chain (A enables B
                                                enables C), needing topo order
  dynamic programming   not yet exercised      optimal sub-structure problem —
                                                none exists in this kit today
  backtracking          not yet exercised      constraint search over a state
                                                space (your river-crossing PG.ts)
```

The honest read: AptKit's data is small and flat, so the structures that pay off at scale (heaps, balanced trees, graph traversal) have nothing to bite on yet. The coverage system (`coverage-gate.ts`) *looks* like it could be a dependency graph — `requires` and `enriches` are edges in spirit — but today they are evaluated as flat `Set.has` checks with no traversal, no transitive closure, no cycle concern. The moment a capability's `requires` points at *another capability* rather than a raw token, that file grows a real graph. It hasn't yet. → `05-graphs-and-traversals.md` walks exactly why.

## How to use this guide

Work top to bottom. Each concept file opens with where it sits in the layer diagram, walks the mechanism with pseudocode and a diagram before any real code, then shows the actual AptKit lines with a line-by-line read. The `not yet exercised` files are short on repo-anchored code (because there isn't any) and longer on "here's the foundation, here's the trigger, here's where you'd reach for it" — those lean on your `reincodes` background so the teaching has somewhere to land.

The final file, `08-dsa-foundations-practice-map.md`, ranks what to practice: the exercised concepts to sharpen for interviews first, the missing foundations to keep warm second.
