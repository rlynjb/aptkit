# 00 — Overview: AptKit's design shape in one page

Before any single module, here's the whole repo as a design object — the
layers, where depth lives, and where it doesn't.

```
  AptKit — packages by layer, marked by design depth

  ┌─ Public surface ──────────────────────────────────────────────┐
  │  packages/core  →  @rlynjb/aptkit-core  (pure re-exports)      │
  │  one bundle, 11 packages inlined. The compatibility contract.  │
  └───────────────────────────────┬────────────────────────────────┘
                                  │ re-exports
  ┌─ Capabilities (agents) ───────▼────────────────────────────────┐
  │  recommendation · anomaly-monitoring · diagnostic · query ·    │
  │  rubric-improvement · rag-query (newest)                       │
  │  ★ 6 classes, ~85% identical wiring — the shallowest layer ★   │
  └───────────────────────────────┬────────────────────────────────┘
                                  │ compose
  ┌─ Building blocks ─────────────▼────────────────────────────────┐
  │  prompts (data) · tools (registry+policy) · evals (rules) ·    │
  │  workflows · context (injectProfile) · retrieval (RAG)         │
  │  retrieval: EmbeddingProvider + VectorStore = ModelProvider's  │
  │  deep-module shape, reused twice  → 06                         │
  └───────────────────────────────┬────────────────────────────────┘
                                  │ depend on
  ┌─ Foundation (runtime) ────────▼────────────────────────────────┐
  │  ★ ModelProvider ★  runAgentLoop  structured-generation        │
  │  json-output  ndjson-stream  usage-ledger  events              │
  │  the deepest modules in the repo live here                     │
  └───────────────────────────────┬────────────────────────────────┘
                                  │ ModelProvider.complete()
  ┌─ Provider adapters ───────────▼────────────────────────────────┐
  │  anthropic · openai · gemma · fallback (wrap) · local-guard(wrap)│
  │  every vendor SDK hidden behind one 3-field interface          │
  │  gemma: an unusually large body (tool-call emulation) → 06     │
  └────────────────────────────────────────────────────────────────┘
```

---

## Modules ranked by depth (functionality ÷ interface size)

Ousterhout's central metric: a deep module does a lot behind a small
interface. Here's the repo, best to worst.

```
  DEEPEST  (big behaviour, tiny surface — copy these)
  ─────────────────────────────────────────────────────────
  ModelProvider          3 fields hide every vendor SDK
                         packages/runtime/src/model-provider.ts:54
  structural-diff        6 rule types behind one evaluate() walk
                         packages/evals/src/structural-diff.ts:20
  runAgentLoop           one call hides the whole tool-using loop,
                         trace emission, budget, recovery turn
                         packages/runtime/src/run-agent-loop.ts:76
  Embedding/VectorStore  3 members each hide HTTP + cosine + dim check;
                         ModelProvider's shape, reused twice  → 06
                         packages/retrieval/src/contracts.ts:22
  GemmaModelProvider     3-member ModelProvider; body emulates tool
                         calls Gemma can't do natively  → 06
                         packages/providers/gemma/src/gemma-provider.ts:39

  MEDIUM   (earns its interface, nothing wasted)
  ─────────────────────────────────────────────────────────
  ndjson-stream          streaming decode w/ partial-line handling
  generateStructured     bounded retry + validate behind one call
  filterToolsForPolicy   one function, one Set, one map

  SHALLOWEST  (interface ≈ body — the fix targets)
  ─────────────────────────────────────────────────────────
  the 6 agent classes    each is ~30 lines of identical wiring
                         around 4 lines of unique logic. RagQueryAgent,
                         the newest, copied the same skeleton.
                         see 04-capability-agent-template.md
```

---

## The one-sentence verdict

**AptKit's foundation is deep and its capability layer is shallow.** The
runtime contracts (`ModelProvider`, `runAgentLoop`, `structural-diff`, and now
the retrieval `EmbeddingProvider`/`VectorStore` pair) are textbook deep modules
— narrow interfaces hiding real behaviour. The six agent classes are the
opposite: each re-implements the same constructor +
`listTools → filterToolsForPolicy → renderPromptTemplate → runAgentLoop →
parse` skeleton, so the duplication that the monorepo extraction was supposed
to eliminate has reappeared one layer up. That's the single highest-leverage
fix in the repo (`04-capability-agent-template.md`).

---

## The three highest-leverage fixes (ranked)

1. **Collapse the 6-agent boilerplate into one `runCapability<T>()` helper.**
   ~140 lines of duplicated wiring across six files (the new `RagQueryAgent`
   added the sixth); the divergent parts (prompt vars, policy, parse, recovery)
   are already first-class parameters. → `04-capability-agent-template.md`.

2. **Pull the OpenAI-only pricing knowledge out of a hardcoded `if`-ladder.**
   `usage-ledger.ts:71` knows three model families inline and silently returns
   `undefined` for everything else (Anthropic always costs `n/a`). The
   pricing table is data; it's currently control flow. → `audit.md` Lens 5.

3. **Hoist the copy-pasted `buildRecoveryPrompt` evidence formatter into
   runtime.** The `toolCalls.map(... slice(0, 900))` block is byte-identical
   in three agents. → `audit.md` Lens 3 and `04`.

Read `audit.md` next for the full 8-lens walk.
