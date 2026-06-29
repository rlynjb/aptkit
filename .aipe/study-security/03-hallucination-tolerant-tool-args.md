# Hallucination-tolerant tool args

*Defensive argument handling for a weak model · Project-specific (input validation at the model→tool seam)*

## Zoom out, then zoom in

Here's the retrieval tool sitting at the bottom of the agent stack. The model calls `search_knowledge_base` and supplies the arguments — the query, a `top_k`, an optional `filter`. The question this concept answers: **what happens when the model supplies *bad* arguments?**

```
  Zoom out — where the hardening lives

  ┌─ Model layer ───────────────────────────────────────────┐
  │  Gemma emits: { tool, arguments: { query, top_k, filter }}│
  │  (weak local model — arguments may be wrong/hallucinated) │
  └───────────────────────────┬─────────────────────────────┘
  ┌─ Retrieval tool layer ────▼─────────────────────────────┐
  │  search_knowledge_base handler                          │ ← we are here
  │    ★ minTopK floor ★   ★ matchesFilter (lenient) ★       │
  └───────────────────────────┬─────────────────────────────┘
  ┌─ Vector store layer ──────▼─────────────────────────────┐
  │  pipeline.query → cosine search → ranked hits            │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: this is **input validation, but the untrusted input source is your own model.** You already do this with form inputs — clamp a quantity field so a user can't submit `0`, ignore unknown query params instead of erroring. Same move, except the "user" here is a weak local model (Gemma has no native tool-calling, so it guesses), and a bad argument doesn't just produce a 400 — it silently degrades the answer the user gets. The defense is to make the tool *tolerant*: clamp the dangerous argument, and interpret the optional one so leniently that a hallucinated value can't do harm.

## The structure pass

Layers: **model → tool → store**. Trace one axis — **trust** ("how much do we believe the argument?") — across the model→tool seam.

```
  axis traced = "do we trust the model's argument?"

  ┌─ model side ───┐    seam     ┌─ tool side ──────────┐
  │ top_k: 1       │ ════╪═════►  │ Math.max(1, minTopK) │
  │ filter:{bad:x} │ (clamped/    │ → floored to 4       │
  │                │  ignored)    │ → bad key IGNORED    │
  └────────────────┘             └──────────────────────┘
         ▲                                 ▲
         └──── same axis, two answers ──────┘
           → the handler is the seam: it distrusts
             the argument and repairs it, not rejects it
```

The seam is the tool handler. On the model side an argument is whatever the model emitted; on the tool side it's been clamped and sanitized. Trust flips here — and notice the design choice: it *repairs* bad input rather than rejecting it, because rejecting would just make the weak model retry with the same bad guess. Two repairs hang on this seam: the `minTopK` floor and the lenient `matchesFilter`. Both exist for the same reason — to stop the model from defeating its own retrieval.

## How it works

#### Move 1 — the mental model

The shape is **clamp-and-tolerate**: take each model-supplied argument, and instead of trusting it or rejecting it, transform it into something that can't hurt. A `top_k` gets floored. A `filter` gets applied so leniently that an unknown key is a no-op. The model can't starve its own search (too-small `top_k`) and can't wipe its own results (bogus filter key).

```
  Pattern — clamp the floor, ignore the unknown

   model says top_k=1          model says filter={textContains:"x"}
        │                              │
        ▼                              ▼
   topK = max(1, max(reqK, minTopK))   for each hit:
        = max(4) for rag-query           keep unless hit HAS that key
        → never starves                  with a DIFFERENT value
                                         → unknown key → no exclusion
```

#### Move 2 — the step-by-step walkthrough

**Step 1 — the floor stops self-starvation.** A weak model asked a multi-part question will sometimes pass `top_k: 1`, retrieve one chunk, and miss half the answer. The `minTopK` option floors it. From `packages/retrieval/src/search-knowledge-base-tool.ts:51` and `80-81`:

```ts
const minTopK = Math.max(1, options.minTopK ?? 1);   // floor for the floor
// ...inside the handler:
const requestedTopK =
  typeof args.top_k === 'number' && args.top_k > 0 ? args.top_k : defaultTopK;
const topK = Math.max(requestedTopK, minTopK);        // honor the floor
```

buffr wires this with `minTopK: 4` (`buffr/src/session.ts:43`). So even if Gemma asks for one result, it gets at least four. What breaks without the floor: the model passes `top_k: 1`, and a two-part question retrieves evidence for only one part — a silent quality failure, not a crash. Note the doc comment on the option (lines 37-40) names this exact cause: "stop a weak local model from starving its own retrieval."

**Step 2 — the type guards reject garbage shapes quietly.** Before using any argument the handler checks its type and falls back rather than throwing (lines 79-85):

```ts
const query = typeof args.query === 'string' ? args.query : '';
const filter =
  args.filter && typeof args.filter === 'object' && !Array.isArray(args.filter)
    ? (args.filter as Record<string, unknown>)
    : undefined;                                       // not an object → no filter
```

A non-string query becomes `''`; a filter that isn't a plain object becomes `undefined`. The tool degrades to a reasonable default instead of erroring back to the model (which would burn a turn from the bounded loop in `02`).

**Step 3 — the lenient filter can't wipe results.** This is the subtle one. A naive filter would exclude any hit that doesn't *match* every filter key. If the model hallucinates a key that no chunk has — `{textContains: "x"}` — a naive filter excludes *every* hit, and the model gets nothing. `matchesFilter` (lines 101-106) inverts the logic:

```ts
function matchesFilter(hit, filter): boolean {
  // A filter key only EXCLUDES hits that HAVE that key with a different value.
  // Keys absent from a chunk's meta are ignored, so a hallucinated filter
  // can't silently wipe every result.
  return Object.entries(filter).every(
    ([key, value]) => !(key in hit.meta) || hit.meta[key] === value);
}
```

Read it carefully: a hit passes the filter if, for every filter key, *either* the chunk doesn't have that key *or* it has it with the matching value. An unknown key (`textContains`) isn't in any chunk's `meta`, so `!(key in hit.meta)` is true and the hit survives. The filter only does work when the model names a *real* metadata key — exactly when filtering is legitimate.

```
  Layers-and-hops — a bad filter that does no harm

  ┌─ Model ──────┐ hop 1: search({ filter: {textContains:"x"} })  ┌─ Tool ───┐
  │ Gemma        │ ──────────────────────────────────────────►   │ handler  │
  └──────────────┘                                                └────┬─────┘
                  hop 4: ranked hits (filter was a no-op) ◄───────────┤
                                                              hop 2 │ over-fetch
  ┌─ Store ──────┐ hop 3: query(query, topK*4)                       ▼
  │ vector store │ ◄────────────────────────────────────────  matchesFilter:
  └──────────────┘                                             "textContains"
                                                               not in any meta
                                                               → keep all hits
```

**Step 4 — over-fetch covers the post-filter.** When a filter is present the handler fetches `topK * 4` then filters down to `topK` (lines 88-90), so a legitimate filter that excludes some hits can still return a full page. This keeps the floor (step 1) meaningful even under filtering.

#### Move 3 — the principle

When the producer of your inputs is unreliable — a weak model, a flaky upstream, a legacy client — validation isn't enough; you want *tolerance*. Clamp the argument that can starve the operation, and design the optional argument so its worst-case (a hallucinated value) is a no-op rather than a wipe. The general rule: make the failure mode of bad input "slightly worse result," never "no result" or "wrong result." That's the difference between a tool that survives a weak model and one that amplifies its mistakes.

## Primary diagram

```
  Hallucination-tolerant tool args — full picture

  ┌─ Model layer ───────────────────────────────────────────────┐
  │  search_knowledge_base({ query?, top_k?, filter? })          │
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ Tool handler ────────────▼───────────────────────────────────┐
  │  query  = string? : ''            (type guard)                │
  │  topK   = max(requested, minTopK) (FLOOR — no starvation)     │
  │  filter = object? : undefined     (type guard)                │
  │  fetchK = filter ? topK*4 : topK  (over-fetch for post-filter)│
  │  hits   = query(query, fetchK)                                │
  │  if filter: keep hit unless it HAS the key with a diff value  │
  │             (unknown key → no-op, can't wipe results)         │
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ Vector store ────────────▼───────────────────────────────────┐
  │  cosine search → ranked VectorHit[] → citations               │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is Postel's law ("be liberal in what you accept") applied to the model→tool seam, with a security flavor: the inputs are adversarial-by-incompetence rather than adversarial-by-intent, but the discipline is the same. It also connects to prompt-injection containment (`audit.md` lens 7): even an *intentionally* malicious filter argument can't exfiltrate or wipe data here, because the worst it does is widen or no-op the search. The pattern is project-specific — it exists because aptkit's default model is Gemma, which has no native tool-calling and is emulated (`packages/providers/gemma`). A frontier model with reliable tool-calling would need less of this; the toolkit hardens for the weak case so the same tool works across providers.

## Interview defense

**Q: Your local model is weak and passes bad tool arguments. How do you keep retrieval working?**
Treat the model's arguments as untrusted input and repair rather than reject. Two moves: floor `top_k` with `minTopK` (buffr uses 4) so a `top_k: 1` guess can't starve a multi-part question, and write the metadata filter so a hallucinated key is a no-op instead of a wipe — a hit is excluded only if it *has* the key with a different value.

```
   top_k=1     → max(1, minTopK=4) → 4 results, not 1
   filter={badKey:x} → key not in any chunk → excludes nothing
```
*Anchor: the failure mode of bad input is "slightly worse result," never "no result."*

**Q: Why not just validate and reject?** Rejecting throws the bad argument back to the model, which — being weak — retries with the same bad guess and burns a turn from the bounded loop. Repairing the argument in place gets a usable result on the first call. Validation is the right move when the producer can fix its input; tolerance is the right move when it can't.

## See also

- `02-bounded-agent-loop.md` — why a rejected/retried argument is costly (it burns a bounded turn).
- `01-tool-policy-least-privilege.md` — this hardens the one tool the rag-query agent is allowed to call.
- `audit.md` lens 3 (input validation) and lens 7 (LLM/agent security).
