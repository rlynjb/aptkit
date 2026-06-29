# Sampling parameters

Sampling parameters · temperature/top-p/top-k (Industry standard)

The model outputs a probability distribution over the next token, every step. Sampling parameters decide how you pick from that distribution. Temperature flattens or sharpens it; top-p and top-k clip the tail before you draw. aptkit exposes `temperature` and threads it through; it leaves top-p and top-k at provider defaults. For analytics that's the right call — you want the same answer twice.

## Zoom out, then zoom in

The knobs live on the request, set by capabilities, honored by the model.

```
aptkit — where sampling is decided
┌─────────────────────────────────────────────┐
│ Capability (analytics / RAG)                  │  wants determinism
├─────────────────────────────────────────────┤
│ ★ ModelRequest.temperature, maxTokens         │  ← you are here
├─────────────────────────────────────────────┤
│ Adapter → vendor API (top_p/top_k = defaults) │  unset, pass-through
├─────────────────────────────────────────────┤
│ Model — samples next token from distribution  │
└─────────────────────────────────────────────┘
```

The pattern is "tune randomness at the call site." The question: *how much should the model improvise?* For a UI dropdown you don't want random options; for a brainstorm you do. aptkit's analytics agents are the dropdown — they want `temperature: 0`, the most boring, most repeatable pick. Like a `.sort()` with a stable comparator: same input, same order, every time.

## Structure pass

The capability sets the knob, the request carries it, the model samples. Trace the **control** axis — who decides how random the output is.

```
CONTROL axis — who sets randomness?
Layer                    sets temperature?   sets top_p/top_k?
──────────────────────────────────────────────────────────────
Capability               yes (per task)      no
ModelRequest             carries it          carries nothing ←★ seam
Adapter / vendor          forwards it         uses vendor DEFAULT
Model                    samples accordingly
```

The seam is `ModelRequest`. Temperature flows through it end to end; top-p/top-k fall off here because aptkit's request type doesn't carry them. So control over the tail-clipping knobs is *not* in your hands — it's whatever the vendor defaults to. That's the honest gap and the exercise target.

## How it works

**Mental model.** Picture the next-token distribution as a bar chart of probabilities. Temperature reshapes the bars; top-k keeps the tallest k bars; top-p keeps the smallest set of bars whose probabilities sum to p. Then you sample from what's left.

```
Next-token distribution, "The sky is ___"
  P │ blue ████████  (0.6)
    │ grey ███       (0.2)
    │ clear ██       (0.1)
    │ falling █      (0.05)  ...long tail
    └──────────────────────────
  temperature ↓0  → always "blue" (argmax, deterministic)
  temperature ↑1  → bars flatten, tail gets a real shot (creative/risky)
  top_k = 2        → only {blue, grey} survive, sample among them
  top_p = 0.8      → smallest set summing to 0.8 = {blue, grey}, sample among them
```

**Temperature is the one knob aptkit actually drives.** It's a plain field on the request, set by whatever capability builds the call.

```ts
// packages/runtime/src/model-provider.ts:39-46  (ModelRequest)
maxTokens?:   number;     // output length cap (cost + window)
temperature?: number;     // 0 = deterministic argmax ... 1 = flat/creative
// note: no top_p, no top_k here — that's the gap
```

`temperature: 0` means "always take the tallest bar" — argmax, no dice roll. That's what you want behind a typed JSON contract: re-running the same analytics prompt should give the same JSON. (Caveat worth saying out loud: temp 0 is *near*-deterministic, not a cryptographic guarantee — floating-point ties and batching can still wobble. Close enough for analytics.)

**maxTokens is the other half of the budget knob.** It caps output length, which is both a cost lever (see `06-token-economics.md`) and a window lever (see `02-tokenization.md` — the guard reserves 768 for output).

```
temperature  → SHAPE of output  (how surprising)
maxTokens    → AMOUNT of output (how long, hard ceiling)
              both ride on the same ModelRequest
```

**Where top-p/top-k went.** They didn't. aptkit forwards `temperature`, and the adapter passes it to `client.messages.create` (Anthropic) or `chat.completions` (OpenAI), but never sets `top_p`/`top_k`. So those use the vendor's default sampling. For deterministic structured output, temperature 0 dominates anyway — once you're taking argmax, tail-clipping is moot. The gap only bites when you *want* controlled creativity (temp > 0 but bounded tail), which aptkit's analytics surfaces don't ask for. Top-p/top-k pass-through is **not yet exercised**.

**The principle.** Match randomness to the task, and default to the most boring setting that works. Determinism is a feature, not a limitation, for anything feeding a typed contract or a cache. You add entropy on purpose, where a human wants variety — never by accident.

## Primary diagram

The full path: capability picks a temperature, request carries it, model samples, top-p/top-k ride the vendor default.

```
Sampling, end to end
  Capability: "analytics → temperature: 0"
        │
        ▼
  ModelRequest { temperature: 0, maxTokens: N }   ← top_p/top_k absent
        │
        ▼  complete()
  Adapter → vendor API (forwards temp; top_p/top_k = vendor default)
        │
        ▼
  Model: distribution ── temp 0 ──▶ argmax ──▶ same token every run
                          (no tail-clip control reaches here from aptkit)
```

The dashed absence of top-p/top-k is the whole gap: aptkit controls *how flat*, never *how clipped*.

## Elaborate

These knobs come straight from the decoder's sampling step. Temperature divides the logits before softmax (T→0 sharpens to argmax, T→∞ flattens to uniform). Top-k (Fan et al.) and nucleus/top-p sampling (Holtzman et al.) are tail-truncation strategies that kill the "degenerate long tail" of low-probability garbage. Modern APIs also expose `seed`, `frequency_penalty`, and `presence_penalty` — none wired in aptkit. Read `04-structured-outputs.md` next: temperature 0 is the quiet partner of the validated-JSON retry loop. Then `06-token-economics.md` for how `maxTokens` maps to spend.

## Project exercises

### Thread top_p and top_k through the request

- **Exercise ID:** `EX-LLM-03a`
- **What to build:** Add optional `topP?` and `topK?` fields to `ModelRequest`, then forward them in the OpenAI and Anthropic adapters (`top_p` / `top_k`), leaving them undefined when unset so vendor defaults still apply.
- **Why it earns its place:** Phase 1 wants you to own the full sampling surface, not just temperature. You'll learn the adapter discipline — "only send a param when the caller set it" — and why bolting on a knob touches the port type plus every adapter, the cost of a leaky abstraction.
- **Files to touch:** `packages/runtime/src/model-provider.ts` (39-46, the `ModelRequest` type); `packages/providers/anthropic/src/anthropic-provider.ts` (28-61); `packages/providers/openai/src/openai-provider.ts`.
- **Done when:** setting `topP: 0.5` on a request reaches the vendor call, leaving it unset sends no `top_p` field, and a unit test pins both behaviors.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: Why temperature 0 for the analytics agents?**

```
  temp 0  → argmax → same JSON every run → cacheable, testable, contract-safe
  temp 1  → samples tail → JSON shape might drift → retries, flaky evals
            └ wrong tool for a typed boundary
```

Because the output feeds a typed contract and an eval — you need the same input to give the same output. Anchor: *determinism is a feature when a schema is downstream.*

**Q: Does aptkit control top-p and top-k?**

```
  ModelRequest:  temperature ✓ ──▶ vendor
                 top_p / top_k  ✗ ──▶ (vendor default)
                 └ no field exists to carry them
```

No — only temperature and maxTokens are threaded; top-p/top-k fall to vendor defaults because the request type doesn't carry them. With temp 0 that's harmless; for bounded creativity it's the gap. Anchor: *aptkit tunes how flat, not how clipped.*

## See also

- [`04-structured-outputs.md`](./04-structured-outputs.md) — temperature 0 as the partner of validated JSON.
- [`02-tokenization.md`](./02-tokenization.md) — `maxTokens` against the context window.
- [`06-token-economics.md`](./06-token-economics.md) — `maxTokens` as a cost lever.
