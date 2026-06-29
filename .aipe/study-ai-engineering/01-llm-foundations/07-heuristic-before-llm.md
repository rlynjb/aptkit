# Heuristic before LLM — the cheap path first

**Subtitle:** keyword shortcut + model fallback · code → maybe model → answer · *Language-agnostic*

## Zoom out, then zoom in

Before you reach for the model, see that aptkit often answers without it — a plain
keyword check does the work, and the LLM is the fallback, not the default.

```
  Zoom out — where the cheap path sits

  ┌─ Capability (query agent) ──────────────────────────────────┐
  │  needs an Intent: monitoring / diagnostic / recommendation  │
  └───────────────────────────┬─────────────────────────────────┘
                              │ classifyIntent(model, query)
  ┌─ Routing ─────────────────▼─────────────────────────────────┐
  │  ★ parseIntent ★  pure keyword check — no model call        │ ← we are here
  └───────────────────────────┬─────────────────────────────────┘
                              │ only if needed
  ┌─ The model ───────────────▼─────────────────────────────────┐
  │  one-word classification — expensive, slower, stochastic    │
  └──────────────────────────────────────────────────────────────┘
```

Every model call costs tokens, latency, and a chance of being wrong. The
heuristic-before-LLM pattern asks: can a few lines of deterministic code answer
this? If yes, return immediately. If no, *then* pay for the model. In aptkit the
cleanest example is intent classification — and the same function `parseIntent`
plays two roles: the cheap shortcut *and* the parser that interprets the model's
answer when you do fall through.

## Structure pass

**Layers.** Cheap heuristic (`parseIntent` keyword check) → model call
(`classifyIntent`) → the same heuristic again (parsing the model's one-word reply).

**Axis — cost.** Trace what each layer spends. The heuristic costs a few string
`includes` calls — effectively free, fully deterministic. The model costs a
network round-trip, tokens, and nondeterminism. The pattern's whole job is to keep
the cheap layer in front so the expensive layer runs only when it must.

**Seam.** The flip is "do we trust code, or do we ask the model?" Below the seam,
deterministic and free. Above it, stochastic and metered. `parseIntent` guards
the seam from *both* sides — as the entry shortcut and as the exit parser.

## How it works

### Move 1 — the mental model

You know a cache check before a fetch: `if (cache.has(k)) return cache.get(k)`
then fall through to the network? Heuristic-before-LLM is that shape, where the
"cache" is a rule you can compute and the "network" is the model. Cheap, certain
answer first; expensive, uncertain answer only on a miss.

```
  cache-before-fetch, but the fetch is a model

  query ─► cheap rule matches? ─yes─► return (free, certain)
                  │ no
                  ▼
            call model ─► parse its answer with the SAME rule
```

### Move 2 — the moving parts

**The pure keyword heuristic.** `parseIntent` is just three `includes` checks with
a default. No model, no I/O, fully deterministic. From
`packages/agents/query/src/intent.ts:4`:

```ts
export function parseIntent(raw: string): Intent {
  const text = raw.trim().toLowerCase();
  if (text.includes('monitoring')) return 'monitoring';        // ← cheap, exact
  if (text.includes('recommendation')) return 'recommendation';
  if (text.includes('diagnostic')) return 'diagnostic';
  return 'diagnostic';                                          // ← safe default on no match
}
```

```
  parseIntent — the free path

  text.includes('monitoring')     ─► 'monitoring'
  text.includes('recommendation') ─► 'recommendation'
  text.includes('diagnostic')     ─► 'diagnostic'
  none                            ─► 'diagnostic'  (default, never throws)
```

**The model fallback — and the reuse.** `classifyIntent` calls the model only for
the hard cases, asks for exactly one word, then funnels that word back through the
*same* `parseIntent`. From `packages/agents/query/src/intent.ts:12`:

```ts
export async function classifyIntent(model, query, options = {}) {
  const response = await model.complete({
    system: 'Classify … as exactly one word: monitoring … diagnostic … recommendation …',
    messages: [{ role: 'user', content: query }],
    maxTokens: 16,                                             // ← bound the spend
    signal: options.signal,
  });
  const text = /* join text blocks */;
  return parseIntent(text);                                    // ← SAME heuristic parses the reply
}
```

```
  classifyIntent — the metered path, parsed by the cheap one

  query ─► model.complete (maxTokens:16) ─► "Diagnostic." (one wordish)
                                                  │
                                          parseIntent(text)
                                                  ▼
                                          'diagnostic'  (fuzz absorbed)
```

The elegance: the heuristic is the contract on both ends. The model is told to
emit a word `parseIntent` already understands, so even a sloppy "Diagnostic." or
"this is diagnostic" lands correctly. And if the model produces garbage, the
default branch still returns a valid `Intent` — the system never crashes on a bad
classification.

**A related guard worth naming.** The search tool applies cheap pre-checks too —
a `minTopK`/filter guard that bounds what it asks for before trusting model-driven
retrieval. Same family of idea ("cheap guard before trusting the model"), but
`parseIntent` is the canonical, clearest instance in the repo.

### Move 3 — the principle

Put a deterministic, free decision in front of every metered, stochastic one, and
reuse it as the parser for the model's reply so both paths converge on the same
small output space. The model becomes a fallback that upgrades hard cases, never
a tax on easy ones — and a forgiving parser means the model's output never has to
be exact.

## Primary diagram

```
  Heuristic-before-LLM routing

  query
    │
    ▼
  ┌─────────────────────────┐   match
  │ parseIntent (keywords)  │ ───────► Intent   (free path, exits here when obvious)
  └───────────┬─────────────┘
              │ ambiguous / need the model
              ▼
  ┌─────────────────────────┐
  │ model.complete (16 tok) │ ──► one-word reply
  └───────────┬─────────────┘
              ▼
  ┌─────────────────────────┐
  │ parseIntent (REUSED)    │ ───────► Intent   (default-safe, never throws)
  └─────────────────────────┘
   cheap & certain in front   │   metered & stochastic only on the hard cases
```

## Elaborate

This is the routing pattern behind every cost-and-latency-conscious AI system:
classifier-before-generator, cache-before-call, regex-before-LLM. The discipline
is to keep the heuristic *honest* — it must be either confidently right or
explicitly defer, never silently wrong. aptkit's `parseIntent` defers safely by
defaulting to `diagnostic`, the most general intent. Read `03-sampling-
parameters.md` for why the one-word task is near-deterministic without a
temperature lock, and `06-token-economics.md` for what each avoided model call
saves.

## Project exercises

### Add a confident-shortcut path to classifyIntent
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** in `classifyIntent`, run `parseIntent(query)` first and return
  immediately when the query *itself* contains an unambiguous keyword, only calling
  the model on a miss — with tests proving the model is never called for an obvious
  query.
- **Why it earns its place:** makes the heuristic an actual short-circuit (right
  now it's only the parser), which is the cost-saving half of the pattern.
- **Files to touch:** `packages/agents/query/src/intent.ts`,
  `packages/agents/query/test/intent.test.ts`.
- **Done when:** a fixture model with a spy proves zero model calls for keyword-
  obvious queries and one call otherwise.
- **Estimated effort:** `1–4hr`

### Make the default branch observable
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** when `parseIntent` hits the default branch on a *model* reply
  (i.e. the model said something off-vocabulary), emit a `warning` event so weak
  classifications are visible in the trace.
- **Why it earns its place:** a silent default hides model drift; surfacing it is
  the observability instinct that separates toy code from production.
- **Files to touch:** `packages/agents/query/src/intent.ts`, matching `test/`.
- **Done when:** an off-vocabulary model reply produces a warning; a clean reply
  produces none.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "Why not just always ask the model to classify intent?"**
Because most queries are answerable by a keyword check that's free, instant, and
deterministic. The model is the fallback for ambiguity, capped at 16 tokens. You
don't pay latency, tokens, and nondeterminism for cases a rule already nails.

```
  always-model:  every query → round-trip + tokens + maybe wrong
  heuristic-1st: obvious → free rule;  hard → model (bounded)
```
Anchor: *the model is a fallback for hard cases, not a tax on easy ones.*

**Q: "The model replied 'Diagnostic.' with a period — does that break it?"**
No. The model's reply goes back through the same `parseIntent` that does
`includes('diagnostic')`, so punctuation and casing are absorbed, and anything
unrecognized defaults to a valid intent. The heuristic is forgiving by design.

```
  "Diagnostic." ─► toLowerCase + includes('diagnostic') ─► 'diagnostic'
  garbage       ─► default branch ─► 'diagnostic' (never throws)
```
Anchor: *one forgiving parser guards both the shortcut and the model's reply.*

## See also

- `03-sampling-parameters.md` — why the one-word classify task is near-deterministic
- `06-token-economics.md` — the cost each skipped model call avoids
- `04-structured-outputs.md` — the heavier cousin when the reply must be JSON
