# Reading the trajectory backward (root-cause from the event log)

**Industry name(s):** backward root-cause analysis / trace-based debugging /
reading the log from the symptom. **Type:** Language-agnostic technique.

## Zoom out, then zoom in

This file isn't a code mechanism — it's the *method* the other three exist to
enable. The trace spine, the fan-out, and the durable sink are all
infrastructure. This is what you actually *do* with them when an agent gives a
wrong answer: you don't guess, you read the recorded trajectory from the symptom
backward until the cause appears.

```
  Zoom out — where the method operates

  ┌─ Storage layer (buffr Postgres) ──────────────────────────┐
  │  agents.messages — the persisted trajectory (ordered)     │
  └──────────────────────────────┬─────────────────────────────┘
                                 │ read backward, newest → oldest
  ┌─ Human / debugger ───────────▼─────────────────────────────┐
  │  ★ symptom ← effect ← cause ★   (this method)              │ ← we are here
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the question is *given a wrong final answer, where did it go wrong?*
The forward trace answers "what happened." Reading it backward answers "why this
result" — you start at the conclusion and walk causality in reverse until you
hit the event that doesn't follow from its inputs.

## The structure pass

**Layers.** The trajectory has a natural causal nesting: final answer ⊃ the tool
results that informed it ⊃ the args that produced those results ⊃ the model
decision that chose those args.

**Axis — trace it on `failure`: where did the failure originate vs where did it
surface?**

```
  "where did the failure originate, and where did it surface?"

  ┌─ surface ────────────────────────────────────┐
  │ final answer: "not available"                │  ← surfaced HERE
  └───────────────────────┬───────────────────────┘
       reads as: model honestly reported no data
  ┌───────────────────────▼───────────────────────┐
  │ tool_result: { results: [] }  (empty)         │  ← NOT the origin —
  └───────────────────────┬───────────────────────┘     a faithful effect
  ┌───────────────────────▼───────────────────────┐
  │ tool_call_start args: {textContains:"..."}    │  ◄── ORIGIN of failure
  └────────────────────────────────────────────────┘     (hallucinated filter)

  surface ≠ origin — backward reading is what separates them
```

**Seam.** The boundary between *effect* (`tool_call_end` empty result) and
*cause* (`tool_call_start` args) is the load-bearing joint. The failure axis
flips there: above it everything is a faithful consequence, below it is the
defect. The entire skill is finding that flip. It's only findable because the
durable sink (`03`) persisted the args — the cause — alongside the effect.

## How it works

### Move 1 — the mental model

You've debugged a failing test by reading the stack trace from the assertion
*up* to the line that set the bad value — you don't start at `main()`. Same
move. A stack trace is a causal chain you read from the symptom backward; the
event log is a causal chain across *time* instead of *call depth*, and you read
it the same way.

```
  The pattern — walk causality in reverse from the symptom

  forward (what happened):   cause ──► effect ──► symptom
  backward (why):            symptom ──► effect ──► CAUSE
                               ▲                      │
                               └── start here   stop here ┘
                                   (the wrong answer)  (the event that
                                                        doesn't follow from
                                                        its inputs)
```

Stop when you reach an event whose output doesn't follow from its input — that's
the origin. Everything after it is faithful propagation.

### Move 2 — the step-by-step walkthrough (the war story as a method)

**Symptom — the report.** A RAG agent answered *"not available"* for a question
whose answer was plainly in the indexed corpus. The forward instinct is to
suspect the corpus or the embeddings. Resist it — read backward instead.

**Step 1 — start at the surface event.** The last `step` event is the final
answer: "not available." Read literally, the model did nothing wrong — it
truthfully reported that it found nothing. So the failure isn't *here*; it's
upstream of what the model saw. Move back one causal layer.

```
  Layers-and-hops — reading backward through the trajectory

  ┌─ trajectory (agents.messages, ordered by created_at) ─────────────┐
  │                                                                   │
  │  step (final)      "not available"           ◄── (4) symptom      │
  │       ▲ why this answer?                                          │
  │  tool_call_end     { result: { results: [] } } ◄── (3) empty,     │
  │       ▲ why empty?                                  but faithful  │
  │  tool_call_start   { args: { query: "...",                        │
  │                       filter: { textContains: "..." } } }         │
  │                                                ◄── (2) the ARGS    │
  │       ▲ why this filter?                                          │
  │  step (assistant)  model chose to call search with that filter    │
  │                                                ◄── (1) ORIGIN      │
  └───────────────────────────────────────────────────────────────────┘
```

**Step 2 — the empty result is an effect, not a cause.** The `tool_call_end`
shows `results: []`. An empty array is suspicious but not self-explaining — a
retrieval can be empty for many reasons. Don't stop here. The question is *why*
did this search return nothing on a corpus that contains the answer? Move back to
the inputs that produced it.

**Step 3 — the args expose the cause.** The `tool_call_start` event — persisted
only because the durable sink keeps args (`03`) — shows the model passed a
`filter` of roughly `{ textContains: "..." }`. That's the flip. The
`search_knowledge_base` tool's filter is an *exact-match* over chunk metadata,
and **no chunk carries a `textContains` key**. Gemma, which has no real
tool-calling and emulates it, hallucinated a filter field that sounded
plausible. The old `matchesFilter` treated an unknown filter key as "exclude
everything that doesn't match," so an exact-match against a key no chunk has
zeroed every result. The empty array was a faithful consequence of a poisoned
filter.

**Step 4 — confirm with a controlled experiment.** The hypothesis ("the filter
zeroed it") is cheap to test: re-run the same query *without* the filter and the
results come back. The trajectory said where to look; the rerun confirmed it. The
fix and its regression guard are the subject of `06`.

The whole diagnosis is four reads of a persisted log — no print-debugging, no
re-instrumenting, no reproducing a flaky live model. It worked because the
trajectory was *durable* (survived the original run), *ordered* (the causal chain
was intact), and *complete* (the args, the cause, were kept).

### Move 2 variant — the load-bearing skeleton

```
  Kernel of backward root-cause analysis

  1. start at the symptom event       ── the wrong output, not the run start
  2. ask "why this, given its inputs?" ── at each step
  3. distinguish effect from origin    ── faithful consequence vs the defect
  4. stop at the input→output mismatch ── the first event that doesn't follow
```

- **Drop "start at the symptom"** and you're reading forward, drowning in
  faithful events before you reach the defect.
- **Drop "effect vs origin"** and you stop at the empty result and "fix" the
  corpus — treating a symptom, not the cause.
- **Drop the durable, ordered, complete trace** and the method has no substrate:
  no symptom to start from, no chain to walk, no args to expose the cause. This
  is why `01`/`03` exist.

**Skeleton vs hardening.** The method is the kernel. The hardening is what would
make it *faster*: a zero-hit `warning` event (unbuilt — see `06`) would have put
a flag right at step 3, collapsing the four reads to one. The method survives
without it; the warning just shortens it.

### Move 3 — the principle

The symptom is almost never the cause — and a log that keeps only outputs can
only ever show you symptoms. Backward reading separates the event that
*surfaced* the failure from the event that *caused* it, and it's only possible if
the trajectory kept the inputs. Build the log to keep causes, then read it from
the crime back to the motive.

## Primary diagram

```
  Backward root-cause — the war story arc

  SYMPTOM   step: "not available"  on a corpus that has the answer
     │  read backward (newest → oldest), ask "why, given inputs?"
     ▼
  EFFECT    tool_call_end: { results: [] }
     │  empty — but faithful. not the origin. keep going.
     ▼
  CAUSE     tool_call_start: { filter: { textContains: "..." } }
     │  ◄── Gemma hallucinated a filter key no chunk carries;
     │      exact-match → zero hits.  INPUT≠plausible OUTPUT → STOP.
     ▼
  CONFIRM   re-run query without filter → results return
     │
     ▼
  FIX+GUARD matchesFilter ignores absent keys + regression test  → see 06
```

## Elaborate

This is the same discipline as "reading a core dump" or "git bisect in reverse"
— start where it's broken, not where it started. It maps onto the scientific
method: the trajectory is your observation log, each backward step is a
hypothesis ("the empty result caused it" — rejected; "the filter caused the
empty result" — confirmed by the rerun). The agent-specific twist is that the
"buggy line" is a *model decision* (a hallucinated argument), so the fix lives in
making the *tool* robust to bad model inputs (`06`), not in fixing a line the
model can't see.

Read next: `06-hallucination-tolerant-retrieval-guard.md` (the fix + guard),
`03-durable-trajectory-supabase-sink.md` (why the args were there to read).

## Interview defense

**Q: An agent gives a wrong answer. Walk me through how you debug it.**
Read the persisted trajectory backward from the wrong answer. The final answer
was "not available" — faithful given the model saw an empty tool result. So go
up: the tool result was empty — but why? Up again: the `tool_call_start` args
showed a hallucinated `{textContains}` filter that exact-matched to zero hits.
That's the origin. Confirm by re-running without the filter.

```
  symptom ← empty result ← hallucinated filter args   (stop at the mismatch)
```

**Q: Why backward and not forward?**
Forward, you wade through dozens of faithful events before the defect. Backward,
you start at the one thing you *know* is wrong and follow causality straight to
the origin. Same reason you read a stack trace from the assertion up.

**Q: What made this trace debuggable when many aren't?**
It kept the *cause*, not just the effect — the tool-call args were persisted
(`03`), so the hallucinated filter was on disk. A log that stored only the
answer and the empty result would show a symptom with no visible reason. The one
thing I'd add: a zero-hit `warning` event so the cause flags itself instead of
needing four reads to find.

## See also

- `06-hallucination-tolerant-retrieval-guard.md` — the fix and the regression test.
- `03-durable-trajectory-supabase-sink.md` — the persisted args that made it work.
- `01-capability-event-trace.md` — the ordered event union being read.
- `audit.md` lens 7 (incident arc), lens 8 (the silent-empty blind spot).
- `superpowers:systematic-debugging` — the same discipline, generalized.
