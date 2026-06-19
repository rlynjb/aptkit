# 04 — Trees, Tries, and Balanced Indexes

**Industry name(s):** Tree traversal, path navigation (JSONPath-style), trie (prefix tree), balanced search tree / B-tree index. Type label: Language-agnostic foundation.

## Zoom out, then zoom in

Hierarchies show up two ways: as a *data shape* you walk (nested JSON), and as an *index structure* you build for fast ordered lookup (a balanced tree, a B-tree). AptKit has exactly one thin slice of the first — a dotted-path walk down nested JSON in the structural-diff evaluator — and none of the second. Tries and balanced indexes are `not yet exercised`. This is the shortest of the exercised files, because there's genuinely one thing to walk, and it's worth being honest about that.

```
  Zoom out — trees in AptKit

  ┌─ Evals layer ────────────────────────────────────────┐
  │  getPath(value, "recommendations.0.title")           │ ← the one tree walk
  │    walk JSON tree by dotted path, level by level      │
  └───────────────────────────┬───────────────────────────┘
                              │ used by structural-diff rules
  ┌─ (absent) ────────────────▼───────────────────────────┐
  │  trie (prefix tree)        not yet exercised           │
  │  balanced tree / B-tree    not yet exercised           │ ← your reincodes BST
  │  ordered index             not yet exercised           │
  └────────────────────────────────────────────────────────┘
```

Zoom in: a tree is nodes with children; walking it means descending from a root along some path. JSON is a tree — objects and arrays are interior nodes, scalars are leaves. `getPath` walks that tree along a dotted path string, one level per segment. A trie is a *different* tree — keyed by string prefixes, for autocomplete-style lookup. A balanced search tree (your BST, or a B-tree in a database) keeps keys *ordered* for O(log n) range and point queries. AptKit needs the first idea once; it needs the other two not at all yet.

## Structure pass

**Layers.** One: the evals layer, where `getPath` descends a JSON value along a path. There's no second layer because there's no index structure.

**Axis — trace "navigation": *given a target, how do I get from the root to it?*** — but there's only one structure to trace it across, so the contrast here is between the *exercised* walk and the *absent* ordered index.

```
  One axis — "how do I reach a target?" — walk vs index

  getPath (exercised)    dotted path → descend object/array by key/index
                         O(depth), no ordering, no search — direct address

  BST / B-tree (absent)  compare key → go left/right → O(log n) ORDERED
                         search, range queries, successor/predecessor

  the flip: getPath ADDRESSES a known path; a balanced tree
  SEARCHES an ordered keyspace. aptkit only addresses.
```

**Seam.** The boundary worth naming is between *direct addressing* (`getPath` — you already know the path, you just descend it) and *search* (a balanced tree — you don't know where the key is, you navigate by comparison). AptKit's evals always know the path they're checking (the rule specifies `"recommendations.0.title"`), so it never needs search, never needs ordering, never needs a balanced tree. That's the whole reason the index structures are absent: there's no "find me the key nearest X" or "give me keys in range" question anywhere in the repo.

## How it works

### Move 1 — the mental model

You walk JSON trees constantly on the frontend — `response.data.items[0].name` is a tree walk, descending object keys and array indices to a leaf. `getPath` is that, except the path is a *string* (`"data.items.0.name"`) parsed into segments at runtime, so an eval rule can target any field without hard-coding the access.

```
  The kernel — descend a tree one segment at a time

  path "recommendations.0.title"  →  split  →  [recommendations, 0, title]

      root {recommendations: [ {title: "X"}, ... ]}
        │  segment "recommendations"  → object key
        ▼
      [ {title: "X"}, ... ]
        │  segment "0"  → array index
        ▼
      {title: "X"}
        │  segment "title"  → object key
        ▼
      "X"   ← leaf, return {exists: true, value: "X"}
```

The strategy in one sentence: parse the path into segments, then walk down the tree one segment at a time, switching between object-key access and array-index access based on what the current node is — and bail with `{exists: false}` the moment a segment doesn't resolve.

### Move 2 — the path walk, one step at a time

**Parse the path into segments.** Bridge from `"a.b.c".split(".")`: the path string becomes an array of segments, empty segments filtered out. `"recommendations.0.title"` becomes `["recommendations", "0", "title"]`. This is the itinerary for the descent.

```
  "recommendations.0.title".split('.').filter(Boolean)
       → ["recommendations", "0", "title"]   ← the descent plan
```

**Descend, branching on node type.** Bridge from the difference between `obj[key]` and `arr[index]`: at each segment, the walk checks whether the current node is an array or an object and accesses accordingly. For an array, the segment is parsed as a number and bounds-checked; for an object, it's checked as a key.

```
  Execution trace — getPath descending, with a miss

  current = {recommendations: [{title:"X"}]}    seg = "recommendations"
    object, "recommendations" in current → descend
  current = [{title:"X"}]                         seg = "0"
    array, Number("0")=0, in bounds → descend
  current = {title:"X"}                            seg = "title"
    object, "title" in current → descend
  current = "X"                                    → exists: true, value "X"

  ── but if seg were "1" on a length-1 array:
  current = [{title:"X"}]                          seg = "1"
    array, index 1 >= length 1 → return {exists:false, undefined}
```

The load-bearing detail people miss: the walk distinguishes *missing* from *present-but-undefined*. It returns `{exists, value}`, not just `value`. That matters because an eval rule needs to tell "the field isn't there" (a `required` failure) from "the field is there and happens to be `undefined`." A bare `value` of `undefined` is ambiguous; the `exists` flag resolves it. What breaks without it: `required` checks would false-pass on present-but-undefined fields.

**The boundary conditions, named.** Three failure points the walk guards: a non-integer or out-of-bounds array index (returns not-exists), a missing object key (returns not-exists), and hitting a scalar before the path is exhausted (the `typeof current !== 'object'` check returns not-exists). Each is a "the path doesn't resolve here" signal, returned cleanly rather than thrown.

### Move 2.5 — current state vs future state: tries and balanced indexes

Both index structures are `not yet exercised`. Here's the precise why and the trigger for each.

```
  Phase A (now)                 Phase B (would summon the structure)

  TRIE
  ~49 tool names matched         hundreds/thousands of names with
  by exact Map.get / Set.has     PREFIX routing ("query_*" → group),
  → no prefix structure needed   or autocomplete over names → trie

  BALANCED TREE / B-TREE / INDEX
  replays listed by readdir +    a persistent ordered store queried by
  filename .sort(), then linear  RANGE (replays between two dates) or
  eval → no ordered index        by nearest key → balanced tree / B-tree
                                  (this is what a DB index is)
```

The honest read: AptKit addresses fields by known path and matches tool names by exact key. It never asks "all keys with prefix P" (→ trie) or "all keys in range [A,B]" / "the key nearest X" (→ balanced tree). The replay list is the closest thing to an ordered collection, and it's handled by a flat `.sort()` + linear scan because n is small (`replay-runner.ts:31`). The trigger for a balanced index is the same one from `01` and `06`: a large, persistent, range-queried store. That's when you'd reach for the B-tree a database gives you for free — see `study-database-systems` for that seam. Your `reincodes` `BinarySearchTree.ts` (insert/search/delete, successor/predecessor, all traversals) is the from-scratch version of exactly this idea.

### Move 3 — the principle

There are two distinct reasons to use a tree: as a *shape to walk* (JSON, the DOM, a file system) and as an *index to search* (ordered keys for O(log n) lookup and range). They're easy to conflate because both are "trees," but they answer different questions — addressing vs searching. AptKit needs only the first. Recognizing which kind a problem needs is the skill: if you know the path, you walk; if you need ordered search or range queries, you build (or borrow from a database) a balanced index.

## Primary diagram

The one exercised walk, framed against the absent index structures.

```
  Trees in AptKit — one walk, two absences

  ┌─ EXERCISED: getPath, a JSON tree walk ───────────────┐
  │  "recs.0.title".split('.') → [recs, 0, title]        │
  │  root ─obj key→ array ─index→ obj ─key→ leaf          │
  │  branch on Array.isArray; return {exists, value}      │
  │  used by structural-diff rules to address any field   │
  └────────────────────────────────────────────────────────┘
  ┌─ NOT YET EXERCISED ─────────────────────────────────┐
  │  trie         — summoned by prefix routing/autocomplete│
  │  balanced BST — your reincodes BST; ordered search     │
  │  B-tree index — summoned by a persistent range-queried │
  │                 store (a database's job; see DB guide)  │
  └────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** `getPath` is called by every structural-diff rule — `required`, `equals`, `number`, `arrayCount`, `containsText`, `arrayIncludes` — to address the field a rule targets inside a replay artifact's output. It's how the eval system says "check that `recommendations.0.confidence` is a number ≥ 0.5" against arbitrary JSON.

The path walk — `packages/evals/src/structural-diff.ts` (lines 53–74, `getPath`):

```
  export function getPath(value, path): { exists: boolean; value: unknown } {
    const parts = path.split('.').filter(Boolean);    ← parse path → segments
    let current = value;

    for (const part of parts) {                        ← descend one segment per step
      if (Array.isArray(current)) {                    ← branch: array node
        const index = Number(part);
        if (!Number.isInteger(index) || index < 0 || index >= current.length) {
          return { exists: false, value: undefined };  ← bad/out-of-bounds index → miss
        }
        current = current[index];
        continue;
      }
      if (!current || typeof current !== 'object' || !(part in current)) {
        return { exists: false, value: undefined };    ← scalar-too-early OR missing key → miss
      }
      current = (current as Record<string, unknown>)[part];   ← object key access
    }
    return { exists: true, value: current };           ← path fully resolved → hit
       │
       └─ the {exists, value} pair (not bare value) is load-bearing: it lets a
          `required` rule distinguish "field missing" from "field present but
          undefined". A bare undefined would be ambiguous.
  }
```

How rules consume it — same file, `assertRequiredRule` (lines 76–85) calls `getPath` and pushes an issue iff `!found.exists`; `assertNumberRule` (`:102`) additionally checks `typeof found.value !== 'number'`. The `exists` flag is what makes "missing" a distinct failure from "wrong type." And `getPath` is also reused inside `arrayIncludes` (`:174`) with an `itemPath` to address a field *within* each array element — the same walk, applied per-item.

## Elaborate

JSON-path addressing (the dotted-string-to-tree-walk) is a well-trodden idea — JSONPath, JMESPath, and `lodash.get` all formalize it. The repo's `getPath` is a minimal version: dotted segments, object-or-array branching, no wildcards or filters. That minimalism is the right call — eval rules target specific known fields, so the expressive power of full JSONPath would be unused surface area.

Balanced trees are the structure that makes ordered data fast: a BST gives O(log n) search but degrades to O(n) if it leans (which is why AVL and red-black trees rebalance, and why your `reincodes` BST teaches the un-balanced baseline). A B-tree is the disk-friendly, high-fanout cousin that every relational database uses for its indexes. AptKit has no database and no ordered keyspace, so none of this is reached for — but the moment replays move into a queried store, the index becomes the database's B-tree, not something you hand-build. That's the clean seam to `study-database-systems`.

Tries trade memory for prefix-keyed lookup — great for autocomplete and routing tables, overkill for 49 exact-match tool names.

## Interview defense

**Q: "Is there any tree structure in this codebase?"**

One walk, no index. `getPath` in `structural-diff.ts` descends a JSON tree along a dotted path — objects and arrays are interior nodes, scalars are leaves. It's *addressing* a known path, O(depth), not *searching* an ordered keyspace. There's no balanced tree or trie because nothing here asks an ordered or prefix question.

```
  "a.0.b".split('.') → descend obj→array→obj→leaf
  addressing, not searching → no balanced tree needed
```

Anchor: *it's a tree walk for addressing, not a tree index for search — and that distinction is why there's no BST here.*

**Q: "Why return `{exists, value}` instead of just the value?"**

To distinguish a missing field from a present-but-`undefined` one. A `required` rule must fail when the field is absent but not when it's present and legitimately `undefined`. A bare `value` of `undefined` can't tell those apart; the `exists` flag does. Drop it and `required` checks false-pass on undefined fields.

```
  missing field   → {exists:false}  → required FAILS  ✓
  present, undef  → {exists:true, value:undefined}  → required PASSES ✓
  bare value: undefined for both → can't tell them apart ✗
```

Anchor: *the exists flag is the load-bearing part — it separates "not there" from "there and undefined."*

**Q: "When would you add a balanced tree or index here?"**

When replays become a persistent store queried by range — "all replays between two timestamps" — or by nearest key. That's an ordered-search question `getPath` can't answer and a linear scan handles poorly at scale. But I wouldn't hand-build a BST; I'd put the data in a database and let its B-tree index do it. A trie would only appear if tool/intent names grew into the hundreds with prefix routing.

```
  range query on a large ordered store → B-tree index (database's job)
  prefix routing on many names → trie
  neither exists today → no structure needed
```

Anchor: *ordered/range queries summon a balanced index — and at that point it's the database's B-tree, not a hand-rolled BST.*

## Validate

**Reconstruct.** Write `getPath`'s loop from memory: split path, for each segment branch on `Array.isArray`, bounds-check numeric index or `in`-check object key, return `{exists, value}`. Name the three miss conditions (bad index, missing key, scalar-too-early).

**Explain.** In `structural-diff.ts:108`, `assertNumberRule` checks both `!found.exists` and `typeof found.value !== 'number'`. Why both? (Answer: `exists` catches a missing field; the typeof catches a present field of the wrong type. Different failures, both should produce an issue.)

**Apply to a scenario.** An eval rule needs to check a deeply nested field that may or may not exist at several levels: `"diagnosis.hypotheses.2.evidence.0.metric"`. Does `getPath` handle a missing intermediate level cleanly? (Answer: yes — the first segment that doesn't resolve returns `{exists:false}` and the walk stops; it never throws on a missing intermediate, it short-circuits. This is why rules can target deep optional paths safely.)

**Defend the decision.** Someone proposes replacing `getPath` with full JSONPath (wildcards, filters, recursive descent). Defend the minimal version. (Answer: eval rules target specific known fields — no rule uses wildcards or filters. Full JSONPath is a parser and a query engine of unused power and new failure modes. The minimal dotted walk matches the actual need exactly; expanding it is complexity for capability nobody calls for.)

## See also

- `02-arrays-strings-and-hash-maps.md` — the `Map`/`Set` exact-match lookups that make a trie unnecessary.
- `06-sorting-searching-and-selection.md` — why ordered search (binary search) is also `not yet exercised`, the same root cause.
- `05-graphs-and-traversals.md` — the other "absent because the data is flat" structure.
- `study-database-systems` (neighboring guide) — where a real B-tree index lives when a persistent ordered store appears.
