# Error recovery in agents

**Subtitle:** Agent error handling / robustness · bounded loop + tolerant tools · *Industry standard*

## Zoom out, then zoom in

Agents fail in more ways than chains — the model loops, a tool errors, the model
emits a bad call, the loop never terminates. aptkit's recovery lives in two places:
the bounded agent loop (which caps the failure), and the search tool (which
tolerates a weak model's bad arguments). This file is also where the repo's
signature bug lives.

```
  Zoom out — where recovery sits

  ┌─ Agent loop (run-agent-loop.ts) ───────────────────────────┐
  │  ★ maxTurns / maxToolCalls / forced synthesis / recovery ★ │ ← cap the failure
  └───────────────────────────┬─────────────────────────────────┘
                              │ callTool
  ┌─ Tools ───────────────────▼─────────────────────────────────┐
  │  search_knowledge_base: ★ minTopK floor + tolerant filter ★  │ ← tolerate bad args
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. The interesting recovery here isn't "catch the exception" — it's the
two failure modes a *weak local model* creates that a strong model wouldn't, and
the specific guards aptkit added after hitting them in practice. One of them (the
hallucinated filter) is the clearest "I built this and it broke in a way I had to
diagnose" story in the codebase.

## Structure pass

**Layers.** Loop (bounds turns/calls) → tool registry (runs tools, catches errors)
→ individual tool (guards its own inputs).

**Axis — failure containment.** Where does a failure get contained? Trace it: a
tool *exception* is caught in the loop and passed back to the model as an
observation (`run-agent-loop.ts:163`); a *runaway loop* is contained by
`maxTurns`/`maxToolCalls`; a *bad argument* is contained inside the tool itself
(`matchesFilter`, `minTopK`). Each failure is contained at the lowest layer that
can see it.

**Seam.** `tools.callTool(name, args)` (`run-agent-loop.ts:159`). On one side the
loop, which never trusts a call to succeed; on the other the tool, which never
trusts its args. Both sides assume the other can be wrong — that mutual distrust
is the recovery design.

## How it works

### Move 1 — the mental model

Think of the agent loop like a `for` loop with a hard iteration cap and a
try/catch around the body — because a model deciding its own steps is exactly a
loop whose termination you don't control. You add the cap so it *can't* run
forever, and the catch so one bad step doesn't kill the run.

```
  Agent recovery — the kernel

  for turn in 0..maxTurns:                  ← hard cap (can't loop forever)
    response = model(...)
    if no tool calls: finalText = text; break
    for each tool call:
      try: result = callTool(...)           ← catch → pass error to model
      catch: result = {error}               ← model retries or picks another tool
    if budget spent: force a final answer   ← maxToolCalls + synthesis
```

### Move 2 — the recovery mechanisms

**Mechanism 1 — bounded turns and tool calls.** The loop runs at most `maxTurns`
times, and once `maxToolCalls` is spent it stops offering tools
(`run-agent-loop.ts:101`):

```ts
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,   // drop tools on the final turn
  ...
});
```

Dropping `tools` on the final turn is the trick: with no tools available, the model
*must* produce a text answer. The rag-query agent sets `maxTurns: 6, maxToolCalls: 4`
(`rag-query-agent.ts:75`) — generous enough for multi-step retrieval, tight enough
to bound cost.

```
  Bounded loop — forced termination

  turn 0..4: tools offered, model may search
  budget hit (4 calls) OR turn 5: forceFinal
       │ tools = undefined + synthesisInstruction appended
       ▼
  model has no tools → must answer in text → loop ends
```

**Mechanism 2 — forced synthesis.** When the loop forces a final turn, it also
appends a synthesis instruction (`buildSynthesisInstruction`, `run-agent-loop.ts:72`):
"You have NO more tool calls available. … Do not say you need more queries." Without
it, a weak model on its last turn often replies "let me search again" — and there's
no turn left. The instruction converts the dead end into an answer.

```
  Forced synthesis — convert dead-end into answer

  last turn, no tools  ─►  system += "NO more tool calls; answer now; don't ask for more"
                              │
                              ▼
                       model writes the final grounded answer
```

**Mechanism 3 — tool error as observation.** When a tool throws, the loop doesn't
crash — it catches and feeds the error back to the model as a `tool_result` with
`isError` (`run-agent-loop.ts:163`):

```ts
try {
  const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
  toolCall.result = result; resultContent = truncate(JSON.stringify(result));
} catch (error) {
  isError = true;
  toolCall.error = error instanceof Error ? error.message : String(error);
  resultContent = truncate(JSON.stringify({ error: toolCall.error }));   // model SEES the error
}
```

The model reads the error on its next turn and can retry or pick a different tool —
ReAct's "observation" step doing recovery work. (Note `truncate` also caps results
at 16k chars so a huge result can't blow the context window.)

```
  Tool error → observation

  callTool throws ─► catch ─► tool_result {isError:true, content:{error}}
                                   │ appended as a message
                                   ▼
                          model reads error → retry / switch tool
```

**Mechanism 4 — the hallucinated-filter bug (the signature story).** The
`search_knowledge_base` tool accepts an optional `filter` (exact-match over chunk
meta). A weak local model would *hallucinate* a filter key — e.g.
`{textContains: "ORM"}` — that no chunk's meta actually has. The naive
implementation (`hit.meta[key] === value` for every filter key) then excluded
*every* chunk, because no chunk has a `textContains` key. Retrieval returned empty;
the agent answered "I couldn't find anything" on a corpus that clearly had the
answer. The fix (`search-knowledge-base-tool.ts:101`):

```ts
function matchesFilter(hit, filter) {
  // A filter key only EXCLUDES hits that HAVE that key with a different value.
  // Keys absent from a chunk's meta are ignored, so a weak model's hallucinated
  // filter (e.g. {textContains: "x"}) can't silently wipe every result.
  return Object.entries(filter).every(
    ([key, value]) => !(key in hit.meta) || hit.meta[key] === value
  );
}
```

The flip is `!(key in hit.meta) ||` — an absent key passes instead of failing. A
real filter (`{docId: "setup.md"}`) still works because chunks *have* `docId`; a
hallucinated key is simply ignored. The tool also over-fetches `topK * 4` when
filtering (`:88`) so the post-filter still has candidates to return.

```
  The filter bug and the fix

  model hallucinates filter {textContains:"ORM"}  (no chunk has this key)

  BEFORE: every chunk lacks 'textContains' → fails equality → 0 results ✗
  AFTER:  key absent from meta → IGNORED → real ranking survives ✓

  guard: matchesFilter ignores keys no chunk carries
```

**Mechanism 5 — the `minTopK` floor.** A related weak-model failure: the model
passes `top_k: 1`, starving a multi-part question of context. The tool floors it
(`search-knowledge-base-tool.ts:81`): `topK = Math.max(requestedTopK, minTopK)` —
so the model can't shrink retrieval below a safe minimum.

### Move 3 — the principle

Recovery in an agent is *defense in depth against a model you don't control*. Bound
the loop so it can't run forever; force a final answer so it can't dead-end; feed
tool errors back so one failure isn't fatal; and make tools tolerant of the bad
arguments a weak model will pass. The hallucinated-filter fix is the lesson in
miniature: don't trust the model's arguments to be sane — make the tool degrade to
"ignore the nonsense" instead of "return nothing."

## Primary diagram

```
  Agent error recovery — all five mechanisms

  ┌─ Agent loop ───────────────────────────────────────────────────────┐
  │  [1] maxTurns / maxToolCalls — hard caps                            │
  │  [2] forceFinal: drop tools + synthesisInstruction — no dead-ends   │
  │  [3] callTool in try/catch → error becomes a tool_result observation│
  │      (+ truncate to 16k so a big result can't blow the window)      │
  └───────────────┬─────────────────────────────────────────────────────┘
                  │ search_knowledge_base
  ┌─ Tool guards ─▼─────────────────────────────────────────────────────┐
  │  [4] matchesFilter — absent filter keys IGNORED (hallucination-safe) │
  │  [5] minTopK — floor top_k so the model can't starve retrieval       │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

Most agent-recovery writing assumes a strong model that mostly behaves. aptkit's
recovery is shaped by the opposite assumption — a 9B local model that frequently
misbehaves — which makes the guards unusually concrete and the failure modes
unusually real. The filter bug is the kind of thing you only find by running the
thing: retrieval "worked" (no error, returned a valid empty list) but answers were
wrong. The fix turned a silent correctness bug into a tolerated no-op. There's also
a structured-output recovery turn (`run-agent-loop.ts:204`, `runRecoveryTurn`) that
re-prompts once for a clean structured answer when parsing fails. Read
`02-tool-calling.md` for the provider-side retries and
`05-evals-and-observability/01-eval-set-types.md` for how a bug like this becomes a
frozen regression test.

## Project exercises

### Freeze the hallucinated-filter case as a regression test
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a unit test that indexes a small corpus, calls the search tool
  with a hallucinated filter (`{textContains: "x"}`), and asserts the ranked
  results survive (not empty) — locking the `matchesFilter` behavior so a refactor
  can't reintroduce the bug.
- **Why it earns its place:** turning a real production bug into a frozen
  regression case is the single most credible testing story you can tell; it shows
  the eval loop closing on a real defect.
- **Files to touch:** `packages/retrieval/test/search-knowledge-base-tool.test.ts`,
  reading `packages/retrieval/src/search-knowledge-base-tool.ts`.
- **Done when:** the test fails against the naive `hit.meta[key] === value`
  implementation and passes against the shipped `!(key in hit.meta) ||` one.
- **Estimated effort:** `1–4hr`

### Add a repeated-tool-call detector to the loop
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** detect when the model calls the same tool with the same args N
  turns in a row and inject a "try a different approach" message (a recovery the
  loop doesn't have today — it only bounds total calls).
- **Why it earns its place:** "LLM loops on the same tool" is a named failure mode
  the bounded counter doesn't address; handling it shows you recognize *kinds* of
  loops, not just total count.
- **Files to touch:** `packages/runtime/src/run-agent-loop.ts`,
  `packages/runtime/test/`.
- **Done when:** a fixture that repeats one call triggers the nudge before
  `maxToolCalls` is hit.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "Tell me about a real bug you found and fixed in your AI system."**
The search tool let the model pass a metadata `filter`. A weak local model would
hallucinate a filter key no chunk actually has — `{textContains: "ORM"}` — and the
naive exact-match check excluded every chunk, so retrieval returned empty and the
agent said "I couldn't find anything" on a corpus that had the answer. No error, no
crash — a silent correctness bug. The fix: ignore filter keys absent from a chunk's
meta, so a hallucinated key is a no-op while real filters still work. Then I froze
it as a regression test.

```
  hallucinated {textContains}  →  before: 0 results (silent)  →  after: ignored, ranking survives
  matchesFilter: !(key in meta) || meta[key]===value
```
Anchor: *don't trust the model's args — degrade to "ignore nonsense," not "return nothing."*

**Q: "How does your agent loop guarantee it terminates and answers?"**
Three bounds. `maxTurns` caps iterations. `maxToolCalls` caps tool use; once spent,
the loop drops the `tools` array so the model *must* answer in text. And a
synthesis instruction on the final turn tells it "no more calls — answer now," so a
weak model can't dead-end with "let me search again." Tool exceptions are caught and
fed back as observations rather than crashing the run.

```
  cap turns + cap calls + drop tools on final turn + "answer now" = always terminates with an answer
```
Anchor: *bounded loop + forced synthesis — the loop can't run forever or dead-end.*

## See also

- `02-tool-calling.md` — provider-side retries (Gemma nudge)
- `03-react-pattern.md` — the observation step that consumes tool errors
- `04-tool-routing.md` — least-privilege limits the blast radius of a bad call
- `03-retrieval-and-rag/11-rag.md` — the pipeline the filter guards protect
- `05-evals-and-observability/01-eval-set-types.md` — the regression set
