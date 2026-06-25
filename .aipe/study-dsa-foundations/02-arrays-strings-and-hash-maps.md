# 02 — Arrays, Strings, and Hash Maps

**Industry name(s):** Dynamic array, hash map (`Map`), hash set (`Set`), string scanning / substring search. Type label: Language-agnostic foundation; the `Map`/`Set` instances are project-specific.

## Zoom out, then zoom in

This is the file where AptKit lives. Almost every load-bearing operation in the repo is one of three things: a `Map.get` (dispatch a tool by name), a `Set.has` (is this tool/capability allowed), or a bounded scan over a string (pull JSON out of model text). If you understand these three, you understand the substrate the whole kit runs on.

```
  Zoom out — the three structures, and where each lives

  ┌─ Runtime layer ──────────────────────────────────────┐
  │  parseAgentJson:  STRING SCAN for the JSON region     │ ← bounded substring
  └───────────────────────────┬───────────────────────────┘
                              │ feeds parsed args/results
  ┌─ Tools layer ─────────────▼───────────────────────────┐
  │  InMemoryToolRegistry:  ★ Map<name, handler> ★         │ ← O(1) dispatch
  │  filterToolsForPolicy:  Set<allowedTools> + filter     │ ← O(1) membership
  └───────────────────────────┬───────────────────────────┘
                              │ feeds coverage/eval
  ┌─ Context / Evals layer ───▼───────────────────────────┐
  │  coverage-gate:  Set<capability tokens>, .has() checks │
  │  detection-scorer: Set<expected>, matched/missed split │
  └────────────────────────────────────────────────────────┘
```

The starred `Map` is the single most-hit structure in the repo. Zoom in: a hash map trades a little memory and a hash computation for O(1) average lookup by key, and a hash set is the same machine with the values thrown away — you only ask "is this key present?" The string scan is the odd one out: model output isn't structured, so the repo has to *find* the JSON inside free text. We'll walk all three.

## Structure pass

**Layers.** Runtime (string → structure), tools (name → handler, name → allowed?), context/evals (token → covered?, category → expected?).

**Axis — trace "lookup": *given a key, how fast do I find the value or the answer?*** across the three structures.

```
  One axis — "lookup cost" — across the three structures

  Map<name, handler>       given a name  → O(1) hash → the handler
  Set<allowedTools>        given a name  → O(1) hash → present? yes/no
  string scan (parseJson)  given text    → O(len) walk → JSON region

  the answer flips at the scan: hashing gives O(1),
  but unstructured text forces a linear O(length) walk
```

**Seam.** The load-bearing boundary is between *structured keys* (Map/Set, O(1)) and *unstructured text* (the JSON scan, O(length)). That's where the cost axis flips from constant to linear — and it's exactly the boundary between "data the repo controls" (registered tool names, allowlists) and "data the model produced" (free-form completion text). The repo can hash what it owns; it must scan what the model hands back.

## How it works

### Move 1 — the mental model

You build with all three of these daily on the frontend. A `Map` is the `{}`-keyed-by-id object you reach for when you need to look something up by id without scanning an array — `usersById.get(id)`. A `Set` is what you use to dedupe a list or answer "is this id selected" — `new Set(selectedIds).has(id)`. A string scan is what `JSON.parse(response)` does under the hood, except here the model wraps its JSON in prose so you have to find the braces first.

```
  The kernel — key in, answer out (hash) vs scan (linear)

  HASH MAP / SET                    STRING SCAN
  ┌──────────┐  hash(key)           text: "Here is the data: {...} done"
  │  "qry_x" │ ──────┐               find first { or [  ──┐
  └──────────┘       ▼                                    ▼
                  ┌─────────┐        find last } or ]  ── bounded region
                  │ bucket  │ → val  slice(start, end+1) → JSON.parse
                  └─────────┘        ─────────────────────────────────
  O(1) average                      O(length) one pass, no backtracking
```

The strategy in one sentence: hash the keys you own for constant-time lookup, and scan the text you don't own with a single bounded pass — never a quadratic rescan.

### Move 2 — the three structures, one at a time

**The hash map — `Map<name, handler>`, the dispatch table.** Bridge from `usersById.get(id)`: the registry is the same idea, mapping a tool *name* to the *function* that runs it. The model emits "call tool `query_events` with these args"; the registry hashes `"query_events"`, lands in O(1) on the handler, and invokes it. What breaks without the hash: you'd scan an array of tools on every call, O(n) per dispatch, on the hot path.

```
  Map dispatch — name to handler, one hash

  model says: call "query_events"
       │
       ▼  handlers.get("query_events")  ── O(1) hash + bucket probe
  ┌──────────────────────────────────┐
  │ "query_events" → fn(args) ────────┼──► run it, time it, return result
  │ "get_customer" → fn(args)         │
  │ "list_catalog" → fn(args)         │
  └──────────────────────────────────┘
  missing key → throw "tool not found" ← the boundary condition
```

The boundary condition that matters: a missing key. The model can hallucinate a tool name. The registry must not silently no-op — it throws `tool not found`, which the loop catches and feeds back as a tool error so the model can correct. That explicit miss-handling is load-bearing; a `Map.get` returning `undefined` that you forget to check is a silent failure.

**The hash set — `Set<allowedTools>`, the membership gate.** Bridge from `new Set(selectedIds).has(id)`: the tool policy turns an allowlist array into a `Set`, then filters the full catalog down to only allowed tools. This is least-privilege — the model only ever *sees* the tools its capability is permitted to call. What breaks without the `Set`: you'd do an `array.includes` per tool, turning an O(n) filter into O(n·m).

```
  Set membership — build once, ask many times

  policy.allowedTools = ["query_events", "get_customer", ...]
       │ new Set(...)  ── build O(allowed)
       ▼
  ┌─ allowed: Set ─────────────────────┐
  │ {query_events, get_customer, ...}  │
  └──────────────┬──────────────────────┘
                 │ for each tool in full catalog:
                 ▼  allowed.has(tool.name)  ── O(1) each
  catalog (49 tools) ──filter──► only the allowed subset → model sees these
```

The same `Set`-membership shape recurs in `coverage-gate.ts` (does the workspace have the capability tokens a task requires?) and `detection-scorer.ts` (was this category in the expected set?). Three different problems, one structure: build a `Set` of the known/allowed/expected things, then ask O(1) membership questions against it.

**The string scan — `parseAgentJson`, finding structure in free text.** Bridge from `JSON.parse`: the problem is the model doesn't return clean JSON, it returns `"Sure, here's the analysis: ```json {...} ``` hope that helps!"`. So the parse is a three-stage scan, each more forgiving than the last.

```
  Execution trace — parseAgentJson on messy model output

  input: "result: ```json {\"a\":1} ``` done"

  stage 1: regex match ```(json)? ... ```   → captures {"a":1}
           JSON.parse("{\"a\":1}")          → SUCCESS, return {a:1}

  (if stage 1's content still won't parse — no fence at all:)
  input: "the answer is {\"a\":1} ok"
  stage 2: indexOf('{') = 13, indexOf('[') = -1   → start = 13
           lastIndexOf('}') = 22, lastIndexOf(']') = -1 → end = 22
           slice(13, 23) = "{\"a\":1}"            → JSON.parse → {a:1}

  (if no braces at all:)
  stage 3: throw "no parseable json in model output"
```

The load-bearing detail people get wrong: this is a *bounded* scan, not a recursive descent parser. It finds the outermost `{...}` or `[...]` by first-open / last-close index — O(length) total, one pass for each `indexOf`/`lastIndexOf`. It does not validate nesting; it hands the candidate slice to `JSON.parse` and lets that do the real validation. What breaks if you tried to write a full brace-matcher instead: you'd reinvent a JSON parser and likely get it wrong. The repo correctly delegates correctness to `JSON.parse` and only does the *locating* itself.

### Move 3 — the principle

Hash the keys you own; scan the text you don't. The split between `Map`/`Set` (O(1) on data you control) and the string scan (O(length) on data the model produced) is the same boundary everywhere you integrate with an unstructured source: you get constant-time structure on your side of the seam and pay a linear locate-cost crossing it. The art is keeping the scan bounded — one pass, delegate validation — instead of letting it become a quadratic rescan or a hand-rolled parser.

## Primary diagram

The three structures in one frame, from model output back to dispatch.

```
  Arrays/strings/maps — one capability's data path

  ┌─ model produces free text ───────────────────────────┐
  │  "...```json {\"tool\":\"query_events\"} ```..."      │
  └───────────────────────┬───────────────────────────────┘
            STRING SCAN    ▼  parseAgentJson: fence → braces → parse
  ┌─ structured args ─────────────────────────────────────┐
  │  { tool: "query_events", args: {...} }                │
  └───────────────────────┬───────────────────────────────┘
            SET GATE       ▼  allowed.has("query_events")? yes
  ┌─ policy filter ───────────────────────────────────────┐
  │  Set<allowedTools> ── least-privilege subset           │
  └───────────────────────┬───────────────────────────────┘
            MAP DISPATCH   ▼  handlers.get("query_events")  O(1)
  ┌─ execute ─────────────────────────────────────────────┐
  │  fn(args) → result + durationMs → back to the loop     │
  └────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The `Map` registry is hit on every single tool call the model makes — across all five agents. The policy `Set` filter runs once per agent setup to scope what the model sees. The JSON scan runs on every agent's final answer (and on `parseValidatedJson` for structured results). Coverage `Set` checks run pre-model to skip tasks that can't succeed. Newer: the fixed-window chunker runs on every document indexed into the retrieval pipeline, the precision@k/recall@k `Set` scorers run when evaluating ranked retrieval quality, and `@aptkit/memory`'s per-conversation counter `Map` is touched on every `remember` to mint a collision-free id.

The `Map` dispatch — `packages/tools/src/tool-registry.ts` (lines 34, 50–64):

```
  private readonly handlers = new Map<string, ToolHandler>();   ← line 34, the table
  ...
  async callTool(name, args, options) {                          ← line 50
    options?.signal?.throwIfAborted();                           ← cancellation first
    const handler = this.handlers.get(name);                     ← O(1) hash lookup
    if (!handler) {
      throw new Error(`tool not found: ${name}`);                ← miss → explicit throw
    }
    const start = performance.now();
    const result = await handler(args, options);                 ← invoke the function
    return { result, durationMs: Math.round(performance.now() - start) };  ← time it
       │
       └─ the throw on miss is load-bearing: a hallucinated tool name becomes a
          caught error the model can recover from, not a silent undefined.
```

The `Set` policy filter — `packages/tools/src/tool-policy.ts` (lines 11–22):

```
  export function filterToolsForPolicy(allTools, policy): ModelTool[] {
    const allowed = new Set(policy.allowedTools);    ← build O(allowed) once
    return allTools
      .filter((tool) => allowed.has(tool.name))      ← O(1) membership per tool
      .map((tool) => ({ name, description, inputSchema }));  ← project to model schema
       │
       └─ the Set turns an O(n·m) "is each tool in the allowlist array" into an
          O(n) filter. This is the least-privilege boundary: tools NOT in the set
          never reach the model, so it can't call what it isn't allowed to.
  }
```

The `Set` recurrence in coverage — `packages/tools/src/coverage-gate.ts` (lines 38–45):

```
  export function requirementCoverage(requirement, capabilities): CoverageLevel {
    if (!requirement.requires.every((dep) => capabilities.has(dep)))  ← all required present?
      return 'unavailable';
    if (requirement.enriches?.length &&
        !requirement.enriches.every((dep) => capabilities.has(dep)))  ← all enrichers present?
      return 'limited';
    return 'full';
       │
       └─ `capabilities` is a ReadonlySet built by schemaCapabilities (:23). Same
          membership machine as the policy Set — different question (can this task
          run?) same O(1) .has. This is the seam toward graphs (see 05): requires/
          enriches LOOK like edges, but they're evaluated as flat membership, not
          traversed.
  }
```

The bounded string scan — `packages/runtime/src/json-output.ts` (lines 7–28):

```
  export function parseAgentJson(text: string): unknown {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);   ← stage 1: fenced block
    const candidate = (fence ? fence[1] : text).trim();
    try { return JSON.parse(candidate); } catch { /* fall through */ }

    const objectStart = candidate.indexOf('{');                  ← stage 2: first brace
    const arrayStart = candidate.indexOf('[');
    const starts = [objectStart, arrayStart].filter((i) => i >= 0);
    const start = starts.length > 0 ? Math.min(...starts) : -1;  ← earliest opener
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));  ← last closer
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));        ← slice the region, parse
    }
    throw new Error('no parseable json in model output');        ← stage 3: give up loudly
       │
       └─ all O(length), one pass each. It LOCATES the JSON region; JSON.parse
          VALIDATES it. The repo doesn't hand-roll a parser — it delegates
          correctness and only does the bounded find itself.
  }
```

**New string work — the fixed-window chunker** — `packages/retrieval/src/chunker.ts` (lines 13–31). This is the second place AptKit does real string-slicing, and it's a different shape from the JSON scan: not "find one region," but "slide a window across the whole document."

```
  export const CHUNK_SIZE = 512;                                ← window width (chars, not tokens)
  export const CHUNK_OVERLAP = 64;                              ← chars carried into the next window
  ...
  if (text.length <= size) return [text];                       ← line 22: short doc → one chunk, no loop
  const step = Math.max(1, size - overlap);                     ← line 24: advance per window (448 here)
  for (let start = 0; start < text.length; start += step) {     ← walk the document by `step`
    chunks.push(text.slice(start, start + size));               ← slice a 512-char window
    if (start + size >= text.length) break;                     ← line 28: stop once the window covers the tail
  }
       │
       └─ overlap is why step ≠ size: each window starts 448 chars on but spans 512, so the
          last 64 chars of one chunk reappear at the head of the next. That's the load-bearing
          line — drop the overlap and a fact straddling a boundary gets split across two chunks
          and lost from both. Math.max(1, …) guards overlap ≥ size (step would be 0 → infinite loop).
          The early break stops a trailing partial window from being emitted twice.
```

**New Set work — precision@k / recall@k scoring** — `packages/evals/src/precision-at-k.ts` (lines 27–78). Same `Set`-membership move as detection scoring, applied to *ranked retrieval*: of the top-k retrieved ids, how many are in the relevant set?

```
  function countDistinctHits(retrievedIds, relevantIds: ReadonlySet<string>, k): number {
    const topK = retrievedIds.slice(0, k);                      ← line 28: only the first k matter
    const seen = new Set<string>();                             ← dedup: a relevant id counts ONCE
    for (const id of topK) {
      if (relevantIds.has(id)) seen.add(id);                    ← O(1) membership per id
    }
    return seen.size;                                           ← distinct hits in the window
  }
  // precision: total = min(k, retrievedIds.length)   ← :53 — short result list not over-penalised
  // recall:    total = relevantIds.size              ← :70 — denominator is the full relevant set
       │
       └─ the two scorers share countDistinctHits and differ ONLY in the denominator: precision
          divides by what you returned, recall by what existed. The `seen` Set is load-bearing —
          without it a relevant id appearing twice in the top-k would be double-counted and push
          a precision score above 1. `ok:false` (not a quality verdict) flags an undefined metric:
          k≤0, empty result (precision), or empty relevant set (recall) — a 0-denominator.
```

**New Map work — the per-conversation counter** — `packages/memory/src/conversation-memory.ts` (lines 71, 78–84). Same hash-map-keyed-by-id machine as the tool registry, but used for a different job: a *monotonic sequence per key*. Memory ids must never collide, even when the same conversation remembers many turns, so each conversation gets its own counter.

```
  const counters = new Map<string, number>();          ← line 71: conversationId → next sequence number
  ...
  const n = counters.get(turn.conversationId) ?? 0;     ← line 78: current count (0 if first turn)
  counters.set(turn.conversationId, n + 1);             ← line 79: bump it for next time
  await store.upsert([{
    id: `${kind}:${turn.conversationId}:${n}`,           ← line 82: id = kind:conversation:sequence
    vector, meta: { kind, conversationId, text },
  }]);
       │
       └─ the Map keys by conversationId so two conversations never share a counter — their ids
          can't collide even at the same n. The `?? 0` is the first-turn default; the read-then-
          write-back is the bump. Drop the Map and reuse one global counter and you'd still get
          unique ids, but you'd serialize all conversations onto one number — the per-key Map keeps
          each conversation's ids self-contained (kind:conv-A:0, kind:conv-A:1, kind:conv-B:0, …).
          This is a hash map used as a namespaced sequence generator, not a lookup table.
```

## Elaborate

Hash maps and sets are the workhorses of practical computing — average O(1) by trading space and a hash function for the linear scan. The catch they hide is collisions: two keys hashing to the same bucket degrade to a list walk, worst-case O(n). JavaScript's `Map`/`Set` handle this in the engine, so you don't manage it — but it's why "O(1) average" is the honest claim, not "O(1) always." This is the same tradeoff your `reincodes` work avoided by building *ordered* structures (BST gives O(log n) guaranteed, no collision risk, but loses O(1)) — hash vs tree is the classic unordered-fast vs ordered-guaranteed split.

The string scan is a degenerate case of *parsing*, and the interesting design call is how little it does: it locates, delegates validation. A more ambitious version would balance braces to find the true outer object, but that re-implements a parser and the failure modes (strings containing `}`, escaped braces) are exactly where hand-rolled parsers break. The repo's choice — find by first-open/last-close, let `JSON.parse` reject bad candidates — is the pragmatic one.

For *why* the `Map` is hidden behind the `InMemoryToolRegistry` interface rather than exposed raw, that's an information-hiding decision — see `study-software-design`. For why the policy `Set` is the security boundary it is, see `study-security`'s tool-allowlist lens.

## Interview defense

**Q: "Walk me through tool dispatch. What's the data structure and what's the failure mode?"**

A `Map<string, ToolHandler>` in `InMemoryToolRegistry`. The model emits a tool name, `handlers.get(name)` is an O(1) hash lookup to the function, and the result is timed for the trace. The failure mode is a hallucinated name — `get` returns `undefined`, so the code throws `tool not found` explicitly, the loop catches it, and feeds it back as a tool error the model can correct from.

```
  name → Map.get → handler | undefined
                            └─ throw, don't no-op ← the part people forget
```

Anchor: *O(1) dispatch, but the load-bearing line is the explicit throw on a missing key — a silent undefined is a silent failure.*

**Q: "Why a `Set` for the allowlist instead of just checking the array?"**

Membership is the only question asked, and it's asked once per tool in the catalog. An array `.includes` is O(allowed) per check, so filtering 49 tools against an allowlist is O(49 · allowed). Building a `Set` once is O(allowed), then each `.has` is O(1), so the filter is O(49). It's also the security boundary — tools not in the set never reach the model.

Anchor: *the Set turns a quadratic filter into linear, and it's the least-privilege gate, not just a perf choice.*

**Q: "The JSON parser scans for the first `{` and last `}`. What's the risk and why is it acceptable?"**

The risk is that the model emits prose containing a stray `}` after the real JSON, so `lastIndexOf('}')` overshoots and the slice fails to parse. That's acceptable because `JSON.parse` rejects it and the layer above (`parseValidatedJson`, or the loop's `recoveryPrompt`) re-prompts. The scan only *locates*; correctness lives in `JSON.parse`. Hand-rolling a brace-matcher would be more code and more failure modes for no real gain at this scale.

Anchor: *it locates, it doesn't validate — delegating correctness to JSON.parse is the right call, not a shortcut.*

## Validate

**Reconstruct.** Write the three-stage logic of `parseAgentJson` from memory: fenced block → first-open/last-close slice → throw. Name the complexity of each `Map.get`, `Set.has`, and the scan (O(1), O(1), O(length)).

**Explain.** In `tool-registry.ts:57`, why does the code throw on a missing handler instead of returning early or no-op? Trace what happens to that throw in `run-agent-loop.ts` (lines 158–168). (Answer: the loop's try/catch turns it into a `tool_result` with `isError: true`, feeding the model a recoverable error.)

**Apply to a scenario.** A new agent needs to dispatch among 5,000 tools. Does the `Map` registry still hold up? What about the policy `Set` filter? (Answer: both fine — `Map.get` and `Set.has` are O(1) regardless of size; the policy `.filter` becomes O(5000) per setup, still trivial. No structure change needed. Scale doesn't break hash lookups; this is exactly why the repo doesn't need a trie or index.)

**Defend the decision.** Someone wants `parseAgentJson` to use a real recursive-descent parser to handle nested braces in prose correctly. Defend the current scan. (Answer: at this scale, model output that breaks first-open/last-close is rare and already handled by the recovery re-prompt. A full parser is more surface area and more bugs for a case the recovery path already catches. The scan + `JSON.parse` delegation is the correct complexity budget.)

## See also

- `01-complexity-and-cost-models.md` — why these O(1)/O(n) costs round to free here.
- `04-trees-tries-and-balanced-indexes.md` — `getPath`'s dotted-path walk, the structured cousin of these lookups, and why no trie exists.
- `06-sorting-searching-and-selection.md` — the cosine-score top-k that ranks retrieval hits (the chunks this file's chunker produces, scored by the precision@k/recall@k this file walks), and the over-fetch-then-filter-then-slice in memory's `recall` that pairs with the counter `Map` above.
- `05-graphs-and-traversals.md` — the ANN/HNSW graph index that replaces retrieval's linear scan once the chunk corpus grows large.
- `05-graphs-and-traversals.md` — how the coverage `Set` checks are the seam where a real graph *would* appear.
- `06-sorting-searching-and-selection.md` — the linear scans (classify, match) that complement these hash lookups.
- `study-security` (neighboring guide) — the policy `Set` as the tool-allowlist trust boundary.
- `study-software-design` (neighboring guide) — why the `Map` is hidden behind the registry interface.
