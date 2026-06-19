# Error recovery (the agent failure-mode table)

**Industry names:** agent error handling, graceful degradation, recovery turn · *Industry standard*

## Zoom out, then zoom in

An agent run has many ways to fail, and they fail at different layers. A tool can
throw. The model can burn its whole budget and never conclude. The final answer
can come back as prose when you needed JSON. The provider can be down. Error
recovery is the set of moves that turn each of those from "the run crashed" into
"the run degraded but produced something usable" — and knowing *which* failure
each move catches (and which it doesn't) is the skill.

```
  Zoom out — where each failure is caught

  ┌─ Agent / Runtime (run-agent-loop.ts) ─────────────────────────┐
  │  ★ tool error → {error} observation                            │ ← we are here
  │  ★ budget spent → forced synthesis                             │
  │  ★ unparseable final → recovery turn                           │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ model.complete()
  ┌─ Provider layer ───────────────▼────────────────────────────────┐
  │  ★ provider failure → fallback chain (try next provider)        │
  │  ★ context too big → fail fast (guard throws before the call)    │
  └──────────────────────────────────────────────────────────────────┘

  ✗ NOT caught anywhere: per-tool timeout · repeated-tool-loop
```

Zoom in: every recovery move answers one question — *when X breaks, do we still
produce a usable result?* This file is the failure-mode table for AptKit: four
failures it handles (each at a named line), two it honestly does not. The handled
ones share a philosophy — turn the failure into something the *model* can react to,
or into a deterministic fallback the *code* controls. The unhandled ones are real
gaps worth naming (and they're the exercises).

## Structure pass

**Layers.** Two: the *loop/agent* layer (where tool, budget, and parse failures
are caught) and the *provider* layer (where transport and context failures are
caught). Recovery is split across both because the failures originate at both.

**Axis — failure: where does it originate, and where is it contained?** Trace it.
A tool error originates in the tool, contained in the loop (becomes an
observation). A budget overrun originates in the model's behavior, contained in the
loop (forced synthesis). A parse failure originates in the model's output,
contained just after the loop (recovery turn). A provider error originates at the
transport, contained at the provider seam (fallback). Each failure is contained at
the *nearest* layer that can do something about it — never allowed to bubble up
raw.

```
  One question — "where is this failure contained?"

  ┌─ tool ──────────┐ throws → caught IN THE LOOP → {error} observation
  ┌─ model behavior ┐ won't stop → caught IN THE LOOP → forced synthesis
  ┌─ model output ──┐ won't parse → caught AFTER LOOP → recovery turn
  ┌─ transport ─────┐ provider down → caught AT PROVIDER → fallback chain
  ┌─ context size ──┐ too big → caught BEFORE CALL → fail fast (guard)
```

**Seams.** Three recovery seams. (1) The try/catch around `callTool` — converts a
thrown tool into a model-readable observation. (2) The `forceFinal` boolean —
converts budget exhaustion into a compelled answer. (3) The `parseResult` → `null`
→ `recoveryPrompt` branch — converts unparseable output into one more strict
attempt. The fourth, the fallback chain, lives at the provider seam. Each seam is
the joint where a failure stops propagating and starts being handled.

## How it works

You already know a try/catch that returns a default value instead of crashing.
Agent error recovery is that idea applied at four different layers — but with one
twist unique to LLMs: sometimes the best "default" isn't a value, it's *feeding the
error back to the model so it can recover itself*. The model is a participant in
recovery, not just a thing that fails.

### Move 1 — the mental model

```
  The failure-mode table — failure → recovery → result

  failure                  recovery move            result
  ─────────────────────    ─────────────────────    ──────────────────
  tool throws          →   wrap as {error} obs   →   model retries differently
  budget exhausted     →   forceFinal (tools off)→   compelled final answer
  output won't parse   →   recovery turn (strict)→   salvaged structured answer
  provider down        →   fallback chain        →   next provider answers
  context too big      →   guard throws first    →   fail fast, try fallback
  ─────────────────────    ─────────────────────    ──────────────────
  tool hangs           →   ✗ none (no per-tool timeout)
  same tool on loop    →   ✗ none (no loop detection)
```

The pattern across the handled rows: never let a failure escape as an unhandled
exception. Either the model gets a chance to react (tool error, parse failure), or
the code forces a clean outcome (budget, fallback, fail-fast).

### Move 2 — each handled failure, one at a time

**Tool error → observation.** Bridge from a try/catch that logs and continues — when
a tool throws, the loop catches it, sets `isError: true`, and feeds
`{ error: message }` back as the tool result. The model *reads* that error on its
next turn and can pick a different tool or different arguments. Boundary condition:
the error is just data to the model — it might ignore it and retry the same broken
call (see the loop gap below).

```
  Pattern — tool error becomes a model observation

  callTool(name, input)
        │ throws
        ▼
  catch → resultContent = { error: message }, isError: true
        │ appended as tool_result
        ▼
  model's next turn READS the error ──► tries a different approach
  (a crash would end the run; an observation keeps it alive)
```

**Budget exhausted → forced synthesis.** Bridge from a loop with a max-iterations
guard — when `maxToolCalls` is hit (or it's the last turn), `forceFinal` flips: the
next `model.complete` is called with `tools: undefined` and a synthesis instruction
appended. The model *can't* request another tool because none are offered, so it
must answer. Boundary condition: if you only appended the instruction but left the
tools available, the model would often ignore the words and call a tool anyway —
removing the tools is what makes the answer structurally mandatory. (Full anatomy
in `03-react-pattern.md`.)

```
  Pattern — budget exhaustion forces an answer

  toolCalls.length >= maxToolCalls  → budgetSpent = true
        │
  forceFinal = lastTurn OR budgetSpent
        │ true
        ▼
  complete({ system + synthesisInstruction, tools: undefined })
        │ no tools offered → model CANNOT request one
        ▼
  model produces its final answer (compelled, not optional)
```

**Output won't parse → recovery turn.** Bridge from a retry with stricter input —
after the loop, if the agent needs structured output it runs `parseResult` on
`finalText`. If that returns `null` and a `recoveryPrompt` exists, the loop fires
*one* more call: a clean-slate turn with a hardcoded strict system prompt ("Output
ONLY the structured answer; never ask for more data") and the gathered evidence
repackaged into the prompt. Boundary condition: it's a single extra call, only on
parse failure — if *that* won't parse either, the agent returns `null`/`[]` and the
caller handles the empty case. Cheap insurance, not infinite retries.

```
  Layers-and-hops — the recovery turn

  ┌─ loop ──────┐ finalText  ┌─ parseResult ─┐
  │  (ended)    │ ──────────►│  → null?       │
  └─────────────┘            └──────┬─────────┘
                              yes   │ repackage toolCalls as evidence
                                    ▼
                         ┌─ recovery model.complete ─┐
                         │  tools OFF, strict system  │ ← one extra call
                         └──────────┬─────────────────┘
                                    ▼ parseResult again → value | null
```

**Provider failure → fallback chain.** Bridge from a load balancer trying the next
backend — the `FallbackModelProvider` wraps an ordered list of providers. On a
`complete` that throws, it checks `shouldFallback(error, provider)`; if true and
there's a next provider, it records the attempt and tries the next one. Abort
errors pass straight through (cancellation isn't a failure to fall back from). If
*all* providers fail, it throws a `ProviderFallbackError` listing every attempt.
Boundary condition: this is *failover*, not a circuit breaker — it has no memory of
past failures across calls, so it retries a dead provider on every new request
(distinction sharpened in `../06-production-serving/05-retry-circuit-breaker.md`).

```
  Pattern — fallback chain (failover, not circuit breaker)

  for provider in [p0, p1, p2]:
    try complete(request) → return (record lastSelectedProvider)
    catch:
      if abort → rethrow (not a fallback case)
      if !shouldFallback → rethrow
      record attempt; try next provider
  all failed → throw ProviderFallbackError(attempts)
```

**Context too big → fail fast.** Bridge from a guard clause that rejects before
doing work — the `ContextWindowGuardedProvider` estimates input tokens
(system + messages + tool schemas, ~3 chars/token) and, if they exceed
`maxTokens - outputReserve`, throws `ContextWindowExceededError` *before* calling
the underlying provider. Boundary condition: failing fast here is what *lets* the
fallback chain work — a too-big request to a small local model throws instantly, so
the fallback moves on to a bigger provider without a wasted round-trip. (Detail in
`../02-context-and-prompts/01-context-window.md`.)

### Move 2.5 — the two failures AptKit does NOT handle

Being precise about the gaps is half the value of the table.

```
  Comparison — handled vs honest gaps

  HANDLED                          NOT HANDLED (real gaps)
  ──────────────────────────       ──────────────────────────────────
  tool throws → observation        tool HANGS → no per-tool timeout;
  budget → forced synthesis          a stalled tool stalls the turn
  parse fail → recovery turn       same tool called repeatedly →
  provider down → fallback           no loop detection; the model can
  context too big → fail fast        burn the whole budget re-running
                                     an identical failing call
```

**No per-tool timeout.** `callTool` is awaited with no timeout wrapper. A tool that
hangs blocks the turn indefinitely (only an outer `signal` abort can stop it). The
fix is a `Promise.race` against a timeout per tool call — Case A exercise below.

**No repeated-tool-loop detection.** Because a tool error is just an observation the
model may ignore, the model can request the *same* failing call over and over until
the budget runs out — wasting every turn. The fix is tracking `(toolName, args)` and
injecting "you already ran that; try something else" — Case A exercise below (and in
`03-react-pattern.md`).

### Move 3 — the principle

Contain every failure at the nearest layer that can act on it, and choose the
recovery to match *who* can fix it. When the *model* can adapt — a tool error, a
parse miss — hand the failure back as data and let it recover. When only the *code*
can decide — budget exhausted, provider dead, context too big — force a deterministic
outcome (synthesis, failover, fail-fast). A failure that escapes as a raw exception
is a failure you didn't design for. And naming the gaps you *haven't* covered (tool
timeout, loop detection) is itself the senior move — it's the difference between
"it works on my fixtures" and "I know exactly how this degrades."

## Primary diagram

The full failure-mode map: every failure, where it's caught, and what it produces.

```
  Error recovery — full picture

  RUNTIME / AGENT LAYER (run-agent-loop.ts)
  ┌──────────────────────────────────────────────────────────────────┐
  │  tool throws ──► catch → {error} observation (:163-168)            │
  │       │            └─ model reads error, retries differently       │
  │  budget spent ──► forceFinal → tools OFF + synthesis (:101-109)     │
  │       │            └─ model compelled to answer                     │
  │  loop ends ──► parseResult null? ──► recoveryPrompt → 1 strict call │
  │                     (:192-228)        └─ salvage structured answer  │
  └────────────────────────────────┬───────────────────────────────────┘
                                   │ model.complete()
  PROVIDER LAYER
  ┌────────────────────────────────▼───────────────────────────────────┐
  │  context too big ──► guard throws BEFORE call (fail fast)            │
  │  provider error ──► FallbackModelProvider → try next provider        │
  │       │             all fail → ProviderFallbackError(attempts)       │
  └──────────────────────────────────────────────────────────────────┘

  GAPS (no handler): tool hang (no timeout) · repeated-tool loop (no detection)
```

## Implementation in codebase

**Use cases.** Every agent run leans on these. A workspace tool that 404s becomes
an `{error}` observation the model routes around. A recommendation run that exhausts
its 4 tool calls gets forced to synthesize from what it has. A model that returns
chatty prose instead of a JSON array triggers the recovery turn. A flaky primary
provider falls through to the next in the chain. A request too big for a local model
fails fast so the fallback reaches a bigger one.

**Tool error → observation**, `packages/runtime/src/run-agent-loop.ts:163-168`:

```
  packages/runtime/src/run-agent-loop.ts  (lines 163-168, 181-186)

  } catch (error) {
    isError = true;
    const message = error instanceof Error ? error.message : String(error);
    toolCall.error = message;
    resultContent = truncate(JSON.stringify({ error: message }));  ← error as data
  }
  …
  toolResults.push({ type: 'tool_result', toolUseId: toolUse.id,
    content: resultContent, ...(isError ? { isError: true } : {}) });
       │
       └─ the throw never escapes the loop. It becomes the model's next
          observation, so a single bad tool call doesn't kill the run.
```

**Unparseable output → recovery turn**, `packages/runtime/src/run-agent-loop.ts:192-228`:

```
  packages/runtime/src/run-agent-loop.ts  (lines 192-198, 210-217)

  if (options.parseResult) {
    parsed = options.parseResult(finalText);
    if (parsed === null && options.recoveryPrompt) {        ← parse failed + recovery exists
      const recoveryText =
        await runRecoveryTurn(options, options.recoveryPrompt(toolCalls));
      parsed = recoveryText === null ? null : options.parseResult(recoveryText);
    }
  }
  // runRecoveryTurn (:210-213): strict hardcoded system, tools off
  system: 'You are concluding a completed investigation. Output ONLY the
           structured answer in the requested shape. Never ask for more data.'
       │
       └─ one extra call, only on parse failure; if it still won't parse,
          parsed stays null and the agent returns [] (e.g.
          recommendation-agent.ts:95). Cheap insurance.
```

**Provider failure → fallback**, `packages/providers/fallback/src/fallback-provider.ts:47-89`:

```
  fallback-provider.ts  (lines 50-77, 88)

  for (let index = 0; index < this.providers.length; index += 1) {
    try {
      const response = await provider.complete(request);
      this.lastSelectedProvider = { providerId: provider.id, … };  ← record winner
      return { ...response, model: … };
    } catch (error) {
      if (isAbortError(error) || request.signal?.aborted) throw error;  ← abort passes through
      attempts.push(attempt);
      if (!this.shouldFallback(error, provider)) throw error;       ← predicate gate
      // else: warn + try the next provider
    }
  }
  throw new ProviderFallbackError(attempts);                        ← all failed
       │
       └─ failover, NOT a circuit breaker — no failure-count memory, so a
          dead provider is retried on every new request. See
          ../06-production-serving/05-retry-circuit-breaker.md.
```

**Context too big → fail fast**, `packages/providers/local/src/context-window-guard.ts:57-68`:
the guard estimates tokens and throws `ContextWindowExceededError` *before*
`provider.complete` — so an oversized request to a small provider fails instantly
and the fallback chain moves on without a wasted call.

## Elaborate

The handled rows are textbook graceful degradation: contain failures, prefer a
degraded-but-usable result over a crash. What's distinctive in the LLM setting is
the *tool-error-as-observation* move — feeding the error back so the model
self-corrects. That only works because the model is an adaptive participant; it's
the agentic analog of a human operator reading a stack trace and trying something
else. It's also the source of the repeated-tool-loop gap: an adaptive participant
that *doesn't* adapt will happily re-run the same failing call, which is why loop
detection is a known hardening step.

The fallback chain vs circuit breaker distinction matters in interviews and in
prod. AptKit has *failover* (try the next provider) but not a *breaker* (stop
hammering a known-dead provider, with open/half-open state). Conflating them is a
common error; AptKit's code is precise about being the former.

Adjacent concepts: the loop these recoveries live inside (`03-react-pattern.md`),
the fail-fast context guard (`../02-context-and-prompts/01-context-window.md`), and
the failover-vs-breaker distinction
(`../06-production-serving/05-retry-circuit-breaker.md`).

## Project exercises

*Provenance: Phase 4 — Agents and tool use (C4.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. Case A — the recovery moves exist; these close
the two named gaps.*

### Exercise — per-tool timeout (Case A)

- **Exercise ID:** `[A4.9]` Phase 4, error-recovery concept
- **What to build:** Wrap each `callTool` in a `Promise.race` against a configurable
  timeout; on timeout, produce an `{ error: 'tool timed out after Nms' }`
  observation (same shape as a thrown error) so the model can react.
- **Why it earns its place:** "Tool hangs" is a named gap in the failure table — a
  stalled tool stalls the whole turn today. A per-tool timeout is the standard fix
  and reuses the existing error-observation path.
- **Files to touch:** `packages/runtime/src/run-agent-loop.ts`,
  `packages/runtime/test/run-agent-loop.test.ts`.
- **Done when:** A fixture tool that never resolves yields a timeout observation and
  the loop proceeds; a test proves the run doesn't hang.
- **Estimated effort:** `1–4hr`

### Exercise — repeated-tool-loop detection (Case A)

- **Exercise ID:** `[A4.10]` Phase 4, error-recovery concept
- **What to build:** Track `(toolName, JSON.stringify(args))` per run; if the same
  pair fires N times, inject a "you already ran that exact call; try a different
  approach or answer now" observation instead of re-running it.
- **Why it earns its place:** Because a tool error is just an observation the model
  may ignore, it can re-request the same failing call until the budget is gone.
  Detecting and breaking that loop is a strong, concrete reliability signal (also
  flagged in `03-react-pattern.md`).
- **Files to touch:** `packages/runtime/src/run-agent-loop.ts`,
  `packages/runtime/test/run-agent-loop.test.ts`.
- **Done when:** A fixture returning the same tool call 3× triggers the injected
  message and the loop terminates within budget; a unit test proves it.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: A tool your agent calls throws an exception. Does the run die?**
"No — I turn the throw into data the model can react to. I'd sketch it:"

```
  callTool throws ──► catch ──► {error: msg} tool_result (isError:true)
                                      │
                                      ▼
                          model's next turn reads it → tries another tool
```

"The try/catch at `run-agent-loop.ts:163` converts the exception into an `{error}`
observation. The model reads it and can pick a different tool or arguments. A crash
would end the run; an observation keeps it alive and adaptive."
*Anchor: hand the failure back to the model when the model can fix it.*

**Q: Your fallback chain — is that a circuit breaker?**
"No, and the distinction matters:"

```
  fallback (have it)            circuit breaker (don't have it)
  try p0 → p1 → p2 on error     track failure counts, OPEN on threshold,
  no memory across calls         stop calling a dead provider, half-open probe
```

"`FallbackModelProvider` (`fallback-provider.ts:50`) is *failover* — it tries the
next provider on error, with `shouldFallback` and abort passthrough. But it has no
failure-count memory, so it retries a dead provider on every new request. A breaker
would remember and stop calling it. Adding backoff/state is the upgrade path."
*Anchor: failover tries the next; a breaker remembers the last.*

## Validate

- **Reconstruct:** From memory, write the failure-mode table — five handled rows,
  two gaps — with the recovery move for each. Check against the Move 1 diagram and
  the line refs in Implementation.
- **Explain:** Why does forced synthesis set `tools: undefined` instead of just
  telling the model to stop (`run-agent-loop.ts:106`)? (A model with tools available
  will use them even when told not to; removing the tools makes answering
  structurally mandatory.)
- **Apply:** The recommendation model returns a paragraph of prose instead of a JSON
  array. Walk the recovery. (`parseResult` → `null` → `recoveryPrompt(toolCalls)`
  repackages evidence → one strict tools-off call → parse again; still null →
  return `[]`. `run-agent-loop.ts:192-198`, `recommendation-agent.ts:91-95`.)
- **Defend:** Why is "tool hangs" a real gap and not covered by the existing
  try/catch? (A catch only fires on a throw; a hang never throws — it just never
  resolves. Only a timeout (`Promise.race`) or an outer abort can stop it.
  Exercise `[A4.9]`.)

## See also

- [03-react-pattern.md](03-react-pattern.md) — the loop these recoveries live inside; the forced-synthesis turn
- [02-tool-calling.md](02-tool-calling.md) — the tool-result block an error becomes
- [../02-context-and-prompts/01-context-window.md](../02-context-and-prompts/01-context-window.md) — the fail-fast context guard
- [../06-production-serving/05-retry-circuit-breaker.md](../06-production-serving/05-retry-circuit-breaker.md) — failover vs circuit breaker
- [../06-production-serving/01-llm-caching.md](../06-production-serving/01-llm-caching.md) — where the fallback chain attaches
