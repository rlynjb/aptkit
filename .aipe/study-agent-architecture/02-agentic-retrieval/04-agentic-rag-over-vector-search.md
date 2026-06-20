# 04 — Agentic RAG over real vector search

## The `@aptkit/agent-rag-query` capability: a weak local model drives semantic retrieval, grounds, and cites · Project-specific

---

## Zoom out

The other three files in this sub-section taught you agentic retrieval over
*analytics APIs* — the model calls `get_metric_timeseries`, reads JSON, calls
again. The repo's first-generation honesty note was blunt: "there are no
embeddings, no vector DB, no chunking in this codebase." That note is now out
of date. `@aptkit/agent-rag-query` is the file that retires it.

This is a sixth capability, and it is the first one that does **textbook RAG** —
embed a corpus, store the vectors, embed the query, ANN-search for the nearest
chunks, ground the answer in them, cite the source. And it does it *agentically*:
the model decides when to call the `search_knowledge_base` tool, reads the ranked
chunks, and synthesizes a cited answer — all through the same `runAgentLoop`
kernel every other agent uses. The twist that makes it interesting: the model
driving the loop is a **local Gemma running on Ollama**, a model with *no native
tool-calling*. The capability has to fake tools for it.

```
  Where the rag-query agent sits in AptKit

  ┌─ Script / host layer (scripts/ask.ts, scripts/eval.ts) ─────────┐
  │  index a corpus → new RagQueryAgent(...) → agent.answer(q)       │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │  one call = one capability run
  ┌─ Capability layer (packages/agents/rag-query) ───────────────────┐
  │  ★ RagQueryAgent ★                                               │
  │   = system prompt + profile + ragQueryToolPolicy                │ ← we are here
  │     + runAgentLoop budget + FALLBACK_ANSWER validator           │
  └───────────────────────────────┬─────────────────────────────────┘
            ┌──────────────────────┼───────────────────────────┐
            ▼                      ▼                           ▼
  ┌─ A: model ───────┐  ┌─ B: retrieval tool ──┐  ┌─ C: context ────┐
  │ Gemma (guarded   │  │ search_knowledge_base │  │ injectProfile   │
  │ by context-window│  │ over the pipeline:    │  │ (me.md text)    │
  │ guard)           │  │ embed→ANN→rank→cite   │  │                 │
  └──────────────────┘  └──────┬────────────────┘  └─────────────────┘
                               │ ModelProvider.complete / VectorStore.search
  ┌─ Provider + store layer (providers/gemma, retrieval/in-memory) ──┐
  │  Ollama /api/chat  ·  nomic-embed-text  ·  cosine ANN            │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in. The pattern is **agentic RAG over a similarity index** — the same
"query → read → decide → synthesize" loop from file 01, except the retrieval
source is a real vector store instead of analytics endpoints, and the brain
driving it is a 9B model that can't natively emit a tool call. This file's job
is to show how the *capability = prompt + policy + loop + validator* shape — the
one this whole guide hangs on — composes a real RAG system out of four packages,
and how the harness makes a weak local model behave like a tool-calling agent.

---

## Structure pass

Trace **one axis: who decides the next retrieval, and who is allowed to.** It
flips three times across the stack, and each flip is a seam worth studying.

```
  One axis (who decides / is allowed to retrieve) across four layers

  ┌─ Capability (RagQueryAgent) ──────────────────────────────────┐
  │  decides: the POLICY — only search_knowledge_base is allowed   │ ← grants the menu
  └───────────────────────────────┬───────────────────────────────┘
                  seam: filterToolsForPolicy (least privilege)
  ┌─ Loop (runAgentLoop) ─────────▼───────────────────────────────┐
  │  decides: WHETHER to retrieve again — bounded by maxTurns 6 /  │ ← bounds the loop
  │  maxToolCalls 4, then forces synthesis                         │
  └───────────────────────────────┬───────────────────────────────┘
                  seam: ModelProvider.complete (the brain)
  ┌─ Model (Gemma, guarded) ──────▼───────────────────────────────┐
  │  decides: emit a tool_use? — but it has NO native tools, so    │ ← emulates the call
  │  the provider renders tools into prose and parses JSON back    │
  └───────────────────────────────┬───────────────────────────────┘
                  seam: ToolExecutor.callTool (the hands)
  ┌─ Tool + pipeline (search_knowledge_base) ─────▼───────────────┐
  │  decides: NOTHING — pure embed→ANN→rank→cite; minTopK floor    │ ← executes, ranks
  │  stops the model starving its own retrieval                    │
  └───────────────────────────────────────────────────────────────┘
```

Three seams carry the whole story:

- **`filterToolsForPolicy`** — the policy seam. The capability grants exactly one
  tool. Control over *what can be retrieved* lives here, before the loop runs.
- **`ModelProvider.complete`** — the brain seam. This is where the weak-model
  problem lives: Gemma can't take a `tools` array, so the **GemmaModelProvider**
  is where native tool-calling gets *emulated*. The seam's contract
  (`ModelResponse` with `tool_use` blocks) is honored; how the contract gets
  satisfied is the provider's secret.
- **`ToolExecutor.callTool`** — the hands seam. The model emits intent; the
  harness runs the real ANN search. The model never touches the vector store.

The load-bearing flip is the third one: the model *decides* to retrieve, but it
emits that decision as messy JSON prose, and a provider downstream of it has to
recover a structured `tool_use` from that prose. That recovery is the part this
file exists to teach.

---

## How it works

### Move 1 — Mental model: tool-calling emulation is a translation layer

You already know the agentic-RAG loop from file 01: messages-as-state, the model
reads state and proposes a tool call, the harness runs it, the result feeds back.
Nothing about that changes here. What changes is *one seam*: the model can't
speak the loop's native language.

Think of it like a `fetch` against an API that only returns XML when your code
expects JSON. You don't rewrite your code — you put an adapter at the boundary
that parses the XML into the shape the rest of your code already understands. The
**GemmaModelProvider is that adapter.** The loop above it speaks `tool_use`
blocks; Gemma below it speaks only free text. The provider translates both ways.

```
  PATTERN — tool-call emulation as a two-way translation at one seam

  loop's language                provider                 Gemma's language
  ───────────────                ────────                 ────────────────

  tools: ModelTool[]  ───render──►  inline JSON in       ──►  system prompt:
                                    the system text           "you can call: {...}"

  ModelResponse {            ◄─parse──  raw model text:    ◄──  '{"tool":"search_
    content:[tool_use{...}]}            messy JSON              knowledge_base",
                                                                "arguments":{...}}'
```

The loop never knows the model is weak. It hands `toolSchemas` down and gets
`tool_use` blocks back, exactly as it would from a frontier model with native
tools. The whole weakness is absorbed at one seam.

### Move 2 — Step by step

#### **Step 1 — Compose the capability: prompt + profile + policy**

The constructor assembles the system prompt the way every AptKit capability
does — but with a `me.md`-style profile injected first. Profile, *then* render:
`injectProfile` prepends the profile block, then `renderPromptTemplate` resolves
any `{placeholder}`s. The order matters because the profile may itself be
template-free text and the system template may carry placeholders.

```
  Compose the system prompt (constructor)

  DEFAULT_SYSTEM_TEMPLATE ("always call search_knowledge_base first…")
        │
        ├─ profile?  ──yes──► injectProfile(template, profile, {position:'start',
        │                                     heading:'# About the person…'})
        ▼
  renderPromptTemplate(withProfile, {})   # resolve {placeholders}, if any
        │
        ▼
  this.system   # frozen for the run
```

```text
template   = options.prompt ?? DEFAULT_SYSTEM_TEMPLATE
withProfile = profile ? injectProfile(template, profile, …) : template   # C first
this.system = renderPromptTemplate(withProfile, {})                       # then render
```

The policy is declared right next to the agent: `ragQueryToolPolicy` grants
exactly one tool — `search_knowledge_base`. That is the *least-privilege* grant:
this agent cannot call anything else even if a tool registry holds fifty tools.

#### **Step 2 — Filter the registry to the policy (the menu)**

At `answer()` time, the agent lists every tool in the registry and filters it
down to its policy before the loop ever runs. This is the "what may be retrieved"
gate — it bounds the menu, not the count.

```
  Policy gate — registry → allowed menu

  tools.listTools()  ──►  [ search_knowledge_base, …maybe others… ]
        │
        ▼
  filterToolsForPolicy(allTools, ragQueryToolPolicy)
        │
        ▼
  toolSchemas = [ search_knowledge_base ]   # least-privilege: just one
```

```text
allTools    = await tools.listTools()
toolSchemas = filterToolsForPolicy(allTools, ragQueryToolPolicy)  # allowlist of one
```

#### **Step 3 — The model proposes a retrieval — but it has no native tools**

`runAgentLoop` calls `model.complete({ system, messages, tools: toolSchemas })`.
A frontier model would return a `tool_use` block directly. Gemma can't — the
Ollama `/api/chat` endpoint has no tools parameter. So the **GemmaModelProvider
renders the tool schemas into the system text** as instructions: "you can call
the following tools: `{…json…}`. When a tool is needed, respond with ONLY a
single JSON object: `{"tool":"…","arguments":{…}}`."

```
  Outbound emulation — tools become prose

  request.tools = [search_knowledge_base schema]
        │  buildSystemText(request)
        ▼
  system += "You can call the following tools:\n {name, description,
             input_schema}\n When a tool is needed, respond with ONLY a
             single JSON object: {\"tool\":…,\"arguments\":…}"
        │
        ▼
  POST /api/chat  { model:"gemma2:9b", messages:[{system},{user}] }
```

```text
# gemma-provider.ts buildSystemText — the outbound half of emulation
if (request.tools?.length) {
  rendered = tools.map(t => JSON.stringify({name, description, input_schema}))
  parts.push("You can call the following tools:\n" + rendered +
             "\nrespond with ONLY a single JSON object: {tool, arguments}")
}
```

#### **Step 4 — Parse messy model text back into a `tool_use` block (with one retry)**

Gemma replies with text. The provider runs `parseToolCall` on it — which leans on
`parseAgentJson` to dig a JSON object out of whatever the model wrapped it in
(code fences, stray prose). If it finds `{tool, arguments}`, it returns a
**synthetic `tool_use` block** so the loop above sees exactly what it expects.

The weak-model insurance is the **bounded retry**: if the reply *looked like* a
botched tool call (it contains a `{`) but didn't parse, the provider appends a
corrective nudge — "your previous reply was not a valid tool call, respond with
ONLY JSON" — and asks once more. Capped at `maxToolCallAttempts` (default 2).
Plain prose with no `{` is treated as a real answer, not a failed tool call, so
the agent isn't forced to retrieve when the model legitimately wants to answer.

```
  Inbound emulation — prose → tool_use (bounded retry)

  raw = model reply text
        │
        ▼
  parseToolCall(raw)  ──ok──► return tool_use{name, input}   # loop sees a real call
        │ null
        ▼
  looksLikeToolAttempt(raw)?  (does it contain '{' ?)
        │ yes (≤ maxToolCallAttempts)        │ no
        ▼                                    ▼
  append RETRY_NUDGE, ask again         return text block   # genuine prose answer
```

```text
# gemma-provider.ts complete — the inbound half, bounded
for attempt in 0..maxAttempts:
  raw = chat(messages + (attempt>0 ? RETRY_NUDGE : []))
  call = parseToolCall(raw)
  if call: return tool_use{ id, name:call.name, input:call.input }   # synthesized
  if looksLikeToolAttempt(raw): continue   # botched JSON → nudge + retry
  break                                     # plain prose → real answer
return text{ raw }
```

This is the part people miss about running weak local models as agents: the
provider, not the loop, owns the reliability. The loop's contract is clean; the
mess is quarantined in one adapter.

#### **Step 5 — Execute the real retrieval and floor the top-k**

When the loop sees the synthesized `tool_use`, it runs `search_knowledge_base`
through the `ToolExecutor` seam. *This* is the textbook-RAG half: the handler
embeds the query, ANN-searches the in-memory store, ranks, and returns chunks
each carrying a `citation` string (`[docId] snippet…`).

The weak-model defense here is the **`minTopK` floor**. Gemma tends to under-ask
— it'll pass `top_k: 1`, starving a multi-part question ("what embeddings *and*
how does he take his coffee?") of the chunks it needs. The tool clamps the
requested `top_k` up to a floor (`minTopK: 4` in the capstone script) so the
model can't starve its own retrieval.

```
  Retrieval — embed → ANN → rank → cite (with a top_k floor)

  args { query, top_k:1 }            ← Gemma under-asks
        │
        ▼  topK = max(requestedTopK, minTopK)   # floor: 1 → 4
  pipeline.query(query, topK)
        │  embed(query) → store.search(vector, topK)
        ▼
  hits → results[{ id, score, citation:"[docId] snippet…", meta }]
```

```text
requestedTopK = args.top_k > 0 ? args.top_k : defaultTopK
topK = max(requestedTopK, minTopK)   # stop the weak model starving its own recall
hits = await pipeline.query(query, fetchK)
return { query, results: hits.map(toResult) }   # each result carries a citation
```

#### **Step 6 — Budget trips, synthesis forced, fallback if empty**

Same bounded-loop ending as every AptKit capability. `maxTurns: 6` and
`maxToolCalls: 4` cap it. On the last turn — or when the four tool calls are
spent — `runAgentLoop` drops the tool schemas and appends the
`buildSynthesisInstruction` text ("you have NO more tool calls available, answer
directly and concisely, citing the sources"). The model must answer from the
chunks already retrieved.

The capability's validator is deliberately thin: `finalText.trim() ||
FALLBACK_ANSWER`. There is no structured-output parse here (the output is a prose
answer, not a typed object), so the only failure it guards is *empty output* —
an empty answer becomes "I couldn't find anything in the knowledge base to
answer that" rather than a blank string.

```
  Bounded ending

  budgetSpent = toolCalls >= 4
  forceFinal  = lastTurn(6) OR budgetSpent
        │
        ▼
  model.complete(system + synthesisInstruction, tools=undefined)   # must answer
        │
        ▼
  finalText.trim() || FALLBACK_ANSWER     # the only validator: non-empty
```

### Move 3 — The principle

The capability shape this whole guide names — **prompt + tool policy + loop
budget + validator** — is *retrieval-strategy-agnostic*. File 01 instantiated it
over analytics APIs; this file instantiates the identical shape over a vector
store, and the only things that changed are the tool granted (`search_knowledge_
base` instead of `get_metric_timeseries`) and the validator (empty-check instead
of JSON-schema parse). The loop, the budget, the policy seam, the synthesis turn:
all reused verbatim. That is the payoff of a deep agent kernel — a new RAG system
is a new *configuration* of it, not new orchestration code.

The second principle is sharper and more transferable: **a weak model becomes an
agent at the provider seam, not the loop.** Gemma has no native tools, but the
loop never learns that. By rendering tools into prose, parsing JSON back, and
retrying bounded, the GemmaModelProvider satisfies the `ModelProvider` contract
the loop depends on — so the same kernel that drives Claude or GPT drives a 9B
local model unchanged. When you hear "can I run agents on a local model," the
honest answer is "yes, if you put the tool-calling emulation in the adapter and
accept a retry tax for the model's sloppiness."

---

## Primary diagram

The whole rag-query capability, from question to cited answer, with the
emulation seam and the budget gate marked.

```
  @aptkit/agent-rag-query — one capability run

  question + profile
    │
    ▼
  RagQueryAgent.answer(q)
    │  toolSchemas = filterToolsForPolicy(all, ragQueryToolPolicy)  ← least-privilege (1 tool)
    ▼
  ┌─────────── runAgentLoop (maxTurns 6 / maxToolCalls 4) ───────────────────┐
  │                                                                          │
  │   forceFinal = lastTurn OR toolCalls >= 4                                │
  │        ├── forceFinal? ─yes─► model.complete(+synthesis, NO tools) ──────┼─► finalText
  │        no                                                                │
  │        ▼                                                                 │
  │   model.complete(messages, tools)   ── GemmaModelProvider ──────────────┐│
  │        │                              render tools → prose              ││
  │        │                              parse JSON ← raw text (≤2 tries)  ││
  │        ▼                              └──────────────────────────────────┘│
  │   tool_use? ─none─► finalText = text; break ─────────────────────────────┼─► finalText
  │        │ yes (synthesized tool_use)                                      │
  │        ▼                                                                 │
  │   search_knowledge_base(query, top_k≥minTopK)                            │
  │        │  embed → ANN → rank → cite                                      │
  │        ▼                                                                 │
  │   messages.push(tool_result: ranked chunks)  ← feedback edge             │
  │        └──────────────── loop ──────────────────────────────────────────┘│
  └──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                  finalText.trim() || FALLBACK_ANSWER   ← the validator
                                  │
                                  ▼
                  cited answer in the person's voice (profile-shaped)
```

The model, the tool, the profile, the loop, and the validator are five
separately-swappable packages composed by one ~80-line agent class. That
composition *is* the capability.

---

## Implementation in the codebase

### Use case — A personal knowledge assistant that answers in your voice

The capstone hand-test (`packages/agents/rag-query/scripts/ask.ts`) wires the
whole stack live: index a tiny markdown corpus, run a Gemma-driven agent over
real `nomic-embed-text` embeddings, and answer a question grounded in the corpus,
shaped by a profile. Zero cloud — Ollama serves both the embedder and the brain.

```text
packages/agents/rag-query/src/rag-query-agent.ts
```

```ts
// :15  least-privilege grant — this agent may ONLY search the knowledge base
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],
};
```

- `:15-18` — the policy is one tool. Even if the registry holds others,
  `filterToolsForPolicy` hands the loop a menu of exactly one. This is the
  control-over-retrieval seam from the structure pass, declared as data.

```ts
// :52  constructor — compose prompt: profile first, then render
constructor(private readonly options: RagQueryAgentOptions) {
  const template = options.prompt ?? DEFAULT_SYSTEM_TEMPLATE;
  const withProfile = options.profile
    ? injectProfile(template, options.profile, { position: 'start', heading: PROFILE_HEADING })
    : template;
  this.system = renderPromptTemplate(withProfile, {});   // :58
}
```

- `:55-57` — `injectProfile` prepends the `me.md`-style block under the heading
  `# About the person you are assisting`. This is package C — the "body" /
  identity layer. (Trajectory persistence and the multi-device body are deferred
  to a separate repo; here the profile is just injected text.)
- `:58` — render *after* injection so the profile can't accidentally swallow a
  template placeholder.

```ts
// :62  answer() — the capability shape: policy → loop → validator
async answer(question: string, runOptions: RagQueryRunOptions = {}): Promise<string> {
  const allTools = await this.options.tools.listTools();
  const toolSchemas = filterToolsForPolicy(allTools, ragQueryToolPolicy);   // :64

  const { finalText } = await runAgentLoop({
    capabilityId: RAG_QUERY_CAPABILITY_ID,
    model: this.options.model,          // A — guarded Gemma
    tools: this.options.tools,          // B — registry holding search_knowledge_base
    system: this.system,                // C — profile-injected prompt
    userPrompt: question,
    toolSchemas,                        // :71  the one-tool menu
    maxTurns: 6,                        // :74  loop cap
    maxToolCalls: 4,                    // :75  retrieval-spend cap
    synthesisInstruction: buildSynthesisInstruction(   // :76  forced answer-from-chunks
      'Now answer the question directly and concisely, citing the sources you retrieved.',
    ),
  });

  return finalText.trim() || FALLBACK_ANSWER;   // :82  the validator: non-empty
}
```

- `:64` — the policy filter runs *before* the loop. The loop only ever sees the
  allowed tool.
- `:66-80` — identical `runAgentLoop` call shape as the analytics agents
  (file 01), with two differences: `maxTurns: 6 / maxToolCalls: 4` (a tighter
  budget than monitoring's 8/6) and **no `parseResult`** — the output is prose,
  so there's no structured validator, just the empty-check on `:82`.

```text
packages/providers/gemma/src/gemma-provider.ts
```

```ts
// :77  inbound emulation — turn Gemma's messy text into a tool_use, bounded retry
if (wantsTool) {
  const call = parseToolCall(raw);                    // :78  prose → {name,input}?
  if (call) {
    return this.toResponse(
      [{ type: 'tool_use', id: this.nextToolUseId(call.name), name: call.name, input: call.input }],  // :81
      lastResponse,
    );
  }
  if (looksLikeToolAttempt(raw)) continue;            // :86  botched JSON → nudge + retry
}
```

- `:78` — `parseToolCall` runs `parseAgentJson` (from `@aptkit/runtime`) to dig a
  JSON object out of whatever Gemma wrapped it in, then accepts `{tool|name}` and
  `{arguments|input|args}` aliases — defensive against a sloppy model.
- `:81` — the synthesized `tool_use` block. The loop above can't tell this came
  from prose parsing rather than a native tool call. **This line is the entire
  emulation.**
- `:86` — the bounded retry: a reply containing `{` that didn't parse gets the
  `RETRY_NUDGE` (`:35`) and one more attempt; plain prose breaks out as a real
  answer.

```text
packages/retrieval/src/search-knowledge-base-tool.ts
```

```ts
// :81  floor the top_k so a weak model can't starve its own retrieval
const requestedTopK = typeof args.top_k === 'number' && args.top_k > 0 ? args.top_k : defaultTopK;
const topK = Math.max(requestedTopK, minTopK);   // :81  minTopK: 4 in ask.ts
```

- `:81` — Gemma passes `top_k: 1` on multi-part questions; `minTopK` clamps it
  up. Without this floor the retrieval comes back too thin to answer and the
  model has nothing to ground on — a silent quality failure, not a crash.
- `:105` — `matchesFilter` ignores filter keys absent from a chunk's metadata, so
  a hallucinated filter (`{textContains:"x"}`) can't silently wipe every result.
  Another weak-model guard.

---

## Elaborate

A few things that surprise people coming from the analytics agents — or from
frontier-model RAG:

- **This is the file that retires the "no vector retrieval" claim.** The other
  three files in this sub-section, and `agent-patterns-in-this-codebase.md`,
  were written when AptKit's only "retrieval" was tool-calling over analytics
  APIs. `@aptkit/retrieval` (embedder + chunker + in-memory cosine store +
  pipeline) and this agent are the real-RAG addition. The mechanics of the
  store, the chunker, and the embedder are **ai-engineering's territory**, not
  this guide's — see the cross-link. This file owns only the *control loop* over
  them.
- **The capability is identical in shape to the analytics agents.** Same kernel,
  same policy seam, same budget exit, same forced synthesis. The new RAG system
  cost one ~80-line agent class plus one tool — no new orchestration. That is the
  whole argument for a deep `runAgentLoop`.
- **The weak model is the interesting part, not the vector store.** Vector RAG is
  well-trodden; running it on a 9B local model with no native tools is the
  scar-tissue lesson. The emulation (render tools → parse JSON → bounded retry)
  and the two anti-starvation guards (`minTopK` floor, hallucinated-filter
  no-op) exist *only* because the brain is weak. Swap Gemma for Claude and they
  become dead weight you'd remove.
- **The context-window guard is load-bearing for a local model.**
  `ContextWindowGuardedProvider` wraps Gemma and pre-flights the token estimate
  against an ~8k budget, throwing `ContextWindowExceededError` before the request
  is sent rather than letting Ollama truncate silently. A frontier model with a
  200k window never trips this; Gemma trips it the moment the retrieved chunks
  plus the profile plus the prompt overflow 8k. Covered as a serving control in
  `../05-production-serving/`.
- **Eval is retrieval-in-isolation, by design.** `scripts/eval.ts` scores
  `precision@1` / `recall@k` over a labeled corpus using *real* nomic embeddings,
  with **no model generation**. That separates "is retrieval good?" from "is the
  answer good?" — you measure the retrieval seam alone before blaming the model.
  Trajectory-level agent eval (was the right tool called, in the right order) is
  not yet wired for this capability.

---

## Interview defense

**Q: "You ran an agent on a local model with no native tool-calling. How?"**

> Tool-call emulation at the provider seam. The agent loop is provider-neutral —
> it hands down tool schemas and expects `tool_use` blocks back. Gemma can't take
> a tools array, so the GemmaModelProvider renders the schemas into the system
> prompt as JSON instructions, asks the model to reply with a single
> `{"tool":…,"arguments":…}` object, and parses that prose back into a synthetic
> `tool_use` block. The loop never knows the model is weak. I bound the sloppiness
> with a retry: if the reply looks like a botched tool call — it contains a brace —
> I nudge once and re-ask, capped at two attempts. Plain prose is treated as a
> real answer, not a failed call.

```
  loop ──tools──► GemmaProvider ──render──► Gemma ──prose──►
                       └─parse JSON, retry ≤2─◄── tool_use ◄─ loop
```

**Anchor:** "The weakness lives in one adapter, not the loop. Same kernel that
drives Claude drives a 9B local model — the provider just earns its keep."

**Follow-up — "What broke that a frontier model wouldn't?"** Two things, both
recall failures, not crashes. Gemma under-asked with `top_k: 1` and starved
multi-part questions — I floored it with `minTopK`. And it hallucinated metadata
filters that would've wiped every result — the filter matcher ignores keys a
chunk doesn't have, so a bogus filter is a no-op instead of a silent zero-result.
Neither defense exists for a model that retrieves competently.

**Follow-up — "Is this real RAG or tool-calling dressed up?"** Both, and they're
the same thing here. It's textbook RAG — chunk, embed with nomic, cosine ANN over
an in-memory store, ground and cite — driven *agentically*: the model decides
when to search and reads ranked chunks back. The capability shape is identical to
my analytics agents; only the tool granted and the validator changed.

---

## Validate

Four levels, each tied to a real file you can open.

1. **Spot it** — The capability shape. `ragQueryToolPolicy` at
   `packages/agents/rag-query/src/rag-query-agent.ts:15`; the `runAgentLoop` call
   at `:66` with `maxTurns: 6 / maxToolCalls: 4` (`:74-75`); the validator
   `finalText.trim() || FALLBACK_ANSWER` at `:82`. Confirm it's the *same kernel*
   as `packages/runtime/src/run-agent-loop.ts:76`.

2. **Trace it** — Follow one retrieval through the emulation. Loop calls
   `model.complete` with `toolSchemas` (`run-agent-loop.ts:103`); GemmaProvider
   renders tools into the system text (`gemma-provider.ts:133` `buildSystemText`),
   parses the reply (`:78` `parseToolCall`), returns a synthetic `tool_use`
   (`:81`); the loop runs `search_knowledge_base` which embeds → ANN → ranks →
   cites (`search-knowledge-base-tool.ts:78-96`).

3. **Bound it** — Find the caps. The loop budget at `rag-query-agent.ts:74-75`;
   the emulation retry cap `maxToolCallAttempts` at `gemma-provider.ts:49` (the
   `RETRY_NUDGE` at `:35`); the retrieval floor `minTopK` at
   `search-knowledge-base-tool.ts:81`; the context-window guard at
   `packages/providers/local/src/context-window-guard.ts:57`.

4. **Break it** — Reason about failure. If Gemma emits prose with no `{`, the
   provider returns it as a text answer (`gemma-provider.ts:91`) and the loop
   stops — no forced retrieval. If retrieval returns nothing and the model writes
   nothing, the validator returns `FALLBACK_ANSWER` (`rag-query-agent.ts:82`)
   rather than an empty string. If the corpus is embedded at a different
   dimension than the query embedder, `assertWiring` throws at pipeline-build
   time (`pipeline.ts:22`), not silently at search time.

---

## See also

- `01-agentic-rag.md` — the same driven loop over *analytics* tools; this file is
  the vector-store sibling. Read 01 first for the loop, this for the RAG twist.
- `02-self-corrective-rag.md` — grading what retrieval returned; this agent has no
  grader yet, only the `minTopK` floor and the empty-check validator.
- `03-retrieval-routing.md` — picking a source; this agent has one source
  (the vector store) and one tool.
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the loop kernel, taught
  in full; this capability is one configuration of it.
- `../04-agent-infrastructure/03-tool-calling-and-mcp.md` — the tool policy +
  registry plumbing; the emulation here is the weak-model variant of native tools.
- `../05-production-serving/` — the context-window guard as a serving control for
  a local model.
- `.aipe/study-ai-engineering/03-retrieval-and-rag/` — embeddings, chunking,
  cosine ANN, the in-memory vector store **mechanics** this file deliberately does
  *not* re-teach. That is ai-engineering's partition; this file owns only the loop
  over them.
- `agent-patterns-in-this-codebase.md` — the patterns table, now updated with this
  sixth capability.
