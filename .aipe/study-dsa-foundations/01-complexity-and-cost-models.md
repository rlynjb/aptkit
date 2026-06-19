# 01 — Complexity and Cost Models

**Industry name(s):** Time/space complexity, amortized analysis, asymptotic cost — and, for this repo specifically, the *token-and-turn budget* as the dominant cost. Type label: Language-agnostic foundation.

## Zoom out, then zoom in

Cost analysis is usually a question you ask about a data structure: "what's the Big-O of this lookup?" In AptKit that question is almost never the one that decides anything. The cost that decides everything sits one layer up — in the agent loop, where each iteration is a network round-trip to a model that bills per token.

```
  Zoom out — where "cost" actually lives in AptKit

  ┌─ Agent capability layer ─────────────────────────────┐
  │  ranks ≤10 anomalies, ≤3 recs  →  O(n log n) sort,    │
  │                                   n tiny — free       │
  └─────────────────────────┬─────────────────────────────┘
                            │ each turn =
  ┌─ Runtime: the agent loop ▼ ───────────────────────────┐
  │  ★ for turn < maxTurns:  model.complete() ★            │ ← cost lives here
  │    one network + token round-trip per iteration        │
  │    bounded by maxTurns AND maxToolCalls                 │
  └─────────────────────────┬─────────────────────────────┘
                            │ summarized by
  ┌─ Usage ledger ───────────▼────────────────────────────┐
  │  reduce(events) → totalTokens → estimateCost → USD     │
  └────────────────────────────────────────────────────────┘
```

See the starred box? That's the real cost model. Big-O still exists in this repo — the sorts, the scans, the Set lookups all have asymptotic costs — but every one of them operates on a handful of items, so they round to free. What you actually budget, measure, and cap is *model turns and tokens*. This file teaches both: the classic cost vocabulary (so you can reason about the structures), and the token-budget reframe (because that's the one that bites here).

## Structure pass

**Layers.** Three altitudes, as in the diagram: the capability layer (ranks small lists), the loop layer (drives model round-trips), the ledger layer (accounts for what the loop spent).

**Axis — trace "cost":** hold the question *"what does one unit of work cost here?"* constant down the stack.

```
  One axis — "cost per unit of work" — traced down

  capability sort   → O(n log n), n≈10        → microseconds, free
  one loop turn     → 1 model round-trip       → 100s ms + $ per token
  one ledger reduce → O(events), events≈turns  → microseconds, free

  the answer flips at the loop layer: that's the only
  altitude where cost is measured in money and seconds
```

**Seam.** The load-bearing boundary is between the capability/ledger layers (where cost is asymptotic and negligible) and the loop layer (where cost is monetary and bounded by an explicit budget). The axis-answer flips from "free CPU" to "billed I/O" exactly at `model.complete()`. That flip is why the repo invests its only real cost-control machinery — `maxTurns`, `maxToolCalls`, the synthesis forcing turn — at the loop, and spends zero effort optimizing the sorts.

## How it works

### Move 1 — the mental model

You already know the shape of complexity from sorting visualizers: bubble sort's nested loop is O(n²), merge sort's divide is O(n log n), and you *see* the bar-swap count explode as n grows. That's the picture — cost as a function of input size n. Hold that, then swap the unit: in AptKit the dominant "n" isn't array length, it's **number of model turns**, and the cost per unit isn't a comparison, it's a **billed token round-trip**.

```
  Two cost models, same shape — pick the dominant term

  classic:   cost(n) = c · f(n)        f ∈ {1, log n, n, n log n, n²}
             n = input size            c = cost per primitive op (cheap)

  this repo: cost(turns) = turns · (tokens · price)
             turns ≤ maxTurns          per-turn cost = network + $ (expensive)

  when one term dominates by 1000×, that's the term you budget.
  here the model round-trip dominates → budget turns, ignore the sort
```

The skill is recognizing which term dominates. A staff engineer doesn't optimize an O(n log n) sort of 10 items inside a loop that makes a 400ms billed API call each turn — that's optimizing the free thing while the expensive thing runs unbounded. AptKit gets this right: it bounds the expensive thing and leaves the cheap thing alone.

### Move 2 — the cost vocabulary, one term at a time

**Time complexity — count the primitive operations as input grows.** Bridge from the sort visualizer: you counted comparisons. Big-O drops constants and lower-order terms and keeps the dominant growth. A `Map.get` is O(1) — one hash, one bucket probe, independent of how many tools are registered. A linear filter is O(n) — touch every element once. A comparator sort is O(n log n).

```
  Growth classes — the only ones in this repo

  O(1)        Map.get(name)           registry lookup, any size
  O(n)        filter / classify scan  coverage report, detection match
  O(n log n)  arr.sort(comparator)    anomaly/variant ranking
  ───────────────────────────────────────────────────────────
  absent:  O(log n) binary search,  O(V+E) graph traversal,
           O(n·W) DP table — no input here is large enough to need them
```

The boundary condition: O(n²) would show up the instant you nested a scan inside a scan over the same large list. The repo never does — `detection-scorer.ts` scans `required` (small) against `detections` (small), which is O(required · detections) but both factors are single digits.

**Space complexity — count the extra memory the work allocates.** The agent loop's `messages` array grows by roughly two entries per turn (assistant reply + tool results), so its space is O(turns), bounded by `maxTurns`. The `Set` built from an allowlist is O(allowed). Nothing here allocates memory proportional to a large or unbounded input.

**Amortized analysis — average cost per operation across a sequence, even when one operation is occasionally expensive.** The canonical example is a dynamic array: most `push`es are O(1), but the occasional resize is O(n); amortized over many pushes it's still O(1) each. The agent loop's `messages.push` is exactly this — each turn appends, the underlying array resizes rarely, amortized O(1) per turn. You don't think about it because the array is small, but the analysis is the same one you'd apply to your `BinaryHeap`'s backing array in `reincodes`.

```
  Amortized push — most cheap, rare resize, average O(1)

  push push push [resize: copy n] push push push [resize] ...
   1    1    1      n (rare)        1    1    1
  ─────────────────────────────────────────────────────────
  total over m pushes ≈ 2m  →  amortized 2  →  O(1) per push
```

**The token-and-turn budget — the dominant cost model here.** This is the term that actually decides behavior. Each loop turn calls `model.complete()`; that's the expensive unit. The repo bounds it two ways: a hard turn cap (`maxTurns`) and a tool-call budget (`maxToolCalls`). When either is hit, the loop forces a final synthesis turn with tools removed, so the model *must* answer instead of asking for more data.

```
  Execution trace — the turn budget as the real cost cap

  maxTurns = 6, maxToolCalls = 6

  turn 0: complete(tools=on)  → 2 tool calls   spent=2   budget ok
  turn 1: complete(tools=on)  → 3 tool calls   spent=5   budget ok
  turn 2: complete(tools=on)  → 1 tool call    spent=6   budget HIT
  turn 3: forceFinal=true → complete(tools=OFF, synthesis prompt)
          → model must answer now, no more queries          ← cap fires
  ─────────────────────────────────────────────────────────
  cost = 4 billed round-trips, hard-capped. never unbounded.
```

The boundary condition this defends: without the budget, a confused model can loop calling tools forever, burning tokens and dollars with no answer. The cap *converts* an unbounded cost into a bounded one — and that conversion is worth more than any asymptotic improvement to the structures inside.

### Move 3 — the principle

Cost analysis is about finding the dominant term and budgeting *that*. The asymptotic class of a structure only matters when its input can grow; when the input is small and bounded, the dominant cost moves elsewhere — here, to the billed model round-trip. The discipline that transfers: before optimizing, ask "what's the unit of work, and what does one unit actually cost?" In a sort visualizer it's a comparison; in an agent loop it's a token round-trip. Budget the expensive unit, leave the cheap one alone.

## Primary diagram

The full cost picture for one agent run, from input to priced output.

```
  AptKit cost model — one capability run end to end

  ┌─ input ──────────────────────────────────────────────┐
  │  workspace descriptor + user prompt (small, bounded)  │
  └───────────────────────┬───────────────────────────────┘
                          ▼
  ┌─ agent loop (the cost center) ────────────────────────┐
  │  for turn in 0..maxTurns:          ← bounds turn count │
  │    spent = toolCalls ≥ maxToolCalls? ← bounds tool use │
  │    response = model.complete(...)  ← BILLED round-trip │
  │    emit model_usage event (tokens) ──────────┐         │
  │  forceFinal turn removes tools → must answer  │         │
  └───────────────────────┬───────────────────────│─────────┘
            cheap, free    ▼                       │ token counts
  ┌─ ranking ─────────────────────────┐  ┌─ ledger ▼ ──────────┐
  │  sort O(n log n) + slice, n tiny   │  │ reduce → totalTokens│
  └────────────────────────────────────┘  │ estimateCost → USD  │
                                           └──────────────────────┘
```

## Implementation in codebase

**Use cases.** Cost control fires on every agent run. The monitoring agent caps at `maxTurns: 8, maxToolCalls: 6`; the recommendation agent at `maxTurns: 6`. The ledger runs after any run that emitted `model_usage` events, turning the trace into a token total and a USD estimate for Studio and replay summaries.

The turn budget — the dominant cost cap, in `packages/runtime/src/run-agent-loop.ts` (lines 98–109):

```
  for (let turn = 0; turn < maxTurns; turn += 1) {        ← hard turn cap
    signal?.throwIfAborted();                              ← cancellation point
    const budgetSpent =
      maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;  ← tool budget
    const forceFinal = turn === maxTurns - 1 || budgetSpent;          ← either cap → final
    const response = await model.complete({
      system: forceFinal && synthesisInstruction
        ? `${system}\n\n${synthesisInstruction}` : system,  ← forcing prompt on final
      messages,
      tools: forceFinal ? undefined : toolSchemas,          ← strip tools to force answer
      maxTokens,
      signal,
    });
       │
       └─ the two caps (maxTurns, maxToolCalls) are the entire cost-control
          mechanism. Drop them and a looping model burns tokens unbounded —
          this is the load-bearing budget, not the asymptotics below it.
```

The amortized append — same file, line 124 (and the tool-results push at line 189):

```
  messages.push({ role: 'assistant', content: response.content });
       │
       └─ O(1) amortized per turn; array grows O(turns), bounded by maxTurns.
          space is O(turns), not O(input) — the input never drives memory here.
```

The cost reduce — `packages/runtime/src/usage-ledger.ts` (lines 25–42):

```
  return trace.reduce<TokenUsageSummary>(
    (summary, event) => {
      if (event.type !== 'model_usage') return summary;       ← skip non-usage events
      const inputTokens = event.inputTokens ?? 0;
      const outputTokens = event.outputTokens ?? 0;
      return {
        inputTokens: summary.inputTokens + inputTokens,        ← O(events) single pass
        outputTokens: summary.outputTokens + outputTokens,
        totalTokens: summary.totalTokens + inputTokens + outputTokens,
        turns: summary.turns + 1,                              ← turn count = cost units
        estimated: summary.estimated || event.estimated === true,
      };
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, ... },
  );
       │
       └─ one linear pass over the event log. The asymptotics are trivial; the
          NUMBER it produces (totalTokens) is the cost that matters.
```

And the price step — `usage-ledger.ts:50` `estimateCost` divides tokens by 1e6 and multiplies by per-million pricing from `pricingForModel` (`:71`), which today only knows `gpt-4.1-*` rates. Note the honest gap: Anthropic models return `undefined` pricing, so their USD estimate is `'n/a'` — a real limitation, not a bug to hide.

## Elaborate

Asymptotic analysis comes from algorithm theory — Knuth's notation for describing growth independent of machine speed. It exists so you can compare algorithms before running them. The token-budget reframe is newer and operational: it comes from production LLM engineering, where the bottleneck moved from CPU to a metered external API. Both are the same intellectual move — find the dominant term, bound it — applied to different units.

The thing worth internalizing: AptKit deliberately does *not* optimize its data structures, and that's a senior decision, not laziness. A comparator sort of 10 items inside a loop that makes billed network calls is correctly left alone. If you ever see the sorts show up in a profiler here, something is very wrong upstream. Read `01` of `study-performance-engineering` for how the repo measures the part that actually costs.

## Interview defense

**Q: "This agent loop sorts and scans on every turn. Should you optimize those?"**

No — and being able to say *why* is the signal. The dominant cost is the `model.complete()` round-trip: hundreds of milliseconds and real dollars per turn. The sorts operate on ≤10 items, microseconds, rounding to free. Optimizing them is optimizing the cheap term while the expensive one runs. I'd budget the expensive term instead — which is exactly what `maxTurns` and `maxToolCalls` do.

```
  cost(run) = turns · (round-trip 100s ms + $)  +  turns · (sort μs)
              └──────── dominant, 1000× ────────┘    └─ negligible ─┘
  budget the left term. ignore the right.
```

Anchor: *the dominant cost is the billed round-trip, not the asymptotics — so you bound turns, not the sort.*

**Q: "What's the load-bearing line in the cost model — the one people forget?"**

`forceFinal = turn === maxTurns - 1 || budgetSpent` at `run-agent-loop.ts:102`, paired with `tools: forceFinal ? undefined : toolSchemas`. People remember the turn cap; they forget that hitting the cap must *force an answer* by stripping tools and injecting a synthesis instruction. Without that, the cap just truncates mid-investigation and you get no output — you've spent the tokens and gotten nothing.

```
  budget hit → strip tools → model has no choice but to answer
  forget this → cap truncates, tokens spent, zero output
```

Anchor: *the budget isn't just a counter; it converts "out of budget" into "answer now."*

## Validate

**Reconstruct.** From memory, write the two-line cost model for an AptKit run: `cost = turns · (round-trip + tokens·price)`, bounded by `maxTurns` and `maxToolCalls`. Name the asymptotic class of the registry lookup (O(1)), the coverage scan (O(n)), and the anomaly ranking (O(n log n)).

**Explain.** Why does `run-agent-loop.ts:124`'s `messages.push` count as amortized O(1), and why doesn't its space cost depend on input size? (Answer: array append amortizes resizes; space is O(turns), and turns is capped, not driven by input.)

**Apply to a scenario.** Replays grow to 50,000 saved artifacts and `listReplayArtifacts` (`replay-runner.ts:31`) does a `readdir` + `.sort()` on every eval run. Which cost term now matters, and is it still negligible? (Answer: the sort is now O(50k log 50k) on filenames — still milliseconds, but the `readdir` I/O is the real new cost; the asymptotics finally became measurable because n grew. This is the trigger where binary search over a sorted index would start to pay — see `06`.)

**Defend the decision.** Someone proposes replacing the anomaly comparator sort (`monitoring-agent.ts:87`) with a heap for "better performance." Defend keeping the sort. (Answer: n ≤ 10, k = 10; a heap's O(n log k) beats O(n log n) only when k ≪ n and n is large. Neither holds. The sort is simpler, correct, and free here. The heap would be a complexity cost with no measurable benefit.)

## See also

- `02-arrays-strings-and-hash-maps.md` — the O(1) and O(n) structures whose cheapness this file relies on.
- `06-sorting-searching-and-selection.md` — the O(n log n) ranking sorts, and when binary search becomes worth it.
- `study-performance-engineering` (neighboring guide) — how the repo measures the billed round-trip, the cost that actually dominates.
- `study-system-design` (neighboring guide) — why the model round-trip sits where it does, and the provider-neutral seam around it.
