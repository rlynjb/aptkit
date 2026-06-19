# 06 — Sorting, Searching, and Selection

**Industry name(s):** Comparator sort, linear search, classification scan, top-k selection (sort-and-slice), binary search, partitioning / quickselect. Type label: Language-agnostic foundation.

## Zoom out, then zoom in

Sorting and searching are the everyday algorithms, and AptKit uses the everyday subset: comparator `sort` to rank, `slice` to cap (top-k), and linear scans to classify and match. What it does *not* use is the asymptotically clever subset — binary search and partition-based selection (quickselect) — because its inputs are tiny and mostly unsorted, so the clever versions buy nothing. This file walks the three exercised patterns and is precise about why the two absent ones are absent.

```
  Zoom out — ordering and lookup in AptKit

  ┌─ Agent layer ────────────────────────────────────────┐
  │  anomaly ranking: sort(by severity desc) + slice(0,10)│ ← top-k via full sort
  └───────────────────────────┬───────────────────────────┘
                              │
  ┌─ Evals / context layer ───▼───────────────────────────┐
  │  detection match: linear scan required × detections   │ ← linear search
  │  coverage classify: scan requirements → full/lim/unav │ ← linear classify
  └───────────────────────────┬───────────────────────────┘
                              │
  ┌─ Infra ───────────────────▼───────────────────────────┐
  │  replay list: readdir + .sort() (filename order)      │ ← lexicographic sort
  └───────────────────────────┬───────────────────────────┘
                              │
  ┌─ (absent) ────────────────▼───────────────────────────┐
  │  binary search · quickselect    not yet exercised      │
  └────────────────────────────────────────────────────────┘
```

Zoom in: a comparator sort orders a list by a key you derive (O(n log n)); a linear search/classify touches every element once (O(n)); top-k by sort-and-slice orders everything then takes a prefix (O(n log n), fine when n is small). Binary search is the O(log n) lookup that *requires sorted input*, and quickselect is the O(n)-average way to get top-k *without* full sorting — both win only at scale AptKit doesn't have.

## Structure pass

**Layers.** Agent (rank anomalies/recommendations), evals/context (match detections, classify coverage), infra (sort replay filenames).

**Axis — trace "ordering need": *does this operation require the data sorted, and how much of it does it touch?*** across the patterns.

```
  One axis — "ordering need + how much touched" — across patterns

  comparator sort   produces order   touches all, O(n log n)
  linear classify   needs no order   touches all once, O(n)
  top-k (sort+slice)produces order, then takes prefix, O(n log n)
  binary search     REQUIRES order   touches log n   ← absent
  quickselect       needs no order   touches ~n avg  ← absent (top-k shortcut)

  the flip: binary search is the only one that PRESUPPOSES sorted
  input — and aptkit never maintains a sorted collection to search,
  so it never qualifies.
```

**Seam.** The load-bearing boundary is between *operations that touch every element* (sort, linear scan — what AptKit does) and *operations that exploit sorted structure to touch a fraction* (binary search — what it doesn't). The axis-answer flips at "is the collection kept sorted and searched repeatedly?" AptKit sorts *to produce an output order* (then discards), never to *maintain a searchable index*. That's why binary search has no home here: there's no long-lived sorted collection to binary-search into.

## How it works

### Move 1 — the mental model

You've built all five comparison sorts with visualizers, so the shape is muscle memory: a comparator says "does a come before b?", and the sort rearranges until that holds for every pair. Top-k is the move you reach for when you only want the best few: sort everything, take the front slice. Linear search is the `.find`/`.filter` you write daily — touch each element, keep the matches.

```
  The kernels — three shapes AptKit uses

  COMPARATOR SORT          LINEAR SCAN              TOP-K (sort+slice)
  [3,1,2] by key           [a,b,c,d]                sort desc → [9,7,4,1]
  compare pairs            test each once           slice(0,2) → [9,7]
  → [1,2,3]                → keep matches            full sort, take front
  O(n log n)               O(n)                      O(n log n), fine if n small
```

AptKit reaches for the comparator sort to rank, the linear scan to classify and match, and sort-and-slice for top-k. It never reaches for binary search (no sorted collection to search) or quickselect (top-k on tiny n doesn't need the O(n) shortcut).

### Move 2 — the three exercised patterns

**Comparator sort by a derived key — ranking anomalies.** Bridge from `arr.sort((a,b) => a.price - b.price)`: the monitoring agent ranks anomalies by *severity*, but severity is a string (`'critical'`, `'warning'`, ...), so it maps each to a numeric rank via a lookup table and sorts descending on that. The comparator is `severityRank[b] - severityRank[a]` — the table turns an unordered category into an orderable number.

```
  Comparator sort by derived key — severity ranking

  anomalies: [{sev:"warning"}, {sev:"critical"}, {sev:"info"}]

  severityRank table: {critical:3, warning:2, info:1}   ← category → number
       │ sort((l,r) => rank[r.sev] - rank[l.sev])  ← descending
       ▼
  [{sev:"critical"=3}, {sev:"warning"=2}, {sev:"info"=1}]
  O(n log n), n = number of anomalies (small)
```

The load-bearing detail: sorting by a *derived numeric key* via a lookup table is how you order categorical data. Without the rank table you'd be sorting strings lexicographically — `"critical" < "info" < "warning"` alphabetically, which is meaningless for severity. The table *is* the ordering definition.

**Top-k by sort-and-slice — capping the output.** Bridge from "show the top 10": after sorting, `slice(0, 10)` takes the most-severe ten. This is top-k done the simple way — sort all, take the front. It's O(n log n), and that's fine because n (anomaly count) is small.

```
  Top-k via sort + slice — full sort, take prefix

  sorted desc: [c, c, w, w, w, i, i, ... up to n]
                └────── slice(0, 10) ──────┘
                take the front 10            discard the rest
  O(n log n) sort dominates; for small n, simpler than a heap
```

The alternative — a size-k heap (O(n log k)) or quickselect (O(n) average) — wins only when k ≪ n and n is large. Here k=10 and n is rarely above 10, so the full sort is both simpler and effectively free. Picking sort-and-slice here is the *correct* choice, not a lazy one.

**Linear search and classify — matching and gating.** Bridge from `.some`/`.filter`: detection scoring asks, for each required category/metric/scope, "is there *any* detection matching it?" — a linear `.some` per requirement. Coverage classification scans each requirement and labels it full/limited/unavailable. Both touch every element once, O(n), with no sorting because no ordering is needed — only presence.

```
  Linear classify — touch each, label it, no order needed

  required = [cat:A, metric:B, scope:C]
    for each req:
      detections.some(d => matches(d, req))  → matched | missed
  ────────────────────────────────────────────────────────
  also splits unexpected = detections whose category ∉ expected
  O(required × detections), both small → effectively linear
```

The boundary condition in detection scoring: the `unexpected` partition. After matching required against detections, it also scans detections for categories *not* in the expected set — using a `Set` for the expected lookup so the "is this unexpected" check is O(1) per detection. That's the matched/missed/unexpected three-way split, and it's pure linear scanning over small lists.

### Move 2.5 — current state vs future state: binary search and quickselect

```
  Phase A (now)                    Phase B (would summon them)

  BINARY SEARCH
  replay list: readdir + .sort()   a large SORTED index searched
  then LINEAR eval over all        repeatedly by key (find replay
  → never searches the sorted      with id X, or range [A,B]) →
  list, just iterates it           binary search O(log n), or a DB index

  QUICKSELECT (top-k without sort)
  top-10 of ≤10 anomalies →        top-k where k ≪ n and n is LARGE
  full sort already wins           (top 10 of 100,000) → quickselect
                                   O(n) avg, or a size-k heap O(n log k)
```

The honest read: AptKit sorts the replay filenames (`replay-runner.ts:43`) purely for *deterministic iteration order*, then walks all of them linearly to eval — it never *searches* that sorted list, so binary search has nothing to do. And every top-k here is on a tiny collection, so a full sort beats both quickselect and a heap on simplicity with no measurable cost. The triggers are the same scale triggers from `01`: a large sorted index searched by key (→ binary search, or really a database index), or top-k where k ≪ n on a large n (→ quickselect or heap).

### Move 3 — the principle

Match the algorithm to the data's size and whether it's already ordered. Sort when you need an output order on a manageable list; linear-scan when you only need presence or a label; sort-and-slice for top-k when n is small. Reserve binary search for a *maintained* sorted collection you search repeatedly, and quickselect/heap for top-k when k ≪ n and n is large. Reaching for the clever O(log n) or O(n)-select algorithm on a 10-element list is the same mistake as reaching for a heap there — complexity with no payoff. AptKit's choices are correctly sized.

## Primary diagram

The three exercised patterns in one frame, with the two absent ones.

```
  Sorting/searching/selection in AptKit

  ┌─ EXERCISED ─────────────────────────────────────────┐
  │  RANK:    severityRank table → sort desc → slice(0,10)│
  │           (top-k via full sort, n small)              │
  │  MATCH:   required.some(matches) → matched/missed     │
  │           + unexpected via Set → 3-way split (linear) │
  │  CLASSIFY:scan requirements → full/limited/unavailable│
  │  ORDER:   readdir + .sort() → deterministic iteration │
  └────────────────────────────────────────────────────────┘
  ┌─ NOT YET EXERCISED ─────────────────────────────────┐
  │  binary search — needs a maintained sorted index      │
  │  quickselect   — needs top-k with k ≪ n, large n      │
  │  → both summoned by scale the repo doesn't have yet    │
  └────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The severity sort + slice runs at the end of every anomaly-monitoring run to produce a ranked, capped output. Detection matching runs in eval scoring against expected categories/metrics/scopes. Coverage classify runs pre-model. The replay filename sort runs whenever a batch eval lists artifacts.

The comparator sort + top-k slice — `packages/agents/anomaly-monitoring/src/monitoring-agent.ts` (lines 35, 86–88):

```
  const severityRank: Record<Anomaly['severity'], number> = {  ← line 35: category → number
    /* critical: 3, warning: 2, info: 1, ... */
  };
  ...
  return [...parsed]
    .sort((left, right) => severityRank[right.severity] - severityRank[left.severity])  ← desc by rank
    .slice(0, 10);                                            ← top-k cap
       │
       └─ the rank table is the ordering DEFINITION — without it, sorting the
          severity strings would order them alphabetically (meaningless). The
          [...parsed] copy avoids mutating the parsed array in place. slice(0,10)
          is top-k by full sort: correct because n is small, a heap would be overkill.
```

Linear match + the matched/missed/unexpected split — `packages/evals/src/detection-scorer.ts` (lines 51–82):

```
  for (const requirement of required) {                       ← linear over requirements
    if (matchesRequirement(detections, requirement.kind, requirement.value)) {  ← .some scan
      matched.push(label);
    } else {
      missed.push(label);                                     ← missed = required, not found
      issues.push({ ... });
    }
  }
  const expectedCategories = new Set(expectations.requiredCategories ?? []);  ← Set for O(1) lookup
  const unexpected = detections
    .map((d) => d.category)
    .filter((c) => expectedCategories.size > 0 && !expectedCategories.has(c))  ← not expected
    .map((c) => `category:${c}`);
       │
       └─ classic set-difference framed as detection scoring: matched (required ∩ found),
          missed (required − found), unexpected (found − expected). All linear scans over
          small lists; the Set makes the "unexpected" membership O(1) per detection.
```

And `matchesRequirement` (`:85`) is the inner linear `.some` — for each requirement it scans detections until one matches on the right field (category/metric/scope/severity). O(required × detections), both small.

The deterministic filename sort — `packages/evals/src/replay-runner.ts` (lines 40–43):

```
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name) === '.json')  ← keep .json files
    .map((entry) => join(dir, entry.name))
    .sort();                                                  ← lexicographic, deterministic order
       │
       └─ sorted for REPRODUCIBLE iteration (evals must run in stable order), NOT to
          search it. The list is then walked linearly to eval each artifact. This is
          why binary search never appears — nothing searches the sorted list by key.
```

## Elaborate

Comparison sorts top out at O(n log n) — that's the proven lower bound for comparison-based ordering, and merge/quick/heap sort all hit it (your visualizers show the constant-factor and stability differences). JavaScript's `Array.prototype.sort` is a hybrid (typically Timsort-family) and is stable in modern engines, which matters when ties should preserve input order. The repo leans on the engine's sort rather than hand-rolling — correct, since the from-scratch versions are a learning exercise, not a production need.

Binary search is the payoff of *maintaining* order: O(log n) lookup, but only on sorted data, and keeping data sorted under insertion is itself O(n) per insert into an array (which is why you'd reach for a balanced tree — see `04`). Quickselect is the elegant top-k shortcut: partition like quicksort but recurse into only one side, O(n) average to find the k-th element without fully sorting. Both are absent here for the same reason: no large sorted collection, no large top-k. The triggers are scale triggers, and at AptKit's scale the simple O(n log n) and O(n) operations are the right complexity budget. For the cost reasoning behind "small n means don't optimize," see `01`.

## Interview defense

**Q: "How does the monitoring agent rank anomalies, and why that approach?"**

Maps each severity string to a numeric rank via a lookup table, sorts descending on that rank, then `slice(0, 10)` for top-k. The rank table is the ordering definition — sorting the strings directly would order them alphabetically, which is wrong for severity. It's top-k by full sort, which is correct here because n is small; a heap would be over-engineering.

```
  severity string → rank table → number → sort desc → slice(0,10)
  full sort beats a heap when n is tiny ← the part people over-think
```

Anchor: *rank-table-then-sort is how you order categorical data, and full-sort top-k is right when n is small.*

**Q: "Why is there no binary search anywhere?"**

Because nothing maintains a sorted collection that it searches by key. The one sort (replay filenames) is for deterministic iteration order, then the list is walked linearly to eval — never searched. Binary search needs a maintained sorted index and repeated key lookups; that pattern only appears at a scale this repo doesn't have. At that scale I'd use a database's B-tree index, not hand-rolled binary search.

```
  sort filenames → iterate all linearly   (never search by key)
  binary search needs: maintained sorted index + repeated lookup
```

Anchor: *binary search needs a searched sorted index — the repo sorts for order, never to search, so it never qualifies.*

**Q: "When would you replace the sort-and-slice with quickselect or a heap?"**

When top-k has k ≪ n and n is large — top 10 of 100,000. Then a size-k heap (O(n log k)) or quickselect (O(n) average) beats the full O(n log n) sort meaningfully. Here k=10 and n is rarely above 10, so the full sort is simpler and effectively free. I'd switch only when a profiler showed the sort mattering, which it won't at this scale.

```
  k ≪ n, large n → heap O(n log k) or quickselect O(n)
  here k≈n, tiny n → full sort wins on simplicity
```

Anchor: *the top-k shortcut pays off only when k ≪ n and n is large — neither holds, so sort-and-slice is correct.*

## Validate

**Reconstruct.** Write the severity ranking from memory: rank table, `sort((l,r) => rank[r] - rank[l])`, `slice(0, 10)`. State why sorting the severity strings directly would be wrong.

**Explain.** In `detection-scorer.ts`, describe the matched/missed/unexpected three-way split as set operations (intersection, difference, difference) and say why the `unexpected` check uses a `Set` (O(1) membership per detection vs O(expected) per detection with an array).

**Apply to a scenario.** The eval system grows to 200,000 saved replay artifacts and you need to find the one with a specific `capabilityId` and `createdAt`. Is the current `readdir + sort + linear scan` still fine? What changes? (Answer: linear scan over 200k is now slow per lookup; if you query repeatedly by key, you want an index — sort by the key and binary-search, or move to a database with a B-tree index. This is the exact trigger that summons binary search / an index, absent today because n is small.)

**Defend the decision.** Someone wants the anomaly ranking to use quickselect "for O(n) performance." Defend the sort-and-slice. (Answer: quickselect's O(n) average beats O(n log n) only at large n; here n ≤ 10, so log n is ~3 — the asymptotic win is invisible and quickselect adds partitioning complexity and a worst case. The full sort is simpler, stable, and free at this size. Premature optimization.)

## See also

- `01-complexity-and-cost-models.md` — why "small n" makes these O(n log n) / O(n) operations effectively free.
- `02-arrays-strings-and-hash-maps.md` — the `Set` that makes the `unexpected` membership check O(1), and the linear scans' hash-lookup complement.
- `03-stacks-queues-deques-and-heaps.md` — the heap that top-k *would* use if k ≪ n and n were large.
- `04-trees-tries-and-balanced-indexes.md` — the balanced index binary search needs but the repo lacks.
- `study-ai-engineering` (neighboring guide) — detection scoring as an eval metric, viewed as AI evaluation rather than set arithmetic.
