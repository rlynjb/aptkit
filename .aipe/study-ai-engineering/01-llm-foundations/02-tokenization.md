# Tokenization

Tokenization · BPE (Industry standard)

The model doesn't see characters. It sees tokens — sub-word chunks from a fixed vocabulary. "tokenization" is one token; "aptkit" is probably three. Roughly 4 characters per token in English. aptkit never runs a real tokenizer; it *estimates* with a character ratio. That's a deliberate cheap approximation, and you should know exactly where it's lying.

## Zoom out, then zoom in

Tokenization sits just below the model boundary, inside the context-window guard that decides whether a request even gets sent.

```
aptkit — where tokens get counted
┌─────────────────────────────────────────────┐
│ Capability / agent loop                       │
├─────────────────────────────────────────────┤
│ ModelProvider.complete(request)               │
├─────────────────────────────────────────────┤
│ ★ ContextWindowGuard — estimate token count  │  ← you are here
│    Math.ceil(text.length / charsPerToken)     │
├─────────────────────────────────────────────┤
│ The model (its real BPE tokenizer)            │  ← the truth
└─────────────────────────────────────────────┘
```

The pattern is "estimate the cost of input before paying for it." The question: *will this request fit in the model's context window?* aptkit answers it with division, not a tokenizer. Think of it like `string.length` as a stand-in for rendered pixel width — close enough to lay out a flex row, wrong enough to clip an emoji. Same trade here.

## Structure pass

Two layers care about token count: the guard (estimates) and the model (knows). Trace the **trust** axis.

```
TRUST axis — how accurate is the count?
Layer                     count source            trust
──────────────────────────────────────────────────────
ContextWindowGuard        chars / 3 (ceil)        approximate ←★ seam
The model's tokenizer      real BPE merge          exact
```

The seam is the guard. Above it everyone treats the number as truth; below it the model has the real count. The guard divides by 3 (not 4) on purpose — undercounting chars-per-token means *overcounting* tokens, so it errors toward "too big, reject early" rather than "looked fine, blew the window mid-call." Conservative by construction.

## How it works

**Mental model.** A tokenizer is a greedy merge over a learned vocabulary (BPE — byte-pair encoding): start from bytes, repeatedly merge the most frequent adjacent pair into one token. Common words become single tokens; rare ones shatter. aptkit skips all of that and just divides character count by a constant.

```
What a real tokenizer does vs what aptkit does
  "tokenization"
    real BPE  → ["token","ization"]      = 2 tokens   (exact)
    aptkit    → 12 chars / 3 = 4         = 4 tokens   (estimate)
                                            └ wrong, but on the safe side
```

**The estimate is one line.** Here's the entire "tokenizer" in aptkit.

```ts
// packages/providers/local/src/context-window-guard.ts:91-103
function estimateTokens(text: string, charsPerToken = 3): number {
  return Math.ceil(text.length / charsPerToken);   // chars → tokens, ceil up
}
// default 3 chars/token is deliberately LOW → estimate runs HIGH → reject early
```

No vocabulary, no merges, no language awareness. `text.length` is JS string length (UTF-16 code units, not even bytes). It's a ruler made of "divide by 3."

**The guard spends the estimate as a budget.** The estimate feeds a window check that decides go/no-go before any network call.

```
ContextWindowGuard.complete()
  estimate input tokens ─┐
                         ▼
  availableInput = maxTokens − outputReserve(768)
                         │
        estimate > availableInput ?
            yes ─▶ throw ContextWindowExceededError  (never call model)
            no  ─▶ delegate to wrapped provider       (pay for the call)
```

```ts
// packages/providers/local/src/context-window-guard.ts:73-89  (estimateContextWindow)
const availableInputTokens = maxTokens - outputReserve;  // reserve 768 for the reply
if (estimatedInputTokens > availableInputTokens) throw new ContextWindowExceededError(...);
```

The 768-token `outputReserve` is the room kept for the model's *answer* — input + output share one window, so you can't fill it all with prompt. That's the same reasoning as not filling a fixed-height container with content and leaving nothing for the footer.

**The principle.** Estimate cost before paying it, and when you estimate, round in the direction of the cheaper failure. A wrong-but-conservative number that rejects a too-big request locally beats an exact number you only learn from a 400 error after spending the round trip. The honest cost: short repetitive text (lots of single-token words) gets over-counted and might be rejected when it'd actually fit. A real tokenizer is **not yet exercised** in aptkit.

## Primary diagram

The full path from text to a go/no-go decision, all on the estimate.

```
Tokenization in aptkit (estimate-only)
  request text
      │  length (UTF-16 units)
      ▼
  Math.ceil(len / 3)  ── estimatedTokens ──┐
                                            ▼
  maxTokens − 768 reserve = availableInput
                                            │
                        estimated > available ?
                         ┌─────────┴─────────┐
                        yes                  no
                         │                    │
            ContextWindowExceededError    complete() the real model
            (no tokens spent)             (model's real BPE applies)
```

Only past the green branch does a real tokenizer ever run — inside the model, invisible to aptkit.

## Elaborate

BPE is the dominant scheme (GPT, Claude, Llama all use byte-level variants); SentencePiece is the other common family. Real tokenizers ship as libraries: `tiktoken` (OpenAI's, exact for GPT models) and the Llama/Gemma tokenizers (for the local models aptkit actually calls via Ollama). The gap between estimate and truth grows for code, non-English text, and JSON — all of which tokenize *worse* than prose, so the 3-char ratio is friendliest exactly where aptkit's analytics payloads are. Read `06-token-economics.md` for what these counts cost in dollars, and `01-what-an-llm-is.md` for why the model only ever sees tokens.

## Project exercises

### Wire a real tokenizer behind the guard

- **Exercise ID:** `EX-LLM-02a`
- **What to build:** Replace `estimateTokens`'s char-ratio with a real tokenizer for the local path — pull in the Llama/Gemma tokenizer (or `tiktoken` for the OpenAI provider) and count actual tokens, keeping the char-ratio as a fallback when no tokenizer is registered for a model.
- **Why it earns its place:** This is the canonical Phase 1 accuracy upgrade. You'll see firsthand how far "divide by 3" drifts from truth on JSON and code, and you'll learn that a window guard is only as good as its counter.
- **Why it earns its place:** also forces you to handle the "unknown model → which tokenizer?" lookup, the same dispatch problem providers solve.
- **Files to touch:** `packages/providers/local/src/context-window-guard.ts` (lines 91-103 estimate, 73-89 window math).
- **Done when:** counting a known string matches the tokenizer's own count exactly, the char-ratio still runs when a model has no registered tokenizer, and the `ContextWindowExceededError` boundary now fires on true token count.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: Why divide by 3 and not 4, if English is ~4 chars/token?**

```
  divide by 4 → estimate LOW  → think it fits → window blows mid-call (bad)
  divide by 3 → estimate HIGH → reject early  → safe, occasionally over-cautious (ok)
                                  └─ aptkit picks this
```

To bias the error toward rejecting borderline requests locally instead of failing them remotely after paying. Anchor: *round toward the cheaper failure.*

**Q: Is aptkit's token count accurate?**

```
  aptkit:  chars / 3        (no vocabulary, no merges)   ≈ approximate
  model:   real BPE merge   (exact)                      = truth
           └ aptkit never sees this number until the model replies
```

No — it's a deliberate estimate that never runs a real tokenizer; the true count only exists inside the model. Anchor: *aptkit measures with a ruler, not a tokenizer.*

## See also

- [`06-token-economics.md`](./06-token-economics.md) — what these token counts cost.
- [`01-what-an-llm-is.md`](./01-what-an-llm-is.md) — why the model only ever sees tokens.
- [`08-provider-abstraction.md`](./08-provider-abstraction.md) — the guard as a decorator on a provider.
