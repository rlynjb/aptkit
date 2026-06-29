# 02 — Partial Failure, Timeouts, and Retries

**Industry names:** deadlines · timeouts · retry with backoff and jitter · failure classification (retryable vs terminal) · circuit breaking — *Industry standard.*

## Zoom out, then zoom in

This is the most consequential file in the guide, because it names the biggest gap
in the repo. The Ollama boundary is where partial failure is real, and the code
that crosses it has cancellation but **no deadline.**

```
  Zoom out — where timeouts/retries belong vs where they live today

  ┌─ App layer ─────────────────────────────────────────────────────────┐
  │  runAgentLoop  — has a TURN budget (maxTurns) and a TOOL budget       │
  │                  (maxToolCalls) ✓  but no per-call wall-clock deadline│
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │ provider.complete()
  ┌─ Provider layer ─────────────▼───────────────────────────────────────┐
  │  FallbackModelProvider — retries ACROSS providers ✓                   │
  │  ★ THE GAP: no timeout wraps the call, so a hang never becomes        │
  │    a failure the fallback can react to ★                              │ ← we are here
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │ fetch() — AbortSignal only, no .timeout()
  ┌─ External ───────────────────▼───────────────────────────────────────┐
  │  Ollama daemon — can return 500 (→ throws ✓) OR hang (→ nothing ✗)    │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: a **timeout** turns the most dangerous failure mode — "infinitely slow" —
into the one your code already handles — "threw an error." Without it, *slow is
indistinguishable from working*, and every downstream protection (fallback,
turn budget, the user's patience) waits forever on a box that's never coming back.

## Structure pass

**Layers.** Turn budget (loop) → cross-provider retry (fallback) → per-call
guard (adapter) → the wire (fetch).

**Axis — trace `what gives up, and when?` down the layers.**

```
  Axis — "what gives up, and on what signal?" — top to bottom

  ┌─ runAgentLoop ─────────────────────────────┐
  │  gives up after maxTurns iterations         │  signal: turn COUNT  ✓
  └────────────────────┬────────────────────────┘
       ┌───────────────▼─────────────────────────┐
       │ FallbackModelProvider                    │  signal: a provider THREW ✓
       └───────────────┬─────────────────────────┘   (but only if it throws!)
            ┌──────────▼──────────────────────────┐
            │ GemmaModelProvider / fetch           │  signal: HTTP non-200 ✓
            │                                      │  signal: WALL-CLOCK   ✗ MISSING
            └──────────────────────────────────────┘
```

**Seam — the load-bearing gap.** Two layers give up on a *count* (turns) or an
*event* (a thrown error). Nobody gives up on the *clock*. The seam where a deadline
should live — wrapping `fetch` in the adapter — is empty. That's the finding.

## How it works

### Move 1 — the mental model: a deadline is a budget you spend, not a property of the call

You already know this shape from the frontend: a `fetch()` with a loading state
that you cancel if the user navigates away. A deadline is the same idea, but the
trigger is the *clock* instead of the *user*. You start a timer; if the response
doesn't arrive before the timer fires, you abort and treat it as a failure.

```
  The deadline kernel — a race between the response and a timer

      start ─────────────────────────────────────────────► deadline (e.g. 30s)
        │                                                       │
        ├─ fetch() in flight ──────────────► response ✓         │  (wins: use it)
        │                                                       │
        └─ fetch() in flight ─────────────────────────────────►✗  (timer wins:
                                                                    abort, throw,
                                                                    classify as failure)
        whichever finishes first wins; the timer guarantees one of them always does
```

That guarantee — *one of them always finishes* — is the whole point. Without the
timer, the top branch (response) is the *only* way the race ends, and if the daemon
hangs, it never does.

### Move 2 — walking the mechanism

**The retry budget that DOES exist: maxTurns.** The agent loop will not run
forever. It caps iterations and forces a final synthesis turn on the last one:

```ts
// packages/runtime/src/run-agent-loop.ts:98-109
for (let turn = 0; turn < maxTurns; turn += 1) {       // ← hard iteration budget
  signal?.throwIfAborted();                            // ← cooperative cancellation point
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;  // ← last turn: no more tools
  const response = await model.complete({
    system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
    messages,
    tools: forceFinal ? undefined : toolSchemas,
    maxTokens,
    signal,                                            // ← cancellation flows down
  });
```

This is a *count-based* budget — it stops the loop from spinning forever on a model
that keeps asking for tools. But it does **not** bound how long any single
`model.complete()` takes. One hung call inside one turn hangs the whole loop. The
budget protects against a fast-but-endless conversation, not a single slow call.

**Cross-provider retry: the fallback chain.** This is real, working retry logic —
across *providers*, not across *attempts to the same provider*:

```ts
// packages/providers/fallback/src/fallback-provider.ts:64-88
} catch (error) {
  if (isAbortError(error) || request.signal?.aborted) throw error;  // ← don't retry a cancel
  const attempt = { providerId: provider.id, model: provider.defaultModel,
                    error: error instanceof Error ? error.message : String(error) };
  attempts.push(attempt);                              // ← record WHY each one failed
  if (!this.shouldFallback(error, provider)) {
    throw error;                                       // ← failure CLASSIFICATION hook
  }
  if (index < this.providers.length - 1) {
    this.trace?.emit({ type: 'warning', ... });        // ← observable: a fallback happened
  }
}
// ...all providers exhausted:
throw new ProviderFallbackError(attempts);             // ← terminal: carries every attempt
```

Three things here are textbook-correct. **(1)** Abort errors are re-thrown, not
retried — you never retry a cancellation, because the caller asked you to stop.
**(2)** `shouldFallback` is a *failure-classification* hook: it lets the caller say
"a 400 is my bug, don't try the next provider; a 503 is theirs, do." **(3)**
`ProviderFallbackError` carries *every* attempt's reason, so the failure is
debuggable. This is the repo's one genuine failure-handling-across-services pattern,
and it's well-built.

**The gap, stated precisely.** The fallback loop only advances *on a thrown error*.
A provider that hangs never throws. So:

```
  Layers-and-hops — how a hang defeats the fallback chain

  ┌─ FallbackModelProvider ─┐  hop 1: try provider A     ┌─ GemmaProvider A ─┐
  │  for each provider:     │ ─────────────────────────► │  fetch(:11434)    │
  │    try complete()       │                            │   ...hangs...     │ ← Ollama wedged
  │    catch → next         │  hop 2: error? NEVER ARRIVES│                   │
  │                         │ ◄ - - - - - - - - - - - - - │  (no timeout to   │
  │  ★ loop is BLOCKED on   │                            │   force a throw)  │
  │    hop 1 forever ★      │                            └───────────────────┘
  └─────────────────────────┘
       provider B (the cloud fallback) is never tried — the chain can't reach it
```

If provider A is `GemmaModelProvider` against a wedged Ollama, and provider B is a
cloud Anthropic provider, the *entire point* of the fallback — survive the local
daemon being down — is defeated by the daemon being *slow* instead of *down*. Down
throws (`ECONNREFUSED` → caught → B tried). Slow hangs (→ never caught → B never
tried). A timeout collapses both into "down."

### Move 2.5 — current state vs the fix

```
  Phase A: today                          Phase B: with a per-call deadline
  ──────────────────────────              ──────────────────────────────────
  fetch(url, { signal })                  const ac = new AbortController()
    signal = caller's cancel only         const t = setTimeout(() => ac.abort(), 30_000)
                                          fetch(url, { signal: anySignal(signal, ac.signal) })
  hang → blocks forever                     .finally(() => clearTimeout(t))
  down  → throws (caught)
                                          hang → ac fires at 30s → throws (caught) ✓
  fallback works for DOWN only            down → throws (caught) ✓
                                          fallback works for BOTH ✓
```

What *doesn't* change: the fallback loop, the turn budget, the trace, the
`shouldFallback` classifier — all of them already react correctly to a thrown
error. The fix is one `AbortController` + `setTimeout` per transport call
(`gemma-provider.ts:201-215`, `ollama-embedding-provider.ts:60-75`), feeding the
existing `signal` plumbing. The architecture is ready; the deadline is the missing
piece. (Note: `AbortSignal.timeout(ms)` does exactly this in one call on modern
Node.)

### Move 3 — the principle

In a distributed system, *the absence of a response is not the absence of work* —
the far side might be grinding away, or dead, and you cannot tell. A timeout is how
you make a decision under that uncertainty: "I've waited my budget; I'll treat this
as failed and act." Retries only help *after* you've decided something failed, and
you can only decide that if a timeout (or an error) gave you the signal. Timeout
first, then classify, then retry — in that order, every time.

## Primary diagram

The complete picture: the three budgets that exist, the one that's missing, and
where retry happens.

```
  Partial-failure handling in aptkit — what bounds what

  ┌─ runAgentLoop ─────────────────────────────────────────────────────┐
  │  BUDGET 1: maxTurns ........... bounds # of model round-trips    ✓   │
  │  BUDGET 2: maxToolCalls ....... bounds # of tool executions     ✓   │
  │  cancellation: signal.throwIfAborted() at each turn             ✓   │
  └───────────────────────────────┬─────────────────────────────────────┘
                                  │ complete()
  ┌─ FallbackModelProvider ───────▼─────────────────────────────────────┐
  │  RETRY: try providers in order; record each FallbackAttempt     ✓   │
  │  CLASSIFY: shouldFallback(error) — retryable vs terminal        ✓   │
  │  CANCEL-SAFE: re-throw AbortError, never retry it               ✓   │
  └───────────────────────────────┬─────────────────────────────────────┘
                                  │ complete() → fetch()
  ┌─ GemmaModelProvider / fetch ──▼─────────────────────────────────────┐
  │  DEADLINE: per-call wall-clock timeout ............ ✗ MISSING        │
  │  → a hang here blocks every budget above it, defeats the fallback   │
  └─────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The "retryable vs terminal" distinction the `shouldFallback` hook exposes is the
single most underrated idea in failure handling. Most retry bugs are *retrying the
wrong thing* — hammering a server with a request it will reject every time (a 400),
or retrying a non-idempotent write and double-applying it. The classifier is where
you encode "this error means try again" vs "this error means stop." aptkit gives you
the hook but defaults to `() => true` (retry everything), which is the right default
for *read-only* model calls but would be dangerous if `complete()` had side effects.

Backoff and jitter — waiting longer between retries, with randomness so a fleet of
clients doesn't retry in lockstep and create a thundering herd — are `not yet
exercised`: the fallback chain tries the next provider *immediately*, with no delay.
That's correct here because it's trying a *different* provider, not re-hitting the
same one. Backoff matters when you retry the *same* endpoint; it would attach if you
added per-provider retry-the-same-one logic.

## Interview defense

**Q: "Walk me through how this handles the model provider being down."**
"Down and slow are different failures and the code handles them differently —
that's the interesting part. If Ollama is *down*, the `fetch` throws
`ECONNREFUSED`, the `FallbackModelProvider` catches it, records a `FallbackAttempt`
with the reason, and tries the next provider. That path is solid. If Ollama is
*slow* — daemon wedged, model still loading — the `fetch` has no timeout
(`gemma-provider.ts:201`), so it hangs, never throws, and the fallback loop is stuck
on it forever. The fix is a per-call deadline via `AbortController` + `setTimeout`,
which turns 'slow' into 'threw' so the existing fallback logic can react. The
architecture's ready; it's a one-function change in the transport."

```
  sketch while answering

  DOWN:  fetch → ECONNREFUSED → catch → try next provider   ✓ works today
  SLOW:  fetch → (hang) → never caught → stuck               ✗ needs a deadline
                          └─ add: AbortSignal.timeout(30_000) → turns into DOWN
```

**Q: "When do you NOT retry?"** — The load-bearing answer people forget:
"Three cases. (1) The caller cancelled — `isAbortError` is re-thrown, never retried.
(2) The error is *terminal* — a 400/422 means the request is wrong; retrying just
burns quota. That's what `shouldFallback` classifies. (3) The operation isn't
idempotent and the first attempt might have partially applied — retrying could
double-apply. aptkit's model calls are read-only so that last one doesn't bite, but
it's why you classify before you retry."

*Anchor:* `maxTurns` bounds the loop, `shouldFallback` classifies, and the missing
per-call timeout is the one gap that defeats the fallback.

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — why retry-safety needs idempotency
- `09-distributed-systems-red-flags-audit.md` — the timeout gap is finding #1
- **study-networking** — socket-level timeouts vs application deadlines
- **study-runtime-systems** — `AbortSignal`, cooperative cancellation, the event loop
```
