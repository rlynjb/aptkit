# LLM observability — traces, usage, replay

**Industry names:** tracing, spans, token/cost accounting, replay/record-replay · *Industry standard*

## Zoom out, then zoom in

A deterministic service you debug with logs. An agent you debug with a *trace* —
because the interesting failure ("why did it call that tool?", "why did this cost
$0.40?") is invisible in the output alone. AptKit's observability is three
pillars built on one event stream. Here's where they sit.

```
  Zoom out — the three observability pillars

  ┌─ Agent loop (packages/runtime) ─────────────────────────────────┐
  │  runAgentLoop emits CapabilityEvent on every step/tool/usage     │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  NDJSON stream
  ┌─ Observability (the three pillars) ─▼───────────────────────────┐
  │  ① TRACES   events.ts CapabilityEvent (step/tool/usage/warn/err) │ ← we are here
  │  ② USAGE    usage-ledger.ts summarizeUsage / estimateCost        │
  │  ③ REPLAY   replay artifact → @aptkit/evals assert → promote     │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  rendered / scored by
  ┌─ Studio + eval scripts ────────▼────────────────────────────────┐
  │  apps/studio · scripts/eval-replay-artifacts.mjs · promote-…     │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: you already know three production tools — *logs* (what happened), a
*metrics dashboard* (how much it cost / how slow), and a *recorded session you
can replay* (reproduce a bug exactly). LLM observability is those three, adapted:
the **trace** is a typed event stream of every model and tool step, **usage**
rolls those events into tokens and dollars, and **replay** freezes a whole run
into a JSON artifact you can re-evaluate and promote into a fixture. One event
type feeds all three.

## Structure pass

**Layers.** Three, stacked on one foundation. The foundation is the
`CapabilityEvent` stream. On top: usage accounting (a *fold* over the stream),
and the replay artifact (a *snapshot* of the stream plus the output). The trace
is raw; usage is derived; replay is persisted-and-scored.

**Axis — lifecycle: when does each pillar do its work?** Trace it across the
three:

```
  One axis — "when does this pillar act?"

  trace   →  DURING the run — emitted live, event by event, as steps happen
  usage   →  AFTER the run  — folds the trace into one tokens/cost row
  replay  →  PERSISTED      — the trace + output written to disk, then
                              re-evaluated offline, possibly DAYS later,
                              then promoted into a regression fixture

  same data, three lifecycle stages: live → summarized → frozen
```

**Seams.** Two load-bearing seams. First, the **emit seam**: `runAgentLoop` calls
`trace.emit(event)` and from there on the event is decoupled from the loop —
Studio renders it, the ledger sums it, the artifact stores it, none of them
knowing about each other. Second, the **persistence seam**: the in-memory trace
crosses to a JSON artifact on disk, and on the far side it's scored by
`@aptkit/evals` assertions and *secret-scanned* before it can be promoted. State
ownership flips at each: the loop owns the live event, the sink owns the rendered
trace, the file owns the frozen artifact.

## How it works

You know the trio: a structured logger, a cost dashboard, and a VCR cassette you
replay in tests. LLM observability is exactly that trio over one typed event
stream. Walk the pillars in lifecycle order — live, then summarized, then frozen.

### Move 1 — the mental model

One discriminated-union event type is emitted throughout a run; everything else
is a view over the stream of those events.

```
  CapabilityEvent — one tagged stream, three views

  run emits ──► [ step, tool_call_start, tool_call_end,
                  model_usage, warning, error, … ]   ← the TRACE (pillar 1)
                       │
          ┌────────────┼────────────────────────┐
          ▼            ▼                          ▼
   fold model_usage  store whole stream     render live in Studio
   → tokens, cost    + output → ARTIFACT     (NDJSON → UI)
   (USAGE, pillar 2) (REPLAY, pillar 3)
```

The win of one tagged union: the loop emits without knowing who's listening, and
each consumer pattern-matches the `type` field for the events it cares about. The
ledger ignores everything but `model_usage`; the artifact keeps them all.

### Move 2 — the step-by-step walkthrough

#### Pillar 1 — the trace: a discriminated union of events

Start with structured logging, but typed. Instead of free-form log lines,
`CapabilityEvent` is a discriminated union — six variants, each carrying exactly
the fields that variant needs, all tagged by `type`. A consumer narrows on `type`
and gets the right fields.

```
  CapabilityEvent variants — tag + payload per kind

  type                payload that matters
  ─────────────────   ──────────────────────────────────────────
  step                role, content          ← a model turn / thought
  tool_call_start     toolName, args         ← about to run a tool
  tool_call_end       toolName, result|error, durationMs  ← tool finished
  model_usage         provider, model, inputTokens, outputTokens, estimated
  warning             message                ← non-fatal ("hit budget")
  error               message                ← fatal
  (all carry capabilityId + timestamp)
```

This is the *span* idea from distributed tracing, flattened: a `tool_call_start`
/ `tool_call_end` pair brackets a tool span with its `durationMs`, and
`model_usage` is the cost span for a model turn. Streamed as NDJSON (one JSON
object per line), Studio renders them live. The boundary condition: `model_usage`
carries an `estimated?` flag — when a provider doesn't report token counts, the
loop emits an estimate and tags it, so a downstream cost number is never silently
presented as exact when it's a guess.

#### Pillar 2 — usage: fold the stream into tokens and dollars

Metrics dashboard, derived. `summarizeUsage` is a *reduce* over the trace that
keeps only `model_usage` events and sums their tokens, counts the turns, and
sticks if *any* event was estimated.

```
  summarizeUsage — fold model_usage events into one row

  trace.reduce((summary, event) => {
    if (event.type !== 'model_usage') return summary;   ← ignore the rest
    inputTokens  += event.inputTokens ?? 0
    outputTokens += event.outputTokens ?? 0
    turns        += 1
    estimated     = estimated || event.estimated === true ← sticky flag
  })
  → { inputTokens, outputTokens, totalTokens, modelName, turns, estimated }
```

Then `estimateCost` turns tokens into dollars — and here's the honest gap. It
prices `gpt-4.1`, `gpt-4.1-mini`, and `gpt-4.1-nano` (per-million input/output
rates), but `pricingForModel` returns `undefined` for any provider that isn't
`openai`. So an Anthropic run produces a real token count but a `cost: n/a` — the
function declines to invent a price it doesn't have rather than guess.

```
  estimateCost — priced for OpenAI gpt-4.1 family ONLY

  provider !== 'openai'        → undefined   (Anthropic, etc.: no price)
  gpt-4.1-nano  → in 0.10 / out 0.40  per 1M tokens
  gpt-4.1-mini  → in 0.40 / out 1.60
  gpt-4.1       → in 2.00 / out 8.00
  cost = (tokens / 1e6) * rate
       │
       └─ a non-OpenAI run still gets a TOKEN count; it just gets no $.
          Honest > a fabricated number. (cross-ref: token economics)
```

The boundary condition: because `estimated` is sticky and cost can be `undefined`,
Studio's `formatCost` shows `n/a` rather than `$0.00` for an unpriced run — a
missing price and a free run are different facts and the formatting keeps them
distinct.

#### Pillar 3 — replay: freeze the run into a scoreable artifact

The VCR cassette. After a run, Studio assembles a **replay artifact**: a JSON
object with a fixed schema that bundles the output, the full trace, the usage,
and provenance. That artifact is the unit the eval layer (`01`, `02`) scores and
the promotion script (`01`) freezes into a regression fixture.

```
  Replay artifact shape — output + trace + provenance, one JSON

  {
    schemaVersion: 1,              ← versioned so old artifacts are detectable
    capabilityId,                  ← which agent
    createdAt, durationMs,         ← when + how long
    provider: { id, model },       ← what ran it
    fixture: { id, path },         ← what input
    output (recommendations |      ← the answer, by capability
             anomalies | diagnosis | answer),
    trace: [CapabilityEvent…],     ← pillar 1, persisted
    eval: { name, ok },            ← embedded self-eval result
    modelTurns                     ← pillar 2, count
  }
```

The artifact is validated by `assertCapabilityReplayArtifactShape`, which routes
to the per-capability assertion (query / diagnostic / monitoring / recommendation)
based on `capabilityId` or output shape, then checks every required path,
`schemaVersion === 1`, a valid ISO `createdAt`, a non-negative `durationMs`, and
that the *embedded* `eval.ok` is `true`. The boundary condition that makes this a
security control: it then runs `findSecretLikeString` over the *entire* artifact.

#### The security-in-evals detail — secret scanning

An observability artifact captures *everything* — prompts, tool args, model
output. That's exactly where a leaked API key ends up if one slipped into a tool
arg or a prompt. So every artifact assertion recursively scans for secret-shaped
strings and fails the artifact if it finds one.

```
  findSecretLikeString — recursive secret scan, fails the artifact

  walk every string in the artifact (objects + arrays, recursively):
    matches /sk-[A-Za-z0-9_-]{10,}/  ?   → secret-like  → FAIL
    matches /OPENAI_API_KEY\s*=/     ?   → secret-like  → FAIL
       │
       └─ runs on EVERY artifact before it can be promoted. An artifact
          that leaked a key cannot become a committed fixture. Observability
          data is a real exfiltration surface; this closes it.
```

This is the line that makes replay safe to commit: a frozen artifact goes into
git as a fixture, so a leaked secret would be a *permanent* secret in history.
The scan is the gate.

### Move 3 — the principle

Observability for a non-deterministic system is *one structured event stream
plus views over it*: the trace is the stream, usage is a fold, replay is a
persisted snapshot. The discipline is to emit the events once, typed and decoupled
from their consumers, and never to invent data you don't have — tag estimates,
return `undefined` for unknown prices, and scan persisted data for secrets before
it becomes permanent. An observability layer that fabricates a clean number is
worse than one that admits `n/a`.

## Primary diagram

The three pillars over one stream, from live emission to a promoted fixture.

```
  LLM observability — one stream, three pillars, end to end

  ┌─ RUNTIME — runAgentLoop ────────────────────────────────────────┐
  │  emit(step) emit(tool_call_start) emit(tool_call_end)            │
  │  emit(model_usage) emit(warning) emit(error)                    │
  └───────────────────────────────┬──────────────────────────────────┘
              ① TRACE (live)       │  CapabilityEvent stream
                  ┌────────────────┼─────────────────────────┐
                  ▼                ▼                           ▼
          Studio renders   ② summarizeUsage (fold)     ③ build artifact
          NDJSON live       → tokens, turns, estimated     { output, trace,
                                  │                           eval, provenance,
                                  ▼                           schemaVersion:1 }
                            estimateCost                          │
                            (OpenAI gpt-4.1 only;                 ▼
                             else undefined → n/a)         assertCapabilityReplay-
                                                           ArtifactShape
                                                            + findSecretLikeString
                                                                  │  ok + clean
                                                                  ▼
                                                           promote → regression
                                                           fixture (see 01)
```

## Implementation in codebase

**Use cases.** Every agent run emits a trace through `runAgentLoop`. Studio
(`apps/studio/src/replay-artifacts.ts`) assembles a replay artifact per
capability — `buildQueryReplayArtifact`, and the monitoring/diagnostic/
recommendation equivalents — folding `summarizeUsage`/`estimateCost` into the
artifact and stamping `schemaVersion: 1`. The CLI
`scripts/eval-replay-artifacts.mjs` scores a directory of saved artifacts in CI;
`scripts/promote-replay-to-fixture.mjs` freezes a passing one into a fixture.

**Pillar 1 — the event union**, `packages/runtime/src/events.ts:1-24`:

```
  packages/runtime/src/events.ts  (lines 1-24)

  export type CapabilityEvent =
    | { type: 'step'; capabilityId; role; content; timestamp }
    | { type: 'tool_call_start'; capabilityId; toolName; args; timestamp }
    | { type: 'tool_call_end'; capabilityId; toolName; result?; error?;
        durationMs; timestamp }                       ← span: start/end bracket
    | { type: 'model_usage'; capabilityId; provider; model;
        inputTokens?; outputTokens?; estimated?; timestamp }  ← cost span
    | { type: 'warning'; capabilityId; message; timestamp }
    | { type: 'error'; capabilityId; message; timestamp };
       │
       └─ one tagged union. Optional token fields + `estimated?` mean a
          provider that doesn't report tokens still emits a usage event,
          just flagged. Consumers narrow on `type`.
```

**Pillar 2 — the fold and the honest price gap**,
`packages/runtime/src/usage-ledger.ts:25-42` and `:71-78`:

```
  packages/runtime/src/usage-ledger.ts  (lines 25-42, 71-78)

  export function summarizeUsage(trace) {
    return trace.reduce((summary, event) => {
      if (event.type !== 'model_usage') return summary;   ← only usage events
      …
      estimated: summary.estimated || event.estimated === true, ← sticky
    }, { inputTokens:0, outputTokens:0, totalTokens:0, modelName:'', turns:0,
         estimated:false });
  }
  …
  export function pricingForModel(provider, modelName) {
    if (provider !== 'openai') return undefined;          ← honest gap:
    if (normalized.startsWith('gpt-4.1-nano')) return { in:0.1,  out:0.4 };
    if (normalized.startsWith('gpt-4.1-mini')) return { in:0.4,  out:1.6 };
    if (normalized.startsWith('gpt-4.1'))      return { in:2,    out:8 };
    return undefined;                                     ← unknown model: no $
  }
       │
       └─ a non-OpenAI run gets tokens but cost === undefined → Studio renders
          "n/a", not a fabricated dollar amount. Token economics: see the
          forward-referenced 01-llm-foundations/06-token-economics.md.
```

**Pillar 3 — artifact shape + secret scan**,
`packages/evals/src/assertions.ts:58-126` and `:397-421`:

```
  packages/evals/src/assertions.ts  (lines 58-72, 119-123)

  assertRequiredPaths(output, [
    'schemaVersion', 'createdAt', 'durationMs', 'provider.id', 'provider.model',
    'fixture.id', 'fixture.path', 'recommendations', 'trace',
    'eval.name', 'eval.ok', 'modelTurns' ]);            ← the artifact contract
  …
  const secretIssue = findSecretLikeString(output);     ← security gate
  if (secretIssue) issues.push(secretIssue);            ← leaked key → FAIL
```

```
  packages/evals/src/assertions.ts  (lines 397-409)

  function findSecretLikeString(value, path = '') {
    if (typeof value === 'string') {
      if (/sk-[A-Za-z0-9_-]{10,}/.test(value) ||        ← OpenAI-style key
          /OPENAI_API_KEY\s*=/.test(value))             ← env-assignment leak
        return { path, message: 'artifact contains a secret-like string' };
      return null;
    }
    if (Array.isArray(value)) { /* recurse each index */ }  ← walks the WHOLE
    if (isRecord(value))      { /* recurse each value */ }     artifact tree
  }
       │
       └─ recursive: a key buried in a tool arg deep in the trace is still
          caught. The artifact is committed as a fixture, so this is the
          difference between a transient leak and one in git forever.
```

## Elaborate

The three pillars are the LLM adaptation of classic observability's "three
pillars" (logs, metrics, traces). The `CapabilityEvent` union is distributed
tracing's *span* concept flattened into a flat event log — start/end pairs are
spans, `model_usage` is a cost-annotated span. Record-replay (the artifact) is
the oldest debugging trick there is — capture inputs+outputs of a real run,
replay deterministically — applied to a system whose "inputs" include a stochastic
model. AptKit's specific contributions: the `schemaVersion` so artifacts are
forward-detectable, the `estimated` flag and `undefined` price so cost is never
fabricated, and `findSecretLikeString` because an observability artifact destined
for git is a genuine secrets-exfiltration surface most teams forget.

The connection to the rest of the section is tight: the trace feeds usage
(this file), the artifact is the *unit* that eval methods score (`02`) and that
gets promoted into the regression set (`01`), and a judge call (`03`) emits
`model_usage` events like any other model call, so judging is itself observable.

Adjacent: the loop that emits these events
([../04-agents-and-tool-use/03-react-pattern.md](../04-agents-and-tool-use/03-react-pattern.md));
the eval methods that score the artifact ([02-eval-methods.md](02-eval-methods.md));
the promotion pipeline that freezes it ([01-eval-set-types.md](01-eval-set-types.md));
token-cost detail in the forward-referenced
`../01-llm-foundations/06-token-economics.md` (not yet generated).

## Project exercises

*Provenance: Phase 5 — Evals and observability (C5.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. Case A — the OpenAI price table is the
obvious extension; the others harden the existing pillars.*

### Exercise — add Anthropic pricing to the usage ledger

- **Exercise ID:** `[C5.7]` Phase 5, llm-observability concept, Case A (extend)
- **What to build:** Extend `pricingForModel` to price the Anthropic model family
  (per-million input/output rates for the Claude models AptKit can run), so an
  Anthropic replay reports a real cost instead of `n/a`. Keep the `undefined`
  fallback for genuinely unknown models.
- **Why it earns its place:** `estimateCost` is OpenAI-only today — the most
  visible honest gap in the usage pillar. Closing it makes cross-provider cost
  comparison (the whole point of replaying the same fixture on two providers)
  actually work, and exercises looking up real pricing rather than memorizing it.
- **Files to touch:** `packages/runtime/src/usage-ledger.ts`,
  `packages/runtime/test/usage-ledger.test.ts`.
- **Done when:** An Anthropic-provider usage summary returns a defined
  `CostEstimate` and a test asserts the per-million rates; an unknown model still
  returns `undefined`.
- **Estimated effort:** `<1hr`

### Exercise — broaden the secret-scan patterns

- **Exercise ID:** `[C5.8]` Phase 5, llm-observability concept
- **What to build:** Extend `findSecretLikeString` to also catch
  `ANTHROPIC_API_KEY=`, `sk-ant-` keys, and bearer-token-shaped strings, and add a
  test artifact containing each to prove the scan fails it.
- **Why it earns its place:** The current scan only knows OpenAI-shaped secrets,
  but AptKit runs Anthropic too — an Anthropic key in an artifact would sail
  through into a committed fixture. Closing the gap matches the scan to the
  providers actually in use.
- **Files to touch:** `packages/evals/src/assertions.ts`,
  `packages/evals/test/assertions.test.ts`.
- **Done when:** An artifact containing an `sk-ant-…` key fails
  `assertReplayArtifactShape` with the secret-like-string issue, and a clean
  artifact still passes.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: How do you debug an agent that did the wrong thing? You can't just read the
output.**

```
  output alone = "it recommended X"  ← WHY is invisible
  trace        = step / tool_call_start / tool_call_end / model_usage
               = the full reasoning + tool path + tokens, replayable
```

"I read the trace, not the output. Every run emits a `CapabilityEvent` stream —
`step` for each model turn, `tool_call_start`/`tool_call_end` bracketing each
tool with its `durationMs`, `model_usage` for tokens (`events.ts`). That's the
agent equivalent of a structured log plus spans. And because Studio freezes the
whole stream into a replay artifact, I can re-run the eval over the exact failing
run offline — record-replay. The output tells me *what*; the trace tells me
*why*."
*Anchor: one typed event stream is the trace, the usage fold, and the replay snapshot.*

**Q: Your cost dashboard shows `n/a` for an Anthropic run. Bug?**

```
  pricingForModel('anthropic', …) → undefined   (no price table)
  → estimateCost → undefined → formatCost → "n/a"   (NOT "$0.00")
```

"Not a bug — a deliberate honest gap. `pricingForModel` only has the OpenAI
gpt-4.1 family (`usage-ledger.ts:71-77`); for any other provider it returns
`undefined`, and `formatCost` renders that as `n/a`, distinct from `$0.00` for a
free run. The token *count* is still real — just the dollar figure is withheld
because we don't have the rate. I'd rather show `n/a` than fabricate a price.
Adding Anthropic rates is a one-function fix."
*Anchor: never fabricate a number you don't have — tag estimates, return undefined for unknowns.*

## Validate

- **Reconstruct:** From memory, list the six `CapabilityEvent` variants and which
  one the usage ledger reads. Check against `packages/runtime/src/events.ts:1-24`
  and `packages/runtime/src/usage-ledger.ts:25-42`.
- **Explain:** Why does `summarizeUsage` make `estimated` *sticky*
  (`usage-ledger.ts:37`)? (If any single turn's tokens were estimated, the whole
  summary is an estimate — one estimated turn taints the aggregate, so the flag
  must latch true and never reset.)
- **Apply:** A tool arg in a run contains `sk-proj-AbC123…`. The run succeeds and
  Studio builds the artifact. Can it be promoted to a fixture? (No —
  `assertReplayArtifactShape` runs `findSecretLikeString` over the whole artifact,
  finds the `sk-` pattern, and fails the artifact; the promotion script's gate
  rejects it. The secret never reaches git.) Trace
  `packages/evals/src/assertions.ts:119-123` and `:397-409`.
- **Defend:** Why bundle the trace *inside* the replay artifact instead of storing
  it separately? (The artifact is a self-contained reproduction unit — output,
  trace, usage, and the embedded `eval.ok` travel together, so scoring and
  promoting it offline needs no other file, and a promoted fixture carries its own
  provenance.) See the required-paths contract at
  `packages/evals/src/assertions.ts:58-72`.

## See also

- [02-eval-methods.md](02-eval-methods.md) — the methods that score the artifact
- [01-eval-set-types.md](01-eval-set-types.md) — promoting an artifact into a regression fixture
- [03-llm-as-judge-bias.md](03-llm-as-judge-bias.md) — a judge call is itself a traced model call
- [../04-agents-and-tool-use/03-react-pattern.md](../04-agents-and-tool-use/03-react-pattern.md) — the loop that emits every event
- `../01-llm-foundations/06-token-economics.md` — token cost detail (forward reference, not yet generated)
