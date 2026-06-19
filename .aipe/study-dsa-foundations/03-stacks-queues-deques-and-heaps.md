# 03 — Stacks, Queues, Deques, and Heaps

**Industry name(s):** Stack (LIFO), queue (FIFO), deque, append-only log, round-robin scheduling, priority queue / binary heap. Type label: Language-agnostic foundation.

## Zoom out, then zoom in

Ordering disciplines decide *what gets processed next*. AptKit has two of them in real use — an append-only message log (the agent transcript) and a modulo round-robin scheduler (the content workflow) — and two that are `not yet exercised`: an explicit stack, and a heap/priority queue. The exercised pair is worth a careful walk because they're easy to miss: they don't *look* like a queue or a stack, but they're playing exactly those roles.

```
  Zoom out — ordering disciplines in AptKit

  ┌─ Runtime: agent loop ────────────────────────────────┐
  │  messages[]  ── APPEND-ONLY LOG (FIFO read order)     │ ← exercised
  │    push(assistant), push(tool results), repeat        │
  └───────────────────────────┬───────────────────────────┘
                              │
  ┌─ Workflows ───────────────▼───────────────────────────┐
  │  planContentVariant  ── ROUND-ROBIN via index % n      │ ← exercised
  └───────────────────────────┬───────────────────────────┘
                              │
  ┌─ (absent) ────────────────▼───────────────────────────┐
  │  explicit stack            not yet exercised           │
  │  heap / priority queue     not yet exercised           │ ← your reincodes PQ
  └────────────────────────────────────────────────────────┘
```

Zoom in: a queue serves in arrival order (FIFO), a stack in reverse-arrival order (LIFO), a deque from both ends, and a heap serves by *priority* regardless of arrival. AptKit needs the first idea (process the conversation in order) and a scheduler that *cycles* fairly (round-robin), but it never needs priority ordering — because nothing here has a "most urgent next item" among many. We'll walk the two it has, then be precise about why the heap isn't there and exactly what would summon it.

## Structure pass

**Layers.** Runtime (the message log that the loop reads in order), workflows (the round-robin that picks the next variant's section+angle).

**Axis — trace "what's processed next?"** across the orderings.

```
  One axis — "what gets served next?" — across orderings

  queue (FIFO)      next = oldest unserved      arrival order
  stack (LIFO)      next = newest unserved      reverse arrival
  round-robin       next = (i+1) mod n          cyclic, fair
  heap (priority)   next = highest priority     ignores arrival   ← absent

  aptkit's message log: read FIFO (turn order)
  aptkit's scheduler:   round-robin (cyclic fairness)
  aptkit's ranking:     full sort + slice, NOT a heap (see 06)
```

**Seam.** The interesting boundary is between *round-robin* (the workflow's "serve each angle in turn, fairly") and *priority ordering* (a heap's "serve the most important first"). The axis-answer — what's served next — flips from "next in the cycle" to "highest priority." AptKit sits firmly on the round-robin side: its scheduling goal is *coverage/fairness across angles*, not *urgency*. That's why there's no heap. The seam is conceptual here, not in code — but knowing which side of it a problem sits on is how you decide between modulo and a priority queue.

## How it works

### Move 1 — the mental model

You know these from the call stack and from event queues. A stack is your function call stack — last-in, first-out, the most recent frame returns first. A queue is the browser's event loop task queue — first-in, first-out, tasks run in arrival order. Round-robin is what a fair scheduler does: A, B, C, A, B, C — cycle through everyone before repeating. A heap is the odd one out — it serves by priority, like a hospital triage where the sickest go first regardless of arrival.

```
  The kernels — what comes off next

  QUEUE          STACK          ROUND-ROBIN        HEAP
  [a b c]        [a b c]        cycle 0..n-1       sorted-ish by key
   ↑take          take↑          i, (i+1)%n,...     take-min/max
  serve a        serve c        a,b,c,a,b,c        serve highest pri
  FIFO           LIFO           fair cycle         priority, O(log n)
```

AptKit reaches for two of these: read the message log in arrival order (queue-like FIFO), and pick the next content variant by cycling (round-robin). It never reaches for the heap, because no problem here is "find the highest-priority item among many, repeatedly."

### Move 2 — the two exercised disciplines

**The message log — append-only, read in order (FIFO).** Bridge from the event-loop task queue: the agent loop maintains a `messages` array that only ever grows by appending, and the model reads the whole thing in order each turn. It's a transcript, not a work queue you pop from — but the *discipline* is queue-like: items are consumed in the order they arrived, never reordered.

```
  Message log — append-only, FIFO read order

  turn 0:  push(user prompt)                  [u]
           model reads [u] → emits tool_use
           push(assistant reply)              [u, a]
           push(tool results)                 [u, a, t]
  turn 1:  model reads [u, a, t] → ...
           push(assistant)                    [u, a, t, a]
           push(tool results)                 [u, a, t, a, t]
  ─────────────────────────────────────────────────────────
  grows by ~2 per turn, read front-to-back, never reordered
```

What breaks if you reordered it: the model loses the causal thread — a tool result must follow its tool call, an answer must follow the question. The append-only, in-order discipline *is* the conversation's integrity. The boundary condition is unbounded growth — defended by `maxTurns` (the log can't grow past ~2·maxTurns entries) and per-result truncation (`truncate`, 16k chars). It's a queue that's *capped*, not a queue you drain.

**Round-robin scheduling — `index % n`, cyclic fairness.** Bridge from a fair task scheduler: the content workflow needs to generate N variants of a document, spreading them across the document's sections *and* across a set of "angles" (e.g. different framings). It does this with modulo: variant `i` gets section `i % sectionCount` and angle `i % angleCount`. As `i` climbs, both cycle independently, so coverage is even.

```
  Execution trace — round-robin over 3 sections, 2 angles

  sections = [S0, S1, S2]   angles = [A0, A1]

  variant 0: section 0%3=S0  angle 0%2=A0     (S0, A0)
  variant 1: section 1%3=S1  angle 1%2=A1     (S1, A1)
  variant 2: section 2%3=S2  angle 2%2=A0     (S2, A0)
  variant 3: section 3%3=S0  angle 3%2=A1     (S0, A1)
  variant 4: section 4%3=S1  angle 4%2=A0     (S1, A0)
  ─────────────────────────────────────────────────────
  sections cycle every 3, angles every 2 — coprime-ish
  spread means no (section, angle) pair repeats for a while
```

What breaks without the modulo: you'd either always hit section 0 (no coverage) or need an explicit cursor you increment and wrap by hand (the modulo *is* the wrap, done arithmetically). The boundary condition the repo guards: empty inputs — `planContentVariant` throws if `sections.length === 0` or `angles.length === 0`, because `i % 0` is `NaN` and would silently corrupt the schedule. That guard is load-bearing.

### Move 2.5 — current state vs future state: the heap

The heap is `not yet exercised`, and it's worth being precise about why, because you've built one (`BinaryHeap.ts`, `PriorityQueue.ts` in `reincodes`) and the instinct might be to reach for it.

```
  Phase A (now)              vs   Phase B (would summon a heap)

  rank ≤10 anomalies:             top-k where k ≪ n and n is large:
    full sort O(n log n)            heap of size k, O(n log k)
    + slice(0, 10)                  e.g. top 10 of 100,000 candidates

  bounded concurrency:            bounded-concurrency scheduler:
    not present                     min-heap of next-available-times,
                                    pop earliest, schedule, push back

  cost of switching now: real complexity for zero measurable gain —
  n is single/double digits, so full sort already wins.
```

The honest call: AptKit's "serve next" problems are all small (≤10 anomalies, ≤3 recommendations) or cyclic (round-robin), and neither benefits from a heap. A heap earns its O(log n) overhead only when you repeatedly extract the extreme from a *large, changing* collection. Nothing here is large and changing. The trigger that would flip this to Phase B: a bounded-concurrency worker pool over many pending tasks (min-heap keyed by ready-time), or top-k selection where k ≪ n on a genuinely large candidate set. See `06` for the top-k discussion in depth.

### Move 3 — the principle

The ordering discipline you pick encodes *what "next" means* for your problem. FIFO means "in arrival order" — right for a transcript. Round-robin means "fairly cycle" — right for spreading work evenly. A heap means "by priority" — right only when there's a meaningful priority among many items and you extract the extreme repeatedly. Choosing the wrong discipline (a heap for a 10-item list, a queue where you needed priority) is a complexity mismatch in both directions. AptKit's two choices are correctly matched; the heap's absence is a correct match too.

## Primary diagram

The two exercised orderings in one frame, side by side with the absent heap.

```
  AptKit ordering disciplines — exercised vs absent

  ┌─ EXERCISED ─────────────────────────────────────────┐
  │  message log (runtime)        round-robin (workflows)│
  │  ┌───────────────┐            i % sections           │
  │  │ u → a → t → a │ FIFO       i % angles              │
  │  │ append-only   │ read       cyclic, fair spread     │
  │  │ capped by     │ in order   guard: throw on empty   │
  │  │ maxTurns      │                                    │
  │  └───────────────┘                                    │
  └──────────────────────────────────────────────────────┘
  ┌─ NOT YET EXERCISED ─────────────────────────────────┐
  │  stack (LIFO)     — no explicit use                  │
  │  heap / PQ        — your reincodes PQ; summoned by    │
  │                     top-k(k≪n, large n) or a bounded  │
  │                     concurrency scheduler             │
  └──────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The message log is built and appended on every turn of every agent run (`run-agent-loop.ts`). Round-robin scheduling runs whenever the content workflow generates variants for a source document — it's the workflow's core fairness mechanism.

The append-only log — `packages/runtime/src/run-agent-loop.ts` (lines 94, 124, 189):

```
  const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];  ← line 94, seed
  ...
  messages.push({ role: 'assistant', content: response.content });            ← line 124
  ...
  messages.push({ role: 'user', content: toolResults });                      ← line 189
       │
       └─ append-only. The model reads `messages` whole each turn (passed to
          model.complete). Order = causal order: a tool_result block must follow
          its tool_use. Reordering breaks the conversation. Growth is capped by
          the maxTurns loop bound (~2 entries/turn), not by draining.
```

Round-robin scheduling — `packages/workflows/src/content-generation-workflow.ts` (lines 139–157, `planContentVariant`):

```
  export function planContentVariant(options): ContentVariantPlan {
    if (options.sections.length === 0)
      throw new Error('planContentVariant requires at least one section');   ← guard: i % 0
    if (options.angles.length === 0)
      throw new Error('planContentVariant requires at least one angle');     ← guard: i % 0

    const sectionIndex = options.variantIndex % options.sections.length;     ← cycle sections
    return {
      sourceHash: options.sourceHash,
      variantIndex: options.variantIndex,
      sectionIndex,
      totalSections: options.sections.length,
      section: options.sections[sectionIndex],
      angle: options.angles[options.variantIndex % options.angles.length],   ← cycle angles
    };
       │
       └─ two independent modulo cursors. variantIndex climbs monotonically; both
          section and angle wrap on their own period. The empty-input throws are
          load-bearing: i % 0 = NaN would index `undefined` and corrupt the plan
          silently.
  }
```

And the driver that climbs `variantIndex` — same file, `ensureGeneratedContent` (lines 92–98): `baseIndex` continues past existing variants, and the loop increments `variantIndex` until enough fresh variants exist or a skip budget (`maxSkips`) is exhausted. That skip budget is itself a small bounded-retry — when a generator returns `null`, it advances to the next variant index rather than failing, up to `lastIndex`.

## Elaborate

Stacks and queues are the two fundamental linear orderings, and the choice between them is the choice between LIFO and FIFO — recursion uses a stack (the call stack), breadth-first processing uses a queue. Round-robin is a scheduling classic: it's how time-sharing OSes give each process a fair slice, and modulo arithmetic is the cleanest way to express "wrap around" without a manual cursor.

The heap is where your `reincodes` work shines and AptKit stays quiet. A binary heap gives O(log n) insert and O(log n) extract-min/max with a flat array and `heapifyUp`/`heapifyDown` — no pointers, cache-friendly. It's the backing structure for a priority queue, which is the backing structure for Dijkstra (your `Graph2.ts` + `PriorityQueue.ts`). AptKit has none of these because it has no shortest-path, no large top-k, no priority scheduling. The day it grows a worker pool that must run the *next-ready* task among many, the min-heap-by-ready-time is the move — and you've already built it.

For how the agent loop's bounded iteration relates to runtime execution (event loop, cancellation), see `study-runtime-systems`. For why the message log's truncation and turn cap are framed as backpressure, see `study-performance-engineering`.

## Interview defense

**Q: "Is there a queue in this codebase? Where?"**

Functionally yes, structurally implicit. The `messages` array in the agent loop is an append-only log read in FIFO order — items consumed in arrival order, never reordered, because a tool result must follow its call. It's not a queue you pop from; it's a capped transcript. The cap is `maxTurns`, which bounds its growth to ~2 entries per turn.

```
  push(a) push(t) push(a) push(t) ...   read front→back each turn
  capped by maxTurns, not drained
```

Anchor: *it's a FIFO log, not a work queue — and the load-bearing detail is that order = causal order.*

**Q: "Why round-robin via modulo instead of a queue or a heap for the content scheduler?"**

The goal is *fair coverage* across sections and angles, not priority and not draining. Modulo gives that in one line per dimension: `i % n` cycles with no manual cursor or wrap logic. A queue would force you to refill it each cycle; a heap would impose priority ordering the problem doesn't have. The only sharp edge is `i % 0`, guarded by the empty-input throws.

```
  variant i → (i % sections, i % angles) → fair spread, no cursor
  guard i % 0 = NaN with an explicit throw ← the part people forget
```

Anchor: *round-robin is the right discipline when the goal is fairness, not urgency — and the modulo IS the wrap.*

**Q: "When would you add a heap here?"**

When there's a repeated extract-extreme over a large, changing collection. Two concrete triggers: top-k where k ≪ n and n is large (a size-k heap beats a full sort), or a bounded-concurrency scheduler (min-heap keyed by next-ready-time, pop earliest). Neither exists today — anomalies are ≤10, so a full sort already wins, and there's no worker pool. Adding a heap now would be complexity with no measurable benefit.

```
  heap pays off:  extract-extreme × many,  n large
  here:           n ≤ 10  →  full sort wins  →  no heap
```

Anchor: *a heap earns its log n only on a large, changing collection you extract from repeatedly — AptKit has neither, so its absence is correct.*

## Validate

**Reconstruct.** Write the round-robin assignment for variant indices 0–5 over 2 sections and 3 angles. (Check: section = i%2, angle = i%3.) State why `planContentVariant` throws on empty arrays.

**Explain.** In `run-agent-loop.ts`, why must `messages.push` for tool results (line 189) come *after* the assistant push (line 124) within a turn? (Answer: the tool_result blocks reference the tool_use ids from the assistant message; the provider requires the result to follow its call, so order is a contract, not a preference.)

**Apply to a scenario.** The content workflow needs to generate variants but should never reuse the same (section, angle) pair until all pairs are exhausted. Does plain modulo guarantee that? (Answer: not in general — `i % sections` and `i % angles` cycle on independent periods, so pairs repeat with period `lcm(sections, angles)`; if the counts share a factor, some pairs never appear. The fix is index over the *product* space, or step angle by a value coprime to the count. This is the limit of the current scheduler — worth knowing it's coverage-fair, not exhaustive-unique.)

**Defend the decision.** Someone wants the anomaly ranking (`monitoring-agent.ts:87`) to use your `PriorityQueue` instead of a sort. Defend the sort. (Answer: n ≤ 10 and k = 10 means you want *all* of them ordered, not the top few of many — a heap gives no advantage when k ≈ n and n is tiny. The sort is simpler and already O(n log n) on a trivial n. The PQ is the right tool for Dijkstra's frontier, not for sorting ten items.)

## See also

- `06-sorting-searching-and-selection.md` — the comparator sort + slice top-k that does the job a heap would, and when binary search applies.
- `01-complexity-and-cost-models.md` — why the message log's growth is bounded and amortized O(1).
- `05-graphs-and-traversals.md` — where a queue (BFS frontier) and a heap (Dijkstra) *would* appear if the repo grew a real graph.
- `study-runtime-systems` (neighboring guide) — the agent loop as bounded iteration with cancellation.
