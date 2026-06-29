# Tokens — the unit the model does math on

**Subtitle:** Tokenization · text ↔ integer ids · *Industry standard*

## Zoom out, then zoom in

Before you reason about cost, context limits, or "why did it cut off," you need
to see where text stops being characters and becomes numbers. That conversion
sits below your code, at the very edge of the model.

```
  Zoom out — where tokenization sits

  ┌─ Your code (strings) ───────────────────────────────────────┐
  │  prompts, messages, system text — all JS strings            │
  └───────────────────────────┬─────────────────────────────────┘
                              │ ModelRequest.messages (strings)
  ┌─ Provider adapter ────────▼─────────────────────────────────┐
  │  aptkit only ESTIMATES tokens (charsPerToken=3)             │ ← we are here
  └───────────────────────────┬─────────────────────────────────┘
                              │ HTTP to Ollama / SDK
  ┌─ The model ───────────────▼─────────────────────────────────┐
  │  ★ tokenizer ★  string → [int, int, …] → predict → ints     │
  └──────────────────────────────────────────────────────────────┘
```

Here's the thing your frontend instincts get wrong: the model never sees your
string. It sees a list of integers. A tokenizer chops the string into chunks
("token"-sized pieces, roughly 4 characters of English each) and maps each chunk
to an id in a fixed vocabulary. The model does all its math on those ids and
emits ids back, which get decoded to text. Every limit you'll ever hit — context
window, max output, price — is counted in *tokens*, not characters, not words.

## Structure pass

**Layers.** String (your code) → token estimate (aptkit adapter) → real
tokenizer (inside the model, you never touch it) → integer ids (model math).

**Axis — precision.** Trace how exact the count is as you go down. Your code
knows the string exactly. aptkit's adapter only *estimates* — it divides
character length by 3. The real tokenizer inside Gemma/Claude is exact, but
aptkit never calls it. So precision gets *worse* before it would get better.

**Seam.** The flip is at the provider adapter. Above it, aptkit guesses token
counts with a constant. Below it (inside the model host), a real tokenizer runs —
but that boundary is opaque to aptkit. The honest count only comes *back* in the
response `usage`, after the call.

## How it works

### Move 1 — the mental model

You know the difference between a `string` and an array of char-code indices?
`"hi"` versus `[104, 105]`. Tokenization is exactly that, except the "alphabet"
isn't characters — it's a learned vocabulary of ~50k–200k sub-word chunks. "token"
might be one id; "tokenization" might be three.

```
  String vs token-id array (the whole idea)

   "predict next"               tokenizer            model input
   ┌────────────────┐          ┌──────────┐         ┌──────────────┐
   │ p r e d i c t  │ ───────► │ chunk +  │ ──────► │ [1923, 1995, │
   │   n e x t      │          │ look up  │         │  220, 4642]  │
   └────────────────┘          └──────────┘         └──────────────┘
   12 chars                     ~3 tokens            integer ids only
```

### Move 2 — the moving parts

**The estimate aptkit actually uses.** aptkit ships no tokenizer. The only token
math in the repo is a character-count divided by a constant. From
`packages/providers/local/src/context-window-guard.ts:100`:

```ts
export function estimateTextTokens(text: string, charsPerToken = 3): number {
  if (charsPerToken <= 0) throw new Error('charsPerToken must be greater than 0');
  return Math.ceil(text.length / charsPerToken);  // ← length / 3, that's it
}
```

```
  The estimate

  text.length ─► ÷ 3 ─► Math.ceil ─► estimated token count
  "deliberately low (3 not 4) so the guard errs toward refusing, not overflowing"
```

The industry rule of thumb is ~4 chars/token for English. aptkit uses **3** on
purpose — a smaller divisor yields a *larger* estimate, so the context guard
trips early rather than letting a real overflow reach the model.

**What gets counted.** The estimator doesn't just count the user message — it
joins system text, every message, and every tool schema. From
`context-window-guard.ts:91`:

```ts
export function estimateModelRequestTokens(request: ModelRequest, charsPerToken = 3): number {
  const text = [
    request.system ?? '',                                          // ← instructions cost tokens
    ...request.messages.map(messageText),                          // ← whole history
    ...(request.tools ?? []).map((tool) =>                         // ← tool schemas cost tokens too
      `${tool.name} ${tool.description ?? ''} ${JSON.stringify(tool.inputSchema)}`),
  ].join('\n');
  return estimateTextTokens(text, charsPerToken);
}
```

```
  What lives in the token budget

  ┌─ system ─┐ ┌─ messages (full history) ─┐ ┌─ tool schemas ─┐
  │  ~N tok  │ │       ~M tok              │ │    ~K tok      │
  └──────────┘ └───────────────────────────┘ └────────────────┘
        these all add up BEFORE the model writes a single token
```

The surprise for frontend engineers: your tool definitions and system prompt are
*not free*. They're in every request, counted every turn.

**The real count comes back after.** aptkit estimates going in, but the truth
arrives in the response. Gemma's adapter reads Ollama's `prompt_eval_count` and
`eval_count` (`gemma-provider.ts:120`) and marks `estimated: false` — those are
the model's *actual* token counts, not a guess.

### Move 3 — the principle

Estimate before, measure after. You can't know the exact token count without the
model's own tokenizer, so aptkit guards the call with a cheap pessimistic
estimate (length ÷ 3) and trusts the precise `usage` numbers only once they come
back. Never confuse the estimate with the truth.

## Primary diagram

```
  Tokens across the whole round-trip

  your string        aptkit estimate         model (real tokenizer)
  ┌──────────┐  ÷3   ┌───────────────┐  HTTP ┌────────────────────┐
  │ messages │ ────► │ guard: is est │ ────► │ tokenize → predict │
  │ + system │       │ ≤ budget?     │       │ → detokenize       │
  │ + tools  │       └───────────────┘       └─────────┬──────────┘
  └──────────┘        estimate (low-balled)            │ usage
                                                        ▼
                                            inputTokens/outputTokens (exact)
   before the call: GUESS (chars÷3)   │   after the call: MEASURED (estimated:false)
```

## Elaborate

Tokenization is byte-pair-encoding (BPE) or similar: a vocabulary learned so that
common sequences become single ids. It's why "the" is one token but a rare proper
noun might be five, and why non-English text is often more expensive per word.
aptkit deliberately avoids a tokenizer dependency to stay light and provider-
neutral — the trade is that its context guard is approximate. Read
`06-token-economics.md` next: token *counts* are the input to token *cost*.

## Project exercises

### Tighten the char-per-token estimate with a measured ratio
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a small script that runs a handful of fixture prompts
  through Gemma, compares the real `prompt_eval_count` from the response against
  `estimateModelRequestTokens(req, 3)`, and reports the actual chars/token ratio.
- **Why it earns its place:** proves the estimate is a guess and teaches you to
  calibrate it against ground truth — the exact skill behind context-window tuning.
- **Files to touch:** `packages/providers/local/src/context-window-guard.ts`
  (read), a new `packages/providers/local/test/token-ratio.test.ts`.
- **Done when:** `node --test` prints the measured ratio and asserts the estimate
  is within a stated tolerance for the fixtures.
- **Estimated effort:** `1–4hr`

### Make the guard count tool schemas more honestly
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a unit test that builds a `ModelRequest` with several large
  tool schemas and asserts `estimateModelRequestTokens` grows with schema size.
- **Why it earns its place:** forces you to internalize that tool definitions
  consume the same budget as prose — a cost most people forget.
- **Files to touch:** `packages/providers/local/test/context-window-guard.test.ts`.
- **Done when:** the test fails if tool schemas are dropped from the estimate.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "Why does aptkit divide by 3 when English is ~4 chars/token?"**
Because an undercount of chars-per-token *over*counts tokens, so the context
guard trips before a real overflow reaches the model. Pessimism is safer than a
mid-prompt truncation.

```
  ÷4 (accurate)  ──► est ≈ real  ──► risk: real overflow slips through
  ÷3 (aptkit)    ──► est > real  ──► guard refuses early (safe)
```
Anchor: *the estimate exists to refuse early, not to be accurate.*

**Q: "Where does aptkit get an exact token count?"**
Only from the response — Gemma reads Ollama's `prompt_eval_count`/`eval_count`
and marks `estimated:false`. Going in, it's always a chars÷3 guess.

```
  before call:  chars ÷ 3   (estimated:true-ish)
  after call:   usage from model  (estimated:false)
```
Anchor: *estimate before, measure after — never the same number.*

## See also

- `01-what-an-llm-is.md` — the function whose inputs these tokens are
- `06-token-economics.md` — turning token counts into dollars
- `05-streaming.md` — tokens arriving one at a time (the pattern aptkit doesn't use yet)
