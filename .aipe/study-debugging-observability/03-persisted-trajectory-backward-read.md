# Reading the persisted trajectory backward — the war story

*Industry names: durable audit trail · post-hoc trajectory analysis · "read the trace backward." Type: project-specific (buffr's SupabaseTraceSink + a diagnostic method).*

## Zoom out — where this lives

Studio's debugger (`02`) is ephemeral — close the tab, the trace is gone. For a bug that already happened in a real session, you need the trace to have been *written down*. buffr's `SupabaseTraceSink` does that: every `CapabilityEvent` becomes a row in Postgres, ordered so you can replay — or read backward — long after the run.

```
  Zoom out — the durable reader of the event stream

  ┌─ Runtime (aptkit) ──────────────────────────────────────────────┐
  │  runAgentLoop emits CapabilityEvent[]   (01)                     │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ sink.emit(event)  (sync, void)
  ┌─ Persistence (buffr) ─────▼──────────────────────────────────────┐
  │  ★ SupabaseTraceSink ★  queue → flush() → INSERT                 │
  │  supabase-trace-sink.ts:49-94                                    │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ rows, ordered by event timestamp
  ┌─ Storage (Postgres) ──────▼──────────────────────────────────────┐
  │  agents.messages   (sql/001_agents_schema.sql:40-50)             │
  │  role · content · tool_calls · tool_results · model · tokens_used│
  └───────────────────────────────────────────────────────────────────┘
```

## Zoom in — what it is

`SupabaseTraceSink` (`/Users/rein/Public/buffr/src/supabase-trace-sink.ts:49-94`) implements the `CapabilityTraceSink` contract by persisting *every* event variant — including the tool-call args (the cause) and durations/errors that earlier versions dropped — into `agents.messages`, stamped with the event's own timestamp so replay order matches emit order. The question it answers: *a session went wrong yesterday — show me exactly what the agent did, in order, so I can find the cause.*

## How it works — the debugging arc

This pattern is best taught as the incident it was built for. Four beats: symptom → evidence → root cause → fix → prevention.

### Symptom

The RAG agent (`packages/agents/rag-query/src/rag-query-agent.ts`) answered a question with the equivalent of *"that's not available in the knowledge base"* — `FALLBACK_ANSWER`, `:31` — on a corpus that plainly contained the answer. The final text was wrong, but the final text alone tells you nothing about *why*. You need the steps that led to it.

### Evidence — read the trajectory backward

Because the run was persisted, the trajectory existed in `agents.messages`. The diagnostic move: **start at the final answer and walk backward**, because the cause is upstream of the symptom.

```
  Read backward — symptom is last, cause is upstream

  agents.messages rows (ordered by created_at = event timestamp)

   row  role            content / payload
   ───  ──────────────  ────────────────────────────────────────────
   N    assistant       "not available..."        ◄─ symptom (start here)
   N-1  tool            search_knowledge_base → results: []   ◄─ empty!
   N-2  tool_call       search_knowledge_base                 │ walk
        args: { query: "...", filter: {textContains:"..."} } ◄┘ up
                                                  └─ THE CAUSE: a filter
   N-3  assistant       "I'll search the knowledge base"        no chunk
   ...                                                           carries
```

Row `N-2` is the `tool_call_start` event, persisted with its args (`supabase-trace-sink.ts:62-65`). The args showed Gemma had invented a `filter: {textContains: ...}` argument. Row `N-1`, the `tool_call_end`, showed `results: []`. The empty result wasn't a corpus problem — it was the filter.

This only worked because the sink persists the *cause*, not just the conversation. The code comment says it directly (`:39-48`): tool-call args, durations, errors, and token usage "were previously dropped on the floor; capturing them turns `agents.messages` into a complete, replayable trajectory." Drop the args and the backward read dead-ends at "the search returned nothing" with no explanation.

### Root cause

The retrieval tool applied the model's `filter` as an **exact match** over chunk metadata. No chunk carried a `textContains` key, and the original `matchesFilter` required every filter key to match — so a key that no chunk had zeroed every hit. The model hallucinated a plausible-looking filter; the filter silently wiped the corpus.

### Fix

Two commits. The primary, `c5dbf1a` ("Make search_knowledge_base filter robust to hallucinated keys"), rewrote `matchesFilter` to *ignore* keys absent from a chunk's meta (`packages/retrieval/src/search-knowledge-base-tool.ts:101-106`):

```ts
function matchesFilter(hit: VectorHit, filter: Record<string, unknown>): boolean {
  // A filter key only excludes hits that HAVE that key with a different value.
  // Keys absent from a chunk's meta are ignored, so a weak model's hallucinated
  // filter (e.g. {textContains: "x"}) can't silently wipe every result.
  return Object.entries(filter).every(([key, value]) => !(key in hit.meta) || hit.meta[key] === value);
}
```

The `!(key in hit.meta) ||` clause is the whole fix: an unknown key is a no-op, not an exclude. A sibling commit `f535e4a` floored `top_k` to `minTopK` (`:51`) so a weak model can't starve its own retrieval by asking for `top_k: 1` on a multi-part question.

### Prevention — the regression guard

The fix shipped with a test that encodes the exact failure (`packages/retrieval/test/search-knowledge-base-tool.test.ts:105-117`):

```ts
test('ignores filter keys absent from chunk metadata (a hallucinated filter does not wipe results)', async () => {
  // ...seed a 2-doc corpus...
  const { result } = await registry.callTool(SEARCH_KNOWLEDGE_BASE_TOOL_NAME, {
    query: 'how often does the moon orbit earth',
    filter: { textContains: 'moon' },          // the exact hallucinated key
  });
  assert.ok(payload.results.length > 0, 'hallucinated filter key should be ignored, not exclude everything');
});
```

The bug can never silently return. (Note the partition seam: the *test mechanism* — how fixtures and `node --test` work — belongs to `study-testing`; here the test matters only as the incident's prevention guard.)

## The mechanism that made the backward read possible

The arc above relied on the sink doing two non-obvious things right. Walk them.

**Sync emit, queued writes, one flush.** The contract says `emit` is synchronous and returns `void` (`01`). But a Postgres insert is async. The sink resolves this by queuing promises and awaiting them once, after the run:

```ts
// supabase-trace-sink.ts:49-94 (condensed)
export class SupabaseTraceSink implements CapabilityTraceSink {
  private readonly pending: Promise<void>[] = [];
  emit(event: CapabilityEvent): void {
    switch (event.type) {
      case 'tool_call_start':
        this.push(persistMessage(pool, convId, 'tool_call', event.toolName,
          { toolCalls: { toolName: event.toolName, args: event.args }, createdAt: event.timestamp }));
        return;
      // ...one case per variant; tool_call_end persists result+error+durationMs...
    }
  }
  private push(p: Promise<void>) { this.pending.push(p); }
  async flush(): Promise<void> { await Promise.all(this.pending); }  // awaited in session.ts:63
}
```

What breaks without the queue: `emit` would have to be async, violating the contract, and the loop would block on every DB write. The queue lets the sink obey a sync interface while doing async I/O.

**Order by event timestamp, not insert order.** The `pending` promises resolve in a *race* — concurrent inserts finish in arbitrary order. If `created_at` defaulted to `now()` at insert time, the persisted trajectory would be scrambled and the backward read would be meaningless. So `persistMessage` writes the *event's* timestamp (`supabase-trace-sink.ts:26-37`):

```ts
const createdAt = extra?.createdAt && extra.createdAt.length > 0 ? extra.createdAt : null;
// ...values (..., coalesce($8::timestamptz, now()))   ← event time wins; now() only as fallback
```

This is exactly why `01` insisted the timestamp is load-bearing. The async sink is the reason the field exists.

## Primary diagram

```
  Durable trajectory — emit, queue, flush, ordered rows

  ┌─ aptkit runtime ─┐ emit(event)   ┌─ buffr: SupabaseTraceSink ──────────┐
  │ runAgentLoop     │ ────────────► │ switch(type) → push(persistMessage) │
  │ (sync, void)     │  (sync)       │ pending: Promise<void>[]            │
  └──────────────────┘               │ flush() = await Promise.all(pending)│
                                     └──────────────────┬───────────────────┘
                       INSERT ... coalesce(eventTs, now())  (races to resolve)
  ┌─ Postgres: agents.messages ──────────────────────────▼───────────────────┐
  │ rows ORDERED BY created_at = event timestamp ► true emit order recovered  │
  │ tool_call row carries args (the cause) ──► read backward from final answer│
  └────────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

"Read the trace backward" is the standard incident-analysis move — start at the symptom (the wrong output), walk upstream until the last point where things were still correct, and the cause is the step in between. It generalizes far beyond agents: it's how you read a stack trace, a git bisect, a request log. What's specific here is that the "trace" is the agent's *decisions*, and the decision that mattered (the hallucinated filter) was only legible because the sink was deliberately changed to persist tool-call *args*, not just the human-readable conversation. The lesson the commit history teaches: **an audit log that records effects but not causes will dead-end every backward read.**

The deeper architectural point: aptkit's runtime defines the *contract* (`CapabilityTraceSink`), buffr supplies the *durable implementation*. aptkit never imports `pg`; buffr never reimplements the loop. The sink seam is what lets a deployment-agnostic toolkit get a Postgres audit log without either side knowing about the other.

## Interview defense

**Q: A user reports the agent gave a wrong answer in a session yesterday. Walk me through diagnosing it.**

Every session's trace was persisted to `agents.messages`, ordered by the event's own timestamp. I pull that conversation and read it *backward* from the final answer: the answer was a fallback "not available," the row above it was a `search_knowledge_base` result of `[]`, and the row above *that* — the `tool_call_start` — carried the args, which showed the model passed a hallucinated `filter` key. Empty results were a symptom; the filter was the cause.

```
  final answer (wrong)  ◄─ symptom
  tool result: []       ◄─ empty
  tool_call args: {filter:{textContains}}  ◄─ CAUSE
```

One-line anchor: *persist the cause (tool args), not just the conversation, and order by emit timestamp — then the backward read terminates at the real fault.*

**Q: Your sink's `emit` is synchronous but Postgres is async. How?**

`emit` pushes the insert promise onto a `pending` array and returns immediately, honoring the void contract; `flush()` awaits all of them after the run. And because those inserts race to resolve, I persist the *event's* timestamp into `created_at` (via `coalesce(eventTs, now())`), not insert time — otherwise the durable trajectory would be out of order and the backward read would be garbage. That timestamp is the load-bearing detail people forget.

## See also

- `01-capability-event-trace.md` — the contract and the timestamp this depends on.
- `04-silent-empty-result-blind-spot.md` — the contributing condition: the empty result was silent.
- `05-deterministic-replay-reproduction.md` — reproducing this bug offline.
- Cross-guide: `study-testing` owns the regression-test mechanism; `study-ai-engineering` owns the retrieval-quality fix; `study-data-modeling` owns the `agents.messages` schema.
