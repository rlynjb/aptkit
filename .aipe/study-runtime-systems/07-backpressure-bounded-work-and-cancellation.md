# Backpressure, Bounded Work, and Cancellation — the limits that keep a run finite

**Industry name(s):** bounded work / iteration budgets · cooperative cancellation (`AbortSignal`) · backpressure · graceful shutdown · **Type:** Industry standard

## Zoom out, then zoom in

This is the file where aptkit's runtime story is strongest *and* weakest. Strongest: the agent loop is rigorously bounded and cleanly cancellable — `maxTurns`, `maxToolCalls`, a forced final turn, and `signal.throwIfAborted()` threaded all the way down. Weakest: there is no backpressure, no concurrency limiter, and no graceful-shutdown handler — the bounds are on *one run's iteration count*, not on *system throughput*.

```
  Zoom out — where bounds and cancellation live

  ┌─ Caller ──────────────────────────────────────────────────────────┐
  │   passes maxTurns, maxToolCalls, signal (AbortSignal)              │
  └──────────────────────────────────┬─────────────────────────────────┘
  ┌─ Runtime: runAgentLoop ───────────▼─────────────────────────────────┐
  │   ★ for turn < maxTurns ★   ★ budgetSpent check ★   ★ forceFinal ★ │ ← we are here
  │   ★ signal?.throwIfAborted() every turn ★                          │
  └──────────────────────────────────┬─────────────────────────────────┘
  ┌─ Provider / tools ────────────────▼─────────────────────────────────┐
  │   signal forwarded to fetch · gemma retry loop · structured retry    │
  └──────────────────────────────────────────────────────────────────────┘

  MISSING (not yet exercised): producer-side backpressure, p-limit
  concurrency caps, rate limiting, SIGTERM/SIGINT graceful shutdown
```

**Zoom in.** "Bounded work" means: no matter what the model does, the run terminates in a known number of steps. "Cancellation" means: a caller can stop a run in flight and have it actually stop, releasing its work. "Backpressure" means: when work arrives faster than it can be processed, the system slows the producer instead of piling up unbounded. aptkit nails the first two and doesn't attempt the third — and the honest version of this file is saying exactly which is which.

## Structure pass

Trace the **control** axis on termination — what *forces* a run to end?

```
  Axis: "what makes this run stop?" — the termination conditions

  ┌──────────────────────────────────────────────────────────┐
  │ model returns text with no tool calls                      │  → natural finish
  │   (run-agent-loop.ts:132 — toolUses.length === 0)          │     (the common case)
  └───────────────────┬────────────────────────────────────────┘
      ┌───────────────▼────────────────────────────────────────┐
      │ turn === maxTurns - 1  OR  budgetSpent                   │  → forced final turn:
      │   (run-agent-loop.ts:101-102)                            │     tools stripped, must answer
      └───────────────┬────────────────────────────────────────┘
          ┌───────────▼────────────────────────────────────────┐
          │ signal.throwIfAborted() (run-agent-loop.ts:99)       │  → caller cancelled:
          │                                                      │     throws, unwinds the loop
          └────────────────────────────────────────────────────┘
```

The load-bearing seam: **the boundary between "the model decides to stop" and "the loop forces it to stop."** A naive agent loop trusts the model to eventually answer — and a model that keeps requesting tools forever runs forever. aptkit's loop removes that trust: at `maxTurns - 1` (or when the tool budget is spent), it strips the tools and demands an answer. That's the single most important bounded-work mechanism in the repo, and it's the part people forget when they build an agent loop from scratch.

## How it works

### Move 1 — the mental model

You know a `for` loop with a hard counter can't run forever, and you know an `AbortController` lets you cancel a `fetch`. aptkit's loop is exactly those two primitives, composed: a counter-bounded loop where every iteration first checks an abort signal. The twist is the *forced final turn* — the loop doesn't just stop at the limit, it changes the model's options on the last turn so the run produces a usable answer instead of a dangling tool request.

```
  The bounded agent loop — the kernel

  for turn in 0 .. maxTurns-1:
      if signal aborted: THROW                  ← cancellation: bail now
      forceFinal = (turn == last) OR (tool budget spent)
      response = await model.complete(
          tools = forceFinal ? NONE : toolSchemas  ← strip tools on final turn
      )
      if response has no tool calls: finalText = text; BREAK   ← natural finish
      run the tool calls, append results, loop

  guarantees: terminates in ≤ maxTurns iterations,
              always with finalText (the forced turn ensures it)
```

The strategy: **make the loop's termination independent of the model's cooperation** — a hard turn cap plus a forced answer-only final turn means the run ends and produces output no matter how the model behaves.

### Move 2 — the bounds, the cancellation, and the gaps

**The hard turn cap.** `run-agent-loop.ts:98` with the default at `:87`:

```ts
const { maxTurns = 8, /* ... */ } = options;
for (let turn = 0; turn < maxTurns; turn += 1) {
  // ...
}
```

Eight turns, default. The loop variable is the bound — nothing the model returns can extend it. The recommendation agent overrides this to 6 (per the package's loop config). This is the floor of bounded work: a finite, caller-controlled iteration budget.

**The tool-call budget.** `run-agent-loop.ts:101`:

```ts
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;
```

A second, finer bound: even within the turn limit, once the run has made `maxToolCalls` total tool calls, the next turn is forced final. This caps *work* (tool executions, each potentially an HTTP call or a scan) independently of turn count — a single turn could request many tools, so bounding turns alone wouldn't bound tool work.

**The forced final synthesis turn — the load-bearing mechanic.** `run-agent-loop.ts:103-109`:

```ts
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,   // ← tools stripped when forced
  maxTokens,
  signal,
});
```

When `forceFinal` is true, two things change: the tool schemas are withheld (`tools: undefined`), so the model *can't* request a tool — it has to produce text — and a synthesis instruction is appended to the system prompt (`buildSynthesisInstruction`, `:72`: "You have NO more tool calls available. … Do not say you need more queries."). This is what turns "the loop hit its limit" into "the loop produced an answer." Without it, a run that exhausted its budget mid-investigation would return whatever half-formed text was last emitted, or empty. Name this in an interview — it's the part of a bounded agent loop people routinely forget to build.

```
  Forced final turn — the difference it makes

  WITHOUT forced final:           WITH forced final (aptkit):
  turn maxTurns-1: model says       turn maxTurns-1: tools stripped +
   "let me search again" (tool)      synthesis instruction →
  loop ends → finalText = ""         model MUST answer with text
  → useless empty result             → usable grounded answer
```

**Cooperative cancellation via `AbortSignal`.** Threaded top to bottom. At the loop top, `run-agent-loop.ts:99`:

```ts
for (let turn = 0; turn < maxTurns; turn += 1) {
  signal?.throwIfAborted();        // ← checked before every model call
```

The signal is forwarded into `model.complete({ ..., signal })` (`:108`) and into `tools.callTool(..., { signal })` (`:159`). So an abort interrupts the run at the next checkpoint: either between turns (the explicit `throwIfAborted`) or inside an in-flight `fetch` (the signal aborts the HTTP request itself, since it's passed to `fetch` at `gemma-provider.ts:204`). Providers respect it too — the fallback chain re-throws abort errors immediately rather than treating them as a provider failure to retry (`fallback-provider.ts:65`), and structured generation does the same (`structured-generation.ts:76`). This is *cooperative* cancellation: nothing is forcibly killed; the code checks the signal at known points and unwinds cleanly when it's set.

```
  Cancellation — cooperative, checked at known points

  caller: controller.abort()
            │ sets signal.aborted = true
            ▼
  loop top: signal.throwIfAborted() ──► THROWS between turns
  in-flight fetch: signal passed to fetch ──► HTTP request aborts mid-flight
  providers: isAbortError(e) ──► re-throw immediately, don't retry/fallback

  result: the run stops at the next checkpoint, no orphaned retries
```

**The retry loops are themselves bounded.** Gemma's tool-call retry (`gemma-provider.ts:62`, `maxToolCallAttempts` default 2) and `generateStructured`'s validation retry (`structured-generation.ts:62`, `maxAttempts` default 2) are both hard-capped `for` loops. So even the error-recovery paths can't spin — a model that keeps emitting malformed JSON gets retried a fixed number of times, then the run gives up with a recorded error. Bounded work all the way down.

**What's NOT here — and when it'd matter.** Three real concerns the repo doesn't exercise:

- **Producer-side backpressure / concurrency limiting.** There's no queue, no `p-limit`, no semaphore. If a caller fired 1,000 `runAgentLoop` calls at once, all 1,000 would be in flight simultaneously, all hitting Ollama/the cloud at once — nothing throttles them. The bounds are *per-run* (turns, tool calls), not *system-wide* (concurrent runs). This is `not yet exercised`: it becomes relevant the moment aptkit is embedded in a server taking concurrent requests (buffr's job). The fix is a concurrency limiter at the call site, not inside the loop.
- **Rate limiting / deadlines.** No wall-clock timeout on a run (only the turn count bounds it), and no rate limiter on outbound model calls. A run with slow tools could take arbitrarily long in wall-clock time even within 8 turns. `not yet exercised` — a deadline would be an `AbortSignal.timeout(ms)` passed in, which the existing cancellation plumbing already supports for free. That's the nice part: the cancellation machinery is *already* deadline-ready; nobody's wired a timeout to it yet.
- **Graceful shutdown.** No `process.on('SIGTERM')` / `process.on('SIGINT')` anywhere. A `kill` mid-run drops the run with no drain, no flush of in-flight traces, no cleanup. `not yet exercised` and arguably correct for a library — graceful shutdown is the *host process's* responsibility (buffr), and the host has the `AbortSignal` plumbing to drive it: on SIGTERM, abort the in-flight runs' signals and let the cooperative cancellation unwind them.

### Move 3 — the principle

Bounded work and cancellation are two halves of the same discipline: a long-running operation must terminate by *limit* even if it never terminates by *success*, and a caller must be able to revoke it in flight. aptkit gets both right at the unit of one run — the hard turn cap and tool budget guarantee termination, the forced final turn guarantees a usable result at the limit, and `AbortSignal` threaded to every `await` makes cancellation actually stop the work. What it doesn't do is bound the *system*: there's no backpressure, because aptkit is a library and throughput control belongs to whatever embeds it. The clean separation is the lesson — bound the algorithm inside the library, bound the throughput at the deployment, and use the same `AbortSignal` primitive to bridge them (a server's shutdown or per-request deadline becomes an abort the library already knows how to honor).

## Primary diagram

The complete bounding-and-cancellation picture: per-run bounds and cancellation present, system-wide controls absent.

```
  aptkit bounded work + cancellation — complete

  ┌─ PER-RUN BOUNDS (present, rigorous) ─────────────────────────────────┐
  │  for turn < maxTurns (default 8)        ← hard iteration cap          │
  │  budgetSpent: toolCalls >= maxToolCalls ← hard work cap               │
  │  forceFinal → tools stripped + synthesis instruction                 │
  │             → guarantees a usable answer at the limit ★              │
  │  retry loops (gemma 2x, structured 2x)  ← bounded recovery           │
  └────────────────────────────────────────────────────────────────────────┘
  ┌─ CANCELLATION (present, cooperative) ─────────────────────────────────┐
  │  signal.throwIfAborted() every turn → bail between turns              │
  │  signal → fetch → aborts in-flight HTTP                               │
  │  providers re-throw abort errors (no retry/fallback on cancel)        │
  │  ALREADY deadline-ready: AbortSignal.timeout would just drop in       │
  └────────────────────────────────────────────────────────────────────────┘
  ┌─ NOT YET EXERCISED (system-wide controls) ────────────────────────────┐
  │  ✗ backpressure / p-limit / semaphore  → host's job (buffr)           │
  │  ✗ rate limiting / wall-clock deadline → wire to existing AbortSignal │
  │  ✗ SIGTERM/SIGINT graceful shutdown    → host aborts run signals      │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The forced-final-turn pattern is specific to agent loops and is the thing that separates a toy loop from a production one: an LLM, left to its own devices, will sometimes never decide it's done, so the loop must impose termination *and* coerce a final answer rather than just halting. `AbortSignal` is the web/Node standard for cooperative cancellation — the same primitive `fetch`, `setTimeout`'s `AbortSignal.timeout`, and event listeners all accept — which is why aptkit threading it everywhere means deadlines and shutdown are "wire it up," not "build it." The missing pieces — backpressure, rate limiting, concurrency caps — are deliberately out of scope for a library: they're throughput concerns that depend on the deployment (how many cores, what rate limits the cloud provider imposes, how many concurrent users), and baking them into the loop would couple the library to a deployment it's designed not to assume. See `study-distributed-systems` for backpressure and queueing across processes, `study-performance-engineering` for throughput measurement, and `02` for why no concurrency limiter is needed inside a single-threaded loop (the limit there is the event loop itself).

## Interview defense

**Q: What stops `runAgentLoop` from running forever?**

```
  three independent bounds:
    1. for turn < maxTurns (default 8)     ← hard iteration cap
    2. budgetSpent: toolCalls >= maxToolCalls ← hard work cap
    3. forceFinal on the last turn: tools STRIPPED + synthesis prompt
       → model can't request another tool, MUST answer ★
  → terminates in ≤ maxTurns AND always produces finalText
```

Anchor: "The hard turn cap guarantees termination; the forced final turn — strip the tools, demand an answer — guarantees the run ends with a usable result, not a dangling tool request. That's the mechanic people forget when they build an agent loop."

**Q: How does cancellation work, and could you add a per-run deadline?**

```
  AbortSignal threaded to every await:
    loop top: signal.throwIfAborted()  ← bail between turns
    fetch + tools get the signal       ← abort in-flight I/O
    providers re-throw abort (no retry on cancel)
  deadline: pass AbortSignal.timeout(ms) as the signal —
            the cancellation plumbing already honors it, zero new code
```

Anchor: "Cancellation is cooperative `AbortSignal` checked at every await — and because it's already plumbed everywhere, a deadline is just `AbortSignal.timeout` passed in; nobody's wired it yet but the machinery's there."

**Q: Is there backpressure?**

```
  no — and that's deliberate. bounds are per-run (turns, tool calls),
  not system-wide (concurrent runs). no queue, no p-limit, no rate limit.
  throughput control belongs to the host (buffr), bridged via the same
  AbortSignal (SIGTERM → abort in-flight signals → cooperative unwind)
```

Anchor: "No backpressure inside the library — that's a deployment concern; the library bounds the algorithm, the host bounds the throughput, and `AbortSignal` bridges them."

## See also

- `02-processes-threads-and-tasks.md` — why no concurrency limiter is needed inside the single-threaded loop
- `03-event-loop-and-async-io.md` — the await points where `throwIfAborted` interrupts the run
- `study-distributed-systems` — backpressure and queueing once work crosses process boundaries (buffr)
- `study-performance-engineering` — throughput and latency measurement
