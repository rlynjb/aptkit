# Degradation warning traces

*Industry name(s): graceful-degradation telemetry / failover observability. Type label:
Project-specific (the warning-emit-on-degrade convention is AptKit's).*

## Zoom out, then zoom in

You know how a CDN response carries an `X-Cache: MISS` header so you can tell *after the
fact* that it fell back to origin instead of serving from edge? Degradation warning
traces are that signal for the provider layer: when the system silently does something
other than the happy path — fails over to a second provider, skips a local model that
can't fit the prompt — it drops a `warning` event into the trace so the degradation is
*explained*, not invisible.

```
  Zoom out — where degradation warnings live

  ┌─ Studio UI layer ───────────────────────────────────────────┐
  │  ProviderStatusPanel: surfaces fallback warnings specifically│
  └───────────────────────────────▲──────────────────────────────┘
                                   │  warning events (in the trace stream)
  ┌─ Provider layer (packages/providers) ───────────────────────┐
  │  ★ FallbackModelProvider ★    ★ ContextWindowGuardedProvider ★│ ← we are here
  │   trace.emit({type:'warning'})  on failover / on skip        │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  wraps the real adapters
  ┌─ Provider adapters ─────────────────────────────────────────┐
  │  AnthropicModelProvider · OpenAIModelProvider · local model  │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **emit a `warning` event the moment the system departs from the
happy path, into the same trace as everything else.** The question it answers: *the run
succeeded but was slower / cheaper / used a different model than expected — why?*

## The structure pass

**Layers.** The wrapper providers (`FallbackModelProvider`, `ContextWindowGuardedProvider`)
sit *above* the real adapters and *below* the agent loop. They're decorators: same
`ModelProvider` interface, extra behavior.

**One axis — "does the caller know degradation happened?"** Trace it:

```
  axis = "is degradation visible to the observer?"

  ┌─ agent loop ────────────┐  sees only a successful ModelResponse — degradation HIDDEN
  └──────────┬──────────────┘     from the return value
             │  seam: the warning event (side-channel into the trace)
  ┌─ wrapper provider ──────┐  KNOWS it degraded — emits warning before returning success
  └──────────┬──────────────┘
             │
  ┌─ real adapter ──────────┐  threw / would-overflow — the degradation TRIGGER
  └─────────────────────────┘
```

**The load-bearing seam is the `warning` event as a side-channel.** The agent loop gets a
normal successful `ModelResponse` — the fallback *worked*, so the return value looks
identical to a happy-path success. The only place the degradation is recorded is the
trace. Without the warning emit, a failover is completely invisible: the run succeeds, the
output is fine, and you'd never know the primary provider was down or that you're now
paying for a different model. The warning is what turns a silent recovery into an
observable event.

## How it works

### Move 1 — the mental model

A wrapping provider tries the happy path; if it has to degrade, it emits a `warning`
describing *what* and *why*, then proceeds. The success return value is unchanged; the
warning is the only trace of the detour.

```
  The pattern — emit-on-degrade, then continue

  request ──► wrapper provider
                  │
                  ├─ happy path works? ──► return ModelResponse  (no warning)
                  │
                  └─ must degrade?
                        emit({ type:'warning', message:"why" })  ← the side-channel
                        │
                        └─► fall over / skip ──► return ModelResponse  (looks normal)
```

### Move 2 — the walkthrough

**Failover — `FallbackModelProvider`.** It holds an ordered list of providers and tries
each in turn. On the happy path the first one succeeds and *no warning is emitted* — the
silent path stays silent. If a provider throws (and it's not an abort, and `shouldFallback`
says yes), it pushes the failure into an `attempts` list and, *if there's another provider
to try*, emits a `warning` naming which provider failed and with what error. Bridge: a
retry-with-fallback wrapper, except the fallback hop is logged into the trace. What breaks
without the warning: a run that quietly switched from OpenAI to Anthropic mid-flight looks
identical to one that never had a problem — you'd debug a cost spike with no clue.

```
  Failover sequence — warning only on the hop, not the success

  try provider[0] ─ throws "rate limit"
       │ push attempt; index < last? YES
       └─ emit warning: "Provider openai failed (rate limit); trying fallback provider."
  try provider[1] ─ succeeds
       └─ return response   ← agent loop sees ONLY this success
                              the warning is the only record of the detour
```

The boundary condition worth naming: the warning is emitted *only if there's a next
provider to try* (`index < this.providers.length - 1`). If the *last* provider fails,
there's no warning — instead the whole thing throws `ProviderFallbackError` carrying every
attempt. So "warning" means "recovered by degrading"; "error/throw" means "couldn't
recover." That's the right split.

**Pre-flight skip — `ContextWindowGuardedProvider`.** This wrapper guards a local model
that has a hard context limit. Before calling the wrapped provider, it estimates the input
tokens (chars ÷ `charsPerToken`, default 3) and compares against `maxTokens - outputReserve`.
If the prompt won't fit, it emits a `warning` explaining the estimate and *throws*
`ContextWindowExceededError` — which, inside a fallback chain, triggers the next provider.
Bridge: a guard clause that refuses work it can't do and says why. What breaks without the
warning: the local model gets skipped and you'd see only "fell through to the cloud
provider" with no reason.

```
  Context guard — estimate, warn, skip

  estimate input tokens (text.length / charsPerToken)
       │ fits in (maxTokens - outputReserve)?
       ├─ YES ──► call wrapped provider (no warning)
       └─ NO  ──► emit warning: "Skipping local provider: estimated N tokens exceed M."
                  throw ContextWindowExceededError  ← fallback chain catches → next provider
```

**Surfacing — `ProviderStatusPanel`.** Studio doesn't just dump warnings into the generic
trace list; it *recognizes* fallback warnings specifically. `isProviderFallbackWarning`
matches `warning` events whose message matches `/fallback provider|Provider .* failed/` and
shows the last three in a dedicated provider panel. Bridge: highlighting `X-Cache: MISS` in
a network panel instead of burying it in raw headers. What this buys: degradation is
promoted from "somewhere in the trace" to "front and center next to the provider status."

### Move 2 variant — the load-bearing skeleton

```
  the kernel:  detect-degradation  →  emit warning(why)  →  proceed with the fallback
```

- **Drop the warning emit** → degradation becomes invisible; a successful-but-degraded run
  is indistinguishable from a clean one. This is the whole point — without it the pattern
  doesn't exist.
- **Drop the "only if next provider exists" guard** → you'd emit a misleading "trying
  fallback" warning even when there's no fallback to try; the message would lie.
- **Drop the `why` in the message** → "something degraded" with no cause is barely better
  than silence; the error string in the message is what makes it actionable.

**Skeleton vs hardening:** detect + emit + proceed is the skeleton. The `attempts` list on
`ProviderFallbackError`, the `shouldFallback` predicate, the abort-error short-circuit, the
Studio regex recognition — hardening.

### Move 3 — the principle

The principle is **make recovery observable.** A system that silently recovers from
failure is a system you can't reason about: the failure rate, the cost shift, the latency
hit all hide behind a successful response. Emitting a `warning` at the moment of
degradation — into the *same* trace as the happy-path events, in causal order — means the
recovery leaves a footprint. The key design choice is *what counts as a warning vs an
error*: degrade-and-recover is a warning (the run still succeeds), exhaust-all-options is
an error (it can't). That distinction is what lets a reader scan the `warning` count and
know "this run worked, but not the easy way."

## Primary diagram

The full degradation story, both wrappers, one frame.

```
  Degradation warning traces — two wrappers, one warning convention

  ┌─ agent loop ─ model.complete(request) ──────────────────────────────┐
  └───────────────────────────┬──────────────────────────────────────────┘
                              ▼
  ┌─ FallbackModelProvider (fallback-provider.ts:47-89) ─────────────────┐
  │  for each provider in order:                                          │
  │    try complete() → success → return  (no warning)                    │
  │    catch (non-abort, shouldFallback):                                 │
  │      if more providers: emit warning "Provider X failed; trying ..."  │──┐
  │  all failed → throw ProviderFallbackError(attempts)                   │  │
  └───────────────────────────┬──────────────────────────────────────────┘  │
                              │ wrapped provider may be...                    │ warning
                              ▼                                               │ events
  ┌─ ContextWindowGuardedProvider (context-window-guard.ts:57-70) ───────┐   │ into the
  │  estimate tokens; if won't fit:                                       │   │ trace
  │    emit warning "Skipping local provider: N exceeds M" ───────────────┼───┤ stream
  │    throw ContextWindowExceededError  (→ fallback tries next)          │   │
  │  else: call the real local adapter                                    │   │
  └───────────────────────────────────────────────────────────────────────┘  │
                                                                               ▼
  ┌─ Studio ProviderStatusPanel (components.tsx:275,296-302,360-362) ─────────┐
  │  isProviderFallbackWarning() filters → shows last 3 in provider panel      │
  └────────────────────────────────────────────────────────────────────────────┘
   Provider/Network boundary: the adapters cross to OpenAI/Anthropic; the warnings are
   emitted ON THIS side, recording the boundary's behavior in the local trace.
```

## Implementation in codebase

**Use cases in this repo.** Studio live runs (`anthropic`/`openai` modes) wrap the primary
provider in a `FallbackModelProvider` with the other vendor as backup
(`vite.config.ts:819-828`, `providerWithConfiguredFallback`). The context guard wraps a
local model in a fallback chain so an over-budget prompt skips local and goes to cloud.
Any failover or skip during a run shows up as a `warning` in the trace and in the provider
panel.

**Failover warning — `packages/providers/fallback/src/fallback-provider.ts:64-85`:**

```
  fallback-provider.ts — emit on the hop, not the success

  :54   const response = await provider.complete(request);  ← happy path: no warning
  :60   return { ...response, model: response.model ?? provider.defaultModel };

  :64   } catch (error) {
  :65     if (isAbortError(error) || request.signal?.aborted) throw error;  ← abort ≠ degrade
  :71     attempts.push(attempt);
  :73     if (!this.shouldFallback(error, provider)) throw error;  ← non-fallback → rethrow
  :77     if (index < this.providers.length - 1) {                 ← only if a next exists
  :78       this.trace?.emit({ type: 'warning',
  :81         message: `Provider ${provider.id} failed (${attempt.error}); trying fallback provider.` });
          }
  :88   throw new ProviderFallbackError(attempts);  ← all failed → ERROR, not warning
        │
        └─ the warning/error split: recovered-by-degrading = warning;
           exhausted-all-providers = thrown error carrying every attempt.
```

**Context-guard warning — `packages/providers/local/src/context-window-guard.ts:57-68`:**

```
  context-window-guard.ts — warn before refusing

  :59   const estimate = estimateContextWindow(request, this.options);  ← chars/3 heuristic
  :60   if (!estimate.ok) {                                             ← won't fit
  :61     this.options.trace?.emit({ type: 'warning',
  :64       message: `Skipping local provider ${this.provider.id}: estimated
                      ${estimate.estimatedInputTokens} input tokens exceed
                      ${estimate.availableInputTokens}.` });            ← the WHY, with numbers
  :67     throw new ContextWindowExceededError(estimate);               ← → fallback next
        }
  :69   return this.provider.complete(request);                         ← fits: no warning
```

**Recognition in Studio — `apps/studio/src/components.tsx:360-362`:**

```
  components.tsx — fallback warnings get a dedicated surface

  :275  const warnings = trace.filter(isProviderFallbackWarning);   ← pick out failovers
  :296  {warnings.length ? <div className="providerWarnings"> ...    ← show in PROVIDER panel
  :298    {warnings.slice(-3).map(...)}                              ← last 3, not buried
  :360  function isProviderFallbackWarning(event) {
  :361    return event.type === 'warning'
            && /fallback provider|Provider .* failed/.test(event.message);  ← match by message
        }
```

The regex match at `:361` is the load-bearing detail: because the warning *message* is a
known shape (set in the fallback provider), Studio can promote those specific warnings to
the provider panel while leaving other warnings in the generic trace. The message string is
effectively a soft contract between the emitter and this UI.

## Elaborate

This is the observability complement to graceful degradation. Degradation patterns
(fallback chains, circuit breakers, guard clauses) keep the system *working* under partial
failure; the warning trace keeps the system *explainable* under partial failure. Without
the second half, you build a system that hides its own problems — the dangerous kind,
because it looks healthy right up until the fallback also fails.

The warning-vs-error split is the subtle design judgment. A `warning` means "I recovered,
but you should know how"; an `error`/throw means "I could not recover." `FallbackModelProvider`
encodes this precisely: every failover hop is a warning, but exhausting the chain throws
`ProviderFallbackError` with the full `attempts` list (`fallback-provider.ts:88`). The
context guard sits one level down: it *throws* its own error, which is a *warning* from the
chain's perspective because the chain recovers by trying the next provider. Same event,
different altitude — a throw at the guard becomes a recovered-degradation at the chain.
Read `01-structured-trace-events.md` for the `warning` arm's shape and `04-live-trace-stream.md`
for how these warnings reach the UI in real time.

## Interview defense

**Q: A failover succeeded, so why bother emitting anything?**
Because a successful failover is invisible in the return value — the agent loop gets a
normal `ModelResponse` whether or not the primary provider died. The `warning` is the only
record that degradation happened. Without it you'd debug a cost spike or latency bump with
no clue the system silently switched providers.

```
  return value:   ModelResponse (identical, success either way)
  trace:          [...] vs [..., warning("openai failed; trying fallback"), ...]
                          └─ the ONLY difference between clean and degraded
```

Anchor: `fallback-provider.ts:77-84`.

**Q: When is degradation a warning vs an error?**
Recovered-by-degrading is a warning (the run still succeeds); exhausted-all-options is a
thrown error. `FallbackModelProvider` emits a warning on each hop but throws
`ProviderFallbackError` only when every provider failed (`:88`). The context guard throws
its own error, which the chain *catches* and treats as a recoverable degradation. Anchor:
`fallback-provider.ts:77-88`, `context-window-guard.ts:60-67`.

**Q: How does Studio show failover warnings without burying them in the trace?**
It matches the warning *message* against a known pattern (`isProviderFallbackWarning`,
`components.tsx:360-362`) and promotes those to a dedicated provider panel. The message
shape is a soft contract between the fallback provider and the UI.

## Validate

1. **Reconstruct:** describe the three skeleton steps (detect, emit-why, proceed) and the
   warning-vs-error split. Check against `fallback-provider.ts:64-88`.
2. **Explain:** why does the fallback provider emit a warning only when
   `index < providers.length - 1` (`:77`)? What would the message say wrongly if you
   dropped that guard?
3. **Apply to a scenario:** a live run is unexpectedly expensive. Which trace events tell
   you it failed over to a pricier model, and where in Studio would you see them first
   (`components.tsx:296-302`)?
4. **Defend the decision:** argue why a recovered failover is a `warning` while an
   exhausted chain is a thrown `ProviderFallbackError`, and what the `attempts` list on
   that error gives a debugger (`fallback-provider.ts:88`).

## See also

- `01-structured-trace-events.md` — the `warning` / `error` arms.
- `04-live-trace-stream.md` — how warnings stream to the provider panel live.
- `00-overview.md` — finding #5, degradation is explained not silent.
- `study-system-design` — the provider abstraction and fallback chain as architecture.
