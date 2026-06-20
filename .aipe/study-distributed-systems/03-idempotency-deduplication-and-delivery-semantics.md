# 03 — Idempotency, deduplication, delivery semantics

**Industry name(s):** idempotency keys / deduplication / at-most-once /
at-least-once / effective exactly-once. **Type:** Industry standard.

## Zoom out, then zoom in

This concept lives at the same seam as `02` — but where `02` asked "what do we
do when the call fails?", this one asks the harder follow-up: **"is it safe to
do that thing again?"** Retries and delivery semantics are two sides of one
coin; you can't retry safely without knowing whether the operation is
idempotent.

```
  Zoom out — where "is it safe to retry?" gets answered

  ┌─ Service layer ──────────────────────────────────────────────┐
  │  runAgentLoop ── re-prompt on parse failure (the one retry)    │ ← we are here
  │  usage-ledger ── counts work across calls (dedup-ish)          │
  └─────────────────────────────┬────────────────────────────────┘
                               │ complete()  (each call = a "delivery")
  ┌─ Provider boundary ─────────▼────────────────────────────────┐
  │  Fallback chain — a retry across providers                    │
  └─────────────────────────────┬────────────────────────────────┘
                               │ HTTPS
  ┌─ External provider ─────────▼────────────────────────────────┐
  │  no idempotency key sent → each call is at-most-once          │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: **delivery semantics** name the three guarantees a message system can
offer. At-most-once: the message is delivered zero or one times (you might lose
it, never duplicate it). At-least-once: delivered one or more times (never lost,
might duplicate). Exactly-once: the holy grail — delivered precisely once. The
brutal truth is that true exactly-once *delivery* is impossible across a
network; what real systems achieve is **effective exactly-once** = at-least-once
delivery + idempotent processing. AptKit's calls are at-most-once and *not*
idempotent at the provider, which is exactly why its retry story is limited.

## Structure pass — layers, axis, seam

Trace the **guarantees axis** — "how many times can this run, and is that safe?"
— across three layers:

```
  "how many times, and is repeating it safe?" — down the layers

  ┌────────────────────────────────────────────┐
  │ provider call (complete())                  │ → AT-MOST-ONCE. NOT idempotent:
  │                                             │   re-running costs money + may
  │                                             │   give a different answer (LLMs
  │                                             │   are non-deterministic)
  └────────────────────┬───────────────────────┘
      ┌────────────────▼─────────────────────────┐
      │ parse-failure re-prompt (recovery turn)    │ → runs 0 or 1 extra time;
      │                                            │   safe because it's read-only
      │                                            │   (produces text, mutates nothing)
      └────────────────┬───────────────────────────┘
          ┌────────────▼─────────────────────────┐
          │ replay (FixtureModelProvider)         │ → fully idempotent + deterministic:
          │                                       │   same recorded log → same output,
          │                                       │   every time, free
          └───────────────────────────────────────┘
```

The seam that matters: **the provider call is the only non-idempotent,
non-deterministic, costs-money operation in the system.** Everything above it in
the process is pure functions over in-memory state — safe to repeat. That's why
the only "retry" AptKit dares is the read-only re-prompt, and why replay (which
replaces the provider with a deterministic stub) is the testing backbone.

## How it works

### Move 1 — the mental model: the same request arriving twice

You already know idempotency from HTTP verbs: `GET` and `PUT` are idempotent
(call them 5 times, same result), `POST` usually isn't (5 `POST`s = 5 orders).
An idempotency key is how you make a `POST` safe to retry — the server
remembers the key and dedupes.

```
  Idempotency key — the dedup kernel (the textbook pattern)

  client                              server
    │  POST /charge {key: "abc"} ──────►  seen "abc" before?
    │  (request lost on the way back) │     ├─ no  → do work, store key→result
    │                                 │     └─ yes → return stored result (no re-do)
    │  retry POST {key: "abc"}   ──────►  seen "abc"? YES → return same result
    │  ◄─────────────────────────────┘     (charged ONCE despite two requests)
```

Three parts make idempotency work, each breaking something if removed:

- **A stable key** identifying "the same logical operation." Without it the
  server can't tell a retry from a new request — you get duplicates.
- **A store mapping key → result.** Without it the server forgets it already did
  the work — the second call re-does it.
- **A check-before-act.** Without it the store exists but nobody reads it — the
  work runs twice anyway.

### Move 2 — the walkthrough, mapped to AptKit

**Step 1 — the provider call is at-most-once, no key.** Bridge from a fire-and-
forget `POST` with no retry. AptKit sends a `complete()` and gets a response or
an error. It sends **no idempotency key.** So if the request reaches the provider,
the provider generates the response, and *then* your connection dies — you've
been charged, you got nothing, and you don't know whether to retry.

```
  At-most-once with no key — the ambiguous failure

  your process ── complete() ──► provider: generates response (charged!)
       │         ◄── connection dies ──┘
       │
       └─ did it run? you can't tell. retrying = pay twice + maybe different answer.
          this is why AptKit fails OVER (new node, fresh call) rather than retrying.
```

This is the load-bearing honesty: **AptKit can't safely retry the same provider
call** because (a) there's no idempotency key to dedupe and (b) LLM output is
non-deterministic, so even a "successful" retry gives a different answer. Failing
over to a *different* provider sidesteps both — you're not re-running the same
op, you're running a fresh one elsewhere.

**Step 2 — the safe retries: parse-failure re-prompts.** The repo has two
same-target retries, and both are safe for the *same* reason — they're
**read-only**, so re-running mutates nothing. (1) The agent loop's recovery turn:
when the model's final text doesn't parse into the expected JSON shape, it
re-prompts once for just the structured answer. (2) The Gemma provider's
tool-call nudge (`packages/providers/gemma/src/gemma-provider.ts:62-91`): when a
local model returns a malformed tool call, it re-asks the same model with a
corrective nudge, bounded by `maxToolCallAttempts`. Neither is a network retry
and neither needs an idempotency key — re-asking a model to *read* and answer is
inherently safe; the danger only appears when a retried call has a side effect.

```
  The re-prompt — safe retry because it mutates nothing

  loop ends → parseResult(finalText) → null?
                                        ├─ no  → done
                                        └─ yes → run ONE recovery turn:
                                                 "output ONLY the structured answer"
                                                 → parse again → final result or null
```

Why is this safe to repeat when the provider call isn't? Because the recovery
turn produces *text*, mutates no external state, and runs at most once. It's the
distributed-systems instinct applied in-process: a retry is only safe if the
operation is idempotent, and "generate some text" is idempotent in its *effects*
(it changes nothing) even though it's non-deterministic in its *output*.

**Step 3 — at-least-once vs at-most-once, the choice.** The general framing:

```
  Delivery semantics — the three guarantees

  AT-MOST-ONCE   send, don't retry      → may lose, never duplicate
                 ◄── AptKit's provider calls live here (no retry of same call)

  AT-LEAST-ONCE  retry until ack         → never lose, may duplicate
                 ◄── requires idempotent processing to be safe (NOT here)

  EXACTLY-ONCE   at-least-once delivery  → the goal; impossible as pure delivery,
                 + idempotent processing    achieved only as "effective"
```

AptKit chooses at-most-once at the provider deliberately: the work is expensive
and non-idempotent, so "try once, fail over if it errors, give up cleanly" beats
"retry and risk double-charging for a different answer." That's the correct
call for this workload — but it means **at-least-once and effective-exactly-once
are `not yet exercised`.**

**Step 4 — the usage ledger: accounting across calls (dedup-ish).** The closest
thing to "tracking work across nodes" is the ledger folding every `model_usage`
event into one summary. It's not deduplication — it's the opposite, *aggregation*
— but it's the same family: reconciling a stream of per-call records into one
authoritative total.

```
  Usage ledger — fold per-call events into one row

  trace = [ usage(in:100,out:50), usage(in:80,out:40), usage(in:200,out:90) ]
                            │ reduce, summing only type==='model_usage'
                            ▼
  summary = { inputTokens: 380, outputTokens: 180, totalTokens: 560, turns: 3 }
```

**Step 5 — replay: deterministic re-execution (the idempotency/recovery analog).**
The strongest idempotency story in the repo isn't at the provider — it's in
*testing*. Replay swaps the live provider for a `FixtureModelProvider` that
returns recorded `ModelResponse[]` in order. Same recorded log → same output,
every time, for free.

```
  Replay — recovery from a recorded log (idempotency analog)

  recorded responses: [ r0, r1, r2 ]   ◄── the "write-ahead log"
       │
  FixtureModelProvider.complete():
       ├─ call 1 → return r0
       ├─ call 2 → return r1
       └─ call 3 → return r2   (index past end → throw "exhausted")
       │
       └─ deterministic + idempotent: re-run the whole capability, get byte-identical
          output. this is the SHAPE of event-replay recovery, used for tests.
```

This is the same idea a database uses to recover from a write-ahead log:
re-apply a recorded sequence of operations to reach a known state. AptKit uses
it to make non-deterministic agents testable — but the mechanism is pure
distributed-systems recovery.

### Move 3 — the principle

**A retry is only safe if the operation is idempotent.** That single rule
explains every choice in this file: AptKit retries the read-only re-prompt (safe),
fails *over* rather than *back* on provider errors (avoids retrying a
non-idempotent call), and leans on replay for determinism (the one place it gets
true idempotency). If you remember one thing: never bolt at-least-once delivery
onto a non-idempotent operation — you'll just reliably do the wrong thing twice.

## Primary diagram

The full picture — where each delivery guarantee and retry lives.

```
  Idempotency & delivery across AptKit

  ┌─ Service layer (in-process, pure → safe to repeat) ───────────┐
  │                                                                │
  │  parseResult(finalText) → null?                                │
  │     └─ recovery turn (re-prompt) ── runs ≤1×, read-only, SAFE   │
  │                                                                │
  │  usage-ledger.summarizeUsage() ── folds N call-events → 1 row  │
  │                                                                │
  │  REPLAY: FixtureModelProvider ── recorded log → deterministic   │
  │          re-execution (idempotent, free)                       │
  └────────────────────────────┬───────────────────────────────────┘
                              │ complete()  ◄── the unsafe-to-retry op
  ┌─ Provider boundary ─────────▼────────────────────────────────┐
  │  AT-MOST-ONCE · NO idempotency key · NON-deterministic         │
  │  → fail OVER (fresh call, new node) not BACK (retry same call) │
  └───────────────────────────────────────────────────────────────┘

  not yet exercised: idempotency keys, at-least-once, effective-exactly-once,
                     dedup store, request-id-based deduplication.
```

## Implementation in codebase

**Use cases.** The re-prompt fires whenever an agent's final text fails to parse
into its expected shape (a recommendation list, a diagnosis object) — common
when a model trails off or wraps JSON in prose. The ledger runs at the end of
every capability to attach a usage/cost row to the replay artifact. Replay runs
in the eval pipeline and in Studio's "re-run this artifact" flow.

**The one safe retry — the re-prompt.**

```
  packages/runtime/src/run-agent-loop.ts  (lines 192-199)

  let parsed: T | null = null;
  if (options.parseResult) {
    parsed = options.parseResult(finalText);      ← first parse attempt
    if (parsed === null && options.recoveryPrompt) {  ← failed to parse?
      const recoveryText = await runRecoveryTurn(   ← ONE recovery turn (≤1 retry)
        options, options.recoveryPrompt(toolCalls));
      parsed = recoveryText === null ? null : options.parseResult(recoveryText);
    }
  }
       │
       └─ this is the ONLY retry in the loop, and it's safe ONLY because the
          recovery turn (lines 204-228) mutates nothing external — it just asks
          the model to restate the answer. A retry of a tool that wrote to disk
          would NOT be safe here.
```

**The recovery turn is read-only by construction.**

```
  packages/runtime/src/run-agent-loop.ts  (lines 204-228)

  async function runRecoveryTurn(options, userPrompt) {
    options.signal?.throwIfAborted();              ← cancellation still wins
    const response = await options.model.complete({
      system: 'You are concluding ... Output ONLY the structured answer ...',
      messages: [{ role: 'user', content: userPrompt }],  ← fresh, no tools given
      maxTokens: 2048, signal: options.signal,
    });
    return textFromContent(response.content);       ← returns TEXT only — no side effects
  }
       │
       └─ no tools passed → the model can't call anything that mutates state.
          that's what makes re-running it idempotent in effect.
```

**Accounting across calls — the ledger fold.**

```
  packages/runtime/src/usage-ledger.ts  (lines 25-42)

  export function summarizeUsage(trace) {
    return trace.reduce((summary, event) => {
      if (event.type !== 'model_usage') return summary;  ← only count call events
      const inputTokens = event.inputTokens ?? 0;
      ...
      return { inputTokens: summary.inputTokens + inputTokens, ...
               turns: summary.turns + 1, ... };           ← one row across all calls
    }, { inputTokens: 0, ..., turns: 0, estimated: false });
  }
       │
       └─ the closest analog to "track work across nodes" — except the "nodes"
          are sequential calls to one external API. it's aggregation, not dedup,
          but the same reconcile-a-stream-into-a-total shape.
```

**Deterministic replay — the recovery analog.**

```
  packages/agents/recommendation/src/fixture-provider.ts  (lines 11-17)

  async complete(request) {
    this.requests.push(request);              ← records what was asked (for assertions)
    const response = this.responses[this.index];  ← returns the NEXT recorded response
    this.index += 1;
    if (!response) throw new Error(`fixture model exhausted ...`);  ← past the log end
    return response;                          ← same log → same output, deterministically
  }
```

The replay driver that consumes these:
`packages/evals/src/replay-runner.ts:30-94` lists artifacts in deterministic
filename order and re-evaluates each — re-execution from a recorded log.

**`not yet exercised` here, with triggers:**

- **Idempotency keys / dedup store:** none. *Trigger: an external operation with
  side effects that must run exactly once (e.g. a tool that posts to a webhook).*
- **At-least-once delivery:** none. *Trigger: a durable queue between producer
  and consumer where messages must not be lost.*
- **Effective-exactly-once:** none. *Trigger: at-least-once delivery + a
  side-effecting consumer — then you'd add idempotency keys to the tool calls.*

## Elaborate

The "exactly-once is impossible, effective-exactly-once is achievable" result is
the load-bearing theorem of message systems — it comes from the Two Generals
Problem (you can never be *certain* a message was received across an unreliable
channel). Kafka's "exactly-once semantics" and Stripe's idempotency keys are
both the same trick: at-least-once delivery plus a dedup store keyed on a stable
id. AptKit doesn't need it because its one external op is non-idempotent *and*
non-essential to repeat — it just fails over. The replay machinery is closest in
spirit to event sourcing (covered as an analog in `08`), where state is
recovered by replaying a log rather than read from a snapshot.

## Interview defense

**Q: "Can you safely retry a model call? Why or why not?"**

"No — for two reasons. There's no idempotency key, so the provider can't dedupe a
retry, and LLM output is non-deterministic, so even a successful retry gives a
different answer. That's why we fail *over* to a different provider instead of
retrying the same one — a fresh call on a new node, not a re-run."

```
  retry SAME provider:  no key + non-deterministic → unsafe
  fail OVER:            fresh call, new node        → the safe move
  retry the re-prompt:  read-only, ≤1×              → safe (mutates nothing)
```

Anchor: "The one retry we *do* have is the parse-failure re-prompt at
`run-agent-loop.ts:192-199`, and it's safe only because the recovery turn passes
no tools — it can't mutate anything."

**Q: "How would you make agent runs effectively exactly-once if tools had side
effects?"**

"At-least-once delivery plus idempotency keys on the side-effecting tool calls,
backed by a dedup store. The key would be a stable hash of the tool name plus
args plus a run id. Right now that's `not yet exercised` — the tools are
read-only, so there's nothing to dedupe."

## Validate

1. **Reconstruct:** Name the three delivery semantics and which one AptKit's
   provider calls use.
2. **Explain:** Why is the recovery turn (`run-agent-loop.ts:204-228`) safe to
   run when a direct provider retry isn't? Point to the specific design choice.
3. **Apply:** Someone adds a tool that POSTs to a Slack webhook, then enables
   same-provider retry. What breaks, and what do you add to fix it?
4. **Defend:** Argue that at-most-once is the correct delivery choice for the
   provider boundary in *this* repo (`fallback-provider.ts` + the
   non-determinism argument).

## See also

- `02-partial-failure-timeouts-and-retries.md` — the retry mechanism whose
  safety this file governs.
- `08-sagas-outbox-and-cross-boundary-workflows.md` — replay as an
  event-sourcing analog, in depth.
- `study-runtime-systems` — the bounded loop and `AbortSignal`.
