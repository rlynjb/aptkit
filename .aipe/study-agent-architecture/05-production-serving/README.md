# 05 — Production Serving (for the agent loop)

> Serving an agent is serving a *loop*, not a call. Caching, backpressure, and circuit breaking all change shape once the unit of work re-enters itself.

## Subtitle

What single-call serving becomes once the unit is an autonomous loop — and an honest accounting of which of those controls AptKit actually has.

---

## Zoom out

You already know the single-call serving story from frontend work. You cache a `GET` so the browser reuses it. You cap `Promise.all` concurrency so you don't open 500 sockets at once. You fail fast on a dead endpoint instead of hanging every request behind it. The single-call versions of all three live next door in `.aipe/study-ai-engineering/06-production-serving/` — go read those for the request-level mechanics; this section does **not** re-teach them.

Here is the thing that changes. An agent is not one call. It is a loop that calls the model, runs tools, feeds results back, and calls the model *again* — possibly eight times in one run. Every serving control you know gets a second axis: **time within the run**.

```
Serving controls, by axis
┌──────────────────────────────────────────────────────────────┐
│  SINGLE CALL  (ai-eng 06)        │  THE LOOP  (this section)   │
├──────────────────────────────────┼─────────────────────────────┤
│  cache one response              │  cache across TURNS + RUNS  │
│  cap concurrency on N fetches    │  cap concurrency on FAN-OUT │
│  fail fast on one dead endpoint  │  breaker PER TOOL, in-loop  │
└──────────────────────────────────┴─────────────────────────────┘
              (you know this)            (the loop reshapes it)
```

The left column is a property of *one* request. The right column is a property of a *trajectory* — a sequence of model+tool steps that share state and can compound each other's mistakes. A stale cache in one fetch is a slow page. A stale cache feeding turn 3 of an agent run poisons turns 4 through 8.

---

## Structure pass

This section is three patterns, one per file, plus this index. The axis that organizes them is **what the loop does to a familiar serving control**.

```
Reading order (the loop's three serving pressures)
┌─────────────────────────────────────────────────────────────┐
│  01 cross-turn caching                                        │
│     └─ "the model re-derives the same thing every turn"       │
│        → reuse stable prefixes / intra-run / cross-run        │
│                          │                                    │
│                          ▼                                    │
│  02 fan-out backpressure                                      │
│     └─ "the loop wants to do N things at once"                │
│        → semaphore + push back when the queue grows           │
│                          │                                    │
│                          ▼                                    │
│  03 per-tool circuit breaking                                 │
│     └─ "one dead tool burns the whole budget on retries"      │
│        → breaker state fed back to the agent as observation   │
└─────────────────────────────────────────────────────────────┘
```

Read 01 → 02 → 03. They escalate: 01 is about *not recomputing*, 02 is about *not overloading*, 03 is about *not wasting the loop on a corpse*.

---

## How it works (the section-level frame)

**Move 1 — mental model.** Picture the loop as a pipeline that re-enters itself. Each of the three patterns clamps a different valve on that pipeline.

```
PATTERN: where each control clamps the loop
        ┌───────────────── agent run ─────────────────┐
        │                                              │
user →  │  [model.complete] → [tools] → [feed back] ──┐│
        │       ▲   ▲             ▲           │       ││
        │       │   │             │           └───────┘│  (loop back, next turn)
        │       │   │             │                    │
        │   01 cache  02 backpressure  03 breaker      │
        │   the prefix  on fan-out      per tool       │
        └──────────────────────────────────────────────┘
```

**Move 2 — what each file does.** 01 attacks the model-input side (don't re-send/re-derive the stable parts). 02 attacks the tool-dispatch side (don't fire unbounded parallel work). 03 attacks the tool-result side (don't keep calling a tool that is reliably failing).

**Move 3 — principle.** In a loop, every serving control needs *memory of the trajectory so far*. A cache needs to know what was already derived; backpressure needs to know how much is in flight; a breaker needs to know how many times this dependency has already failed *this run*. Stateless single-call controls don't carry that memory. That is the entire difference between the two columns above.

---

## Primary diagram

The honest map of this section: the pattern on the left, what AptKit actually has on the right.

```
Pattern  ──vs──  what AptKit has today
┌────────────────────────┬───────────────────────────────────────────┐
│ 01 cross-turn caching   │ NONE in production.                        │
│   prefix / intra / cross│ Adjacent: messages[] accumulates in-run;   │
│                         │ replay artifacts = cache-of-record (tests).│
├────────────────────────┼───────────────────────────────────────────┤
│ 02 fan-out backpressure │ NONE. Single-agent; tool calls run in a    │
│   semaphore + push-back │ SEQUENTIAL for-loop. maxToolCalls = budget │
│                         │ (not concurrency).                         │
├────────────────────────┼───────────────────────────────────────────┤
│ 03 per-tool breaking    │ NO per-tool breaker. Adjacent: tool errors │
│   open-state → agent    │ caught + fed back; provider fallback chain │
│                         │ + context-window guard ARE the resilience. │
└────────────────────────┴───────────────────────────────────────────┘
```

Read that right column carefully before you go into any file expecting production code. **All three core patterns are not-yet-exercised in AptKit.** What AptKit has are *adjacent* controls — and each file is honest about exactly where the pattern ends and the adjacent control begins.

---

## Elaborate — why teach patterns the codebase doesn't have?

Because the gap is the lesson. AptKit is a single-agent, read-only, bounded-budget system. That shape is *precisely* what makes these three patterns either unnecessary (no fan-out → no backpressure) or safe-but-skipped (read-only tools → caching would be safe, but isn't done). Knowing why a control is absent is worth as much in an interview as knowing how to build it. Each file teaches the full pattern, then marks the real boundary.

Two facts to carry into all three files:

- **Read-only tools change the risk math.** AptKit's tools never mutate state. That makes a cross-run cache *safer* than in a typical app (no risk of caching a side effect) — and makes a dead tool merely wasteful, not dangerous.
- **`maxToolCalls` (6 for monitoring/diagnostic/query, 4 for recommendation, 3 for rubric) is the only spend ceiling.** It is a crude global budget, not concurrency control and not a breaker. When a file says "bounded only by maxToolCalls," this is the bound.

---

## Interview defense

**Q: "Your agent has no cache, no concurrency cap, no circuit breaker. Isn't that unproductionized?"**

```
The answer is shape, not laziness
┌──────────────────────────────────────────────────────┐
│ single-agent  → no fan-out  → backpressure is moot     │
│ read-only     → cache is SAFE but unbuilt (deferred)   │
│ bounded budget→ a dead tool wastes ≤ maxToolCalls, not │
│                 the process; errors fed back to model  │
└──────────────────────────────────────────────────────┘
```

Anchor: tool errors are caught and fed back as observations at `run-agent-loop.ts:163-186`; the run is hard-bounded by `maxToolCalls` (`diagnostic-agent.ts:74`). You can defend "we chose the cheapest correct controls for a single-agent read-only system, and the loop self-limits."

---

## Validate

- **L1 (recognize):** Name the three patterns and which axis (input / dispatch / result) each clamps. → "Primary diagram" above.
- **L2 (trace):** Follow one run through the loop and point at where each control *would* sit. → `run-agent-loop.ts:98-190`.
- **L3 (judge):** Explain why single-agent + read-only makes backpressure moot and caching safe-but-skipped. → "Elaborate" above.
- **L4 (extend):** Given a multi-agent research assistant, say which of the three becomes mandatory first. → `../06-orchestration-system-design-templates/`, SECTION F.

---

## See also

- `.aipe/study-ai-engineering/06-production-serving/` — single-call caching, cost, rate-limit, retry & circuit-breaker mechanics. **Read first.**
- `01-cross-turn-caching.md`, `02-fan-out-backpressure.md`, `03-per-tool-circuit-breaking.md` — the three files of this section.
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the loop these controls clamp.
- `../03-multi-agent-orchestration/04-parallel-fan-out.md` — where backpressure would first appear.
- `../04-agent-infrastructure/05-guardrails-and-control.md` — budgets and limits.
- `../agent-patterns-in-this-codebase.md` — the codebase-wide pattern index.
