# Query rewriting and HyDE

**Subtitle:** Query transformation · reshaping the query before retrieval · *Industry standard*

## Zoom out, then zoom in

Query transformation fixes the gap between *how a user asks* and *how the corpus is
written*. It sits before retrieval, as a pre-step that rewrites or expands the query
into something that embeds closer to the right chunks. aptkit embeds the raw query
verbatim, so both techniques here are `not yet exercised` — taught as the pattern
and its insertion point in the rag-query agent.

```
  Zoom out — transformation sits BEFORE embedding

  ┌─ rag-query agent ───────────────────────────────────────────┐
  │  user query ─► ★ rewrite / HyDE ★ ─► search_knowledge_base   │ ← we are here
  └───────────────────────────┬─────────────────────────────────┘
                              │ today: raw query straight to embed
  ┌─ pipeline.query (pipeline.ts:56) ▼──────────────────────────┐
  │  embed([query]) — verbatim, no transform                     │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. You've normalized a search box before — lowercase, strip stop words,
expand "NYC" to "New York City" so the index matches. Query transformation is that
idea with an LLM doing the normalization, and the target isn't a keyword index but
an embedding space. Two flavors: *rewrite* (expand the terse query into a fuller
one) and *HyDE* (write a fake answer and search with *that*). Both fight the same
problem — short queries embed poorly.

## Structure pass

**Layers.** Transform (rewrite / HyDE — an LLM step) → embed (the existing
`pipeline.ts:56`) → search (unchanged). The transform is a new top layer; everything
below it is untouched.

**Axis — control.** Trace who controls *what gets embedded*. Today the user's raw
text controls it directly (`pipeline.ts:56`). With a transform, an LLM sits in
between and controls it — the embedded text is the model's rewrite, not the user's
words. Control over the query vector moves from the user up to a pre-retrieval LLM
call.

**Seam.** The would-be seam is a pre-retrieval step in the rag-query agent, *before*
it calls `search_knowledge_base`. The pipeline's `queryKnowledgeBase`
(`pipeline.ts:50`) doesn't change — it still embeds whatever string it's handed. The
transform changes *what string* reaches it, not the pipeline.

## How it works

### Move 1 — the mental model

You know "search query expansion" — the box where typing "js array dedup" silently
becomes "javascript array remove duplicates" so it matches docs that never say
"dedup." That's an LLM-free rewrite. Now let an LLM do it, and add a second trick:
instead of improving the *question*, write a plausible *answer* and search for docs
that look like the answer. Questions and answers live in different regions of
embedding space; HyDE moves the query into the answer's neighborhood.

```
  Query and answer live in different regions of embedding space

  question region            answer region
  "fix auth?"  ●                          ● "verify the JWT signature, check exp…"
       │ raw query embeds HERE                   │ but the relevant CHUNK is HERE
       └────────── far in cosine space ──────────┘
   HyDE: embed a fake ANSWER ─► land in the answer region ─► closer to real chunks
```

### Move 2 — the two transforms, and where they slot

**Query rewrite: expand the terse query.** An LLM turns a sloppy query into an
explicit one before embedding. The target is the same chunks, but the rewritten
query embeds closer to them because it uses the corpus's vocabulary.

```
  Query rewrite (PSEUDOCODE — not yet exercised)

  user: "fix auth"
     │ LLM rewrite
     ▼
  "debug authentication: token verification, session expiry, login failure"
     │ embed THIS ─► search       (the chunks say "token verification", not "auth")
```

**HyDE: embed a hypothetical answer.** HyDE (Hypothetical Document Embeddings) goes
further — the LLM writes a fake answer to the question, and *that* gets embedded.
Corpus chunks *are* answers, so an embedded answer lands near real answers even when
the question's vocabulary doesn't.

```
  HyDE (PSEUDOCODE — not yet exercised)

  user: "how do I rotate the signing key?"
     │ LLM writes a hypothetical answer
     ▼
  "To rotate the signing key, generate a new keypair, publish the public key to
   JWKS, and set a grace period before retiring the old kid…"
     │ embed the FAKE ANSWER ─► search ─► finds the real key-rotation chunk
```

**Where both slot in aptkit.** Today the agent hands the raw query to the tool, and
the pipeline embeds it as-is (`pipeline.ts:56`):

```ts
const [vector] = await wiring.embedder.embed([query]);   // verbatim, no transform
```

The transform is a pre-tool LLM call in the rag-query agent — the agent rewrites
*before* invoking `search_knowledge_base`. The pipeline never knows:

```
  Transformed retrieval (PSEUDOCODE — not yet exercised)

  agent turn:
     rewritten = await llm.rewrite(userQuery)        # or llm.hydeAnswer(userQuery)
     toolCall  = search_knowledge_base(rewritten)    # pipeline embeds the rewrite
   pipeline.ts:56 unchanged — it embeds whatever string it's given
```

**The cost to weigh.** Each transform adds an LLM call *before* retrieval — latency
and tokens spent on every query, plus a new failure mode (a bad rewrite retrieves
worse than the raw query). So gate it on a measured retrieval lift: precision@k
(`packages/evals/src/precision-at-k.ts:47`) before and after the rewrite.

### Move 2.5 — current state vs future state

```
  Phase A (aptkit, now)             Phase B (transform — not yet exercised)
  ┌────────────────────────┐        ┌──────────────────────────────────┐
  │ raw query ─► embed      │        │ query ─► LLM rewrite/HyDE ─► embed │
  │ pipeline.ts:56 verbatim │  add   │ pre-tool step in rag-query agent  │
  │ terse queries embed weak│ LLM    │ embeds corpus-vocab / answer text │
  │ no extra LLM call       │ step   │ +1 LLM call per query (gate on @k) │
  └────────────────────────┘        └──────────────────────────────────┘
```

### Move 3 — the principle

The query is the weakest link in retrieval: users type three words, the corpus is
written in paragraphs, and the two embed far apart. Spend an LLM call to close that
gap — rewrite to match the corpus vocabulary, or HyDE to jump into the answer
region — but only when a precision@k measurement says the lift beats the added
latency. The pipeline stays vocabulary-agnostic; all the intelligence lives in the
pre-retrieval step, which is why it slots into the agent and not the contracts.

## Primary diagram

```
  Query transformation in aptkit terms

  user query "fix auth"
     │ rag-query agent, BEFORE the tool call (not yet exercised)
     ├─ rewrite ─► "debug authentication token verification, session expiry"
     └─ HyDE ────► "<hypothetical answer paragraph>"
                       │ search_knowledge_base(transformed)
                       ▼
  pipeline.query ─► embed (pipeline.ts:56, UNCHANGED) ─► cosine ─► top-k
                       │
            gate the whole thing on precision@k (precision-at-k.ts:47)
```

## Elaborate

Rewrite and HyDE attack the same defect from opposite ends. Rewrite improves the
*question* so it shares words with the chunks; HyDE abandons the question and
fabricates an *answer* so the search lands in the answer region of embedding space.
HyDE is stronger when the question and answer vocabularies diverge sharply (terse
question, technical corpus); rewrite is cheaper and safer when they're merely terse.
Both are premature for aptkit until a precision@k gap shows queries — not chunks or
ranking — are the bottleneck. The insertion point is deliberately the agent, not the
pipeline: keeping the pipeline vocabulary-agnostic is what lets you A/B a rewrite
without touching retrieval. Read `01-embeddings.md` for why short text embeds poorly
and `07-reranking.md` for the post-retrieval counterpart.

## Project exercises

### Add an LLM query-rewrite step to the rag-query agent and gate on precision@k
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a pre-retrieval step that asks the local model to expand the
  user query, passes the rewrite to `search_knowledge_base`, and an eval comparing
  precision@k on raw vs rewritten queries over a small labeled set.
- **Why it earns its place:** query rewriting is a top-asked RAG technique, and
  gating it on a measured lift proves you treat an extra LLM call as a cost to
  justify, not a free win.
- **Files to touch:** the rag-query agent (`packages/.../rag-query-agent.ts`),
  optionally `packages/retrieval/src/search-knowledge-base-tool.ts`,
  `packages/evals/src/precision-at-k.ts` (reuse), a new test in
  `packages/evals/test/` or `packages/retrieval/test/`.
- **Done when:** a test reports precision@k for raw vs rewritten queries on the same
  labeled set, and the agent uses the rewrite path.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: "What's HyDE and when does it beat plain query rewriting?"**
HyDE embeds a *hypothetical answer* instead of the question. The LLM writes a
plausible answer to the query, and that text gets embedded and searched. It wins when
the question and the corpus answers use very different vocabulary — questions and
answers occupy different regions of embedding space, and HyDE jumps the query into
the answer region. Plain rewrite just expands the question's terms; it's cheaper and
safer when the query is merely terse, not vocabulary-mismatched.

```
  rewrite: improve the QUESTION (same region, richer terms)
  HyDE:    embed a fake ANSWER (jump to the answer region)
```
Anchor: *rewrite improves the question; HyDE replaces it with an answer-shaped query.*

**Q: "Where would this live in your pipeline, and what does it cost?"**
A pre-retrieval LLM step in the rag-query agent, *before* `search_knowledge_base`.
The pipeline's `queryKnowledgeBase` (`pipeline.ts:56`) embeds whatever string it's
handed, so it never changes — the transform only changes *what string* arrives. The
cost is one extra LLM call per query plus a new failure mode (a bad rewrite retrieves
worse), so I gate it on precision@k before/after.

```
  agent: rewrite ─► tool(rewritten) ─► pipeline embeds it (pipeline.ts:56 unchanged)
  cost: +1 LLM call/query ─► must clear a precision@k bar
```
Anchor: *the transform lives in the agent; the pipeline stays vocabulary-agnostic.*

## See also

- `01-embeddings.md` — why short queries embed poorly
- `07-reranking.md` — the post-retrieval counterpart to pre-retrieval transforms
- `11-rag.md` — the raw-query embed step (pipeline.ts:56) these replace
- `04-agents-and-tool-use/03-react-pattern.md` — the agent step that hosts the rewrite
- `05-evals-and-observability/01-eval-set-types.md` — precision@k as the gate
