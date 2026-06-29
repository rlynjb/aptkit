# 01 — Anatomy of a production prompt

**Subtitle:** prompt anatomy — system / context / examples / user message
(Language-agnostic)

## Zoom out, then zoom in

Every model call in this repo is a layered thing, not a string. Before you
can reason about *any* prompt technique, you have to see the slots a prompt
is built from and which layer owns each one. Here is where those slots sit.

```
  Zoom out — the four slots, where they live in aptkit

  ┌─ Source layer ──────────────────────────────────────────────┐
  │  ★ SYSTEM PROMPT ★  PromptPackage.system (constant per agent) │ ← we are here
  │     packages/prompts/src/query.ts:3                           │
  └───────────────────────────┬──────────────────────────────────┘
                              │ renderPromptTemplate + injectProfile
  ┌─ Assembly layer ──────────▼───────────────────────────────────┐
  │  ★ CONTEXT INJECTION ★  {schema}, {intent}, profile (per call) │
  │  ★ FEW-SHOT EXAMPLES ★  PromptPackage.examples (slot only)     │
  └───────────────────────────┬──────────────────────────────────┘
                              │ runAgentLoop messages[]
  ┌─ Runtime layer ───────────▼──────────────────────────────────┐
  │  ★ USER MESSAGE ★  { role: 'user', content: question }        │
  └────────────────────────────────────────────────────────────────┘
```

Zooming in: a production prompt is four sections, each with a different
*owner* and a different *lifetime*. The system prompt is constant across
every call to that agent. Context is spliced per call. Examples constrain
format. The user message is the only thing that changes turn to turn. Mix
up which section owns what, and you get drift — the slow rot where a prompt
that worked in March fails in June and nobody can say why.

## Structure pass

**Layers.** Source (the template literal), assembly (placeholders filled,
profile injected), runtime (messages array sent to the provider).

**Axis — what's constant vs what's per-call?** Trace that one question down
the layers and the sections separate cleanly:

```
  Axis traced: "does this change between two calls to the same agent?"

  system prompt   → NO   (constant — the role, rules, output contract)
  context inject  → YES  (per-call — {schema}, {intent}, the profile)
  few-shot examples → NO (constant — same exemplars every call)
  user message    → YES  (per-call — the actual question)
```

**Seam.** The load-bearing boundary is between *constant* and *per-call*.
That seam is where drift happens: someone needs a per-call fact, can't be
bothered to thread it through the assembly layer, and hardcodes it into the
system literal. Now the "constant" prompt carries a stale per-call value.

## How it works

Let's walk the four sections one at a time, using `query.ts` as the worked
example because it exercises all four.

### Section 1 — the system prompt (the constant contract)

You already know the shape from a React component's props that never change
across renders versus the ones that do. The system prompt is the props that
never change. In aptkit it's a template literal, `QUERY_PROMPT`, that opens
by naming the role and the hard rules:

```ts
// packages/prompts/src/query.ts:3
export const QUERY_PROMPT = `You are an AI analyst for an ecommerce
workspace. ...
## Hard rules
1. When an EQL adapter is live, pass project_id: {project_id} ...
## Output
Give a clear, concise answer in plain prose. ... No JSON shape is required.`;
```

What goes here: the role, the hard rules, the tool-usage policy, the output
contract. What concretely happens if you put a per-call fact here instead —
say you hardcode a specific project's id into the literal — every other
workspace that uses this agent silently sends the wrong id. That's the
boundary condition: the system prompt is shared across all callers, so
anything caller-specific in it leaks.

### Section 2 — context injection (the per-call splice)

The `{project_id}`, `{intent}`, and `{schema}` you saw above are
placeholders. They're filled at assembly time, per call:

```ts
// packages/agents/query/src/query-agent.ts:79
const system = renderPromptTemplate(this.prompt, {
  schema: schemaSummary(this.options.workspace),  // this workspace's fields
  project_id: this.options.workspace.projectId,    // this workspace's id
  intent,                                          // this query's framing
});
```

`renderPromptTemplate` (`packages/prompts/src/types.ts:24`) is dead simple —
a regex that swaps `{var}` for a value, leaving unknown placeholders intact.
The point isn't the substitution mechanism; it's *where* the substitution
happens. The template stays constant on disk; the per-call facts arrive
through one named, reviewable channel.

```
  Layers-and-hops — context injection at assembly time

  ┌─ Source ──────────┐  hop 1: template literal   ┌─ Assembly ─────────┐
  │ QUERY_PROMPT       │ ─────────────────────────► │ renderPromptTemplate│
  │ with {schema} etc. │                            │ fills per-call vars │
  └────────────────────┘  hop 2: workspace facts ──►└─────────┬───────────┘
                                                              │ hop 3: system text
                                                              ▼
                                                     ┌─ Runtime ─────────┐
                                                     │ model.complete()   │
                                                     └────────────────────┘
```

There's a second injection path worth naming: `injectProfile`
(`packages/context/src/profile-injector.ts:25`) splices a whole profile
document (the person's `me.md`) in *before* template rendering, so the
result is still a valid template with its `{schema}` placeholders intact.
The RAG-query agent uses it (`packages/agents/rag-query/src/rag-query-agent.ts:55`).
Same idea — per-call context, one named channel.

### Section 3 — few-shot examples (the slot, mostly empty)

Here's where aptkit teaches by what it *doesn't* do. The `PromptPackage`
type has an `examples` field:

```ts
// packages/prompts/src/types.ts:7
export type PromptExample = {
  name: string;
  input: Record<string, unknown>;
  expectedContains?: string[];   // ← note: this is an eval assertion
};
```

In a textbook prompt, examples get rendered into the system text to
constrain output format. In aptkit they don't. `renderPromptTemplate` only
substitutes `{var}`; nothing iterates `examples[]` into the prompt string.
Those `expectedContains` arrays feed the eval layer instead — they're test
fixtures, not prompt content. So the few-shot *section* exists structurally
but is `not yet exercised` as spliced prompt text. Concept 8 covers the
consequences; for anatomy the lesson is just: know which sections your
system actually populates. A slot that exists but isn't filled is a trap for
the next engineer who assumes it is.

### Section 4 — the user message (the only true variable)

The user message is the question, and it's the one section that genuinely
changes every turn:

```ts
// packages/runtime/src/run-agent-loop.ts:94
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];
```

Everything the loop appends after this — assistant turns, tool results — is
also user/assistant message content, but the *seed* is this one line. The
boundary condition: anything you put in the user message, an attacker who
controls the question can influence. That's why concept 12 (injection
defense) cares so much about keeping the *contract* in the system prompt and
treating the user message as data.

### The decomposition rule

One job per section, named explicitly. Role and rules → system. Per-call
facts → context injection, through one channel. Format constraints →
examples. The actual request → user message. The principle that generalizes
beyond aptkit: **a prompt is not a string, it's a record with typed fields,
and drift is what happens when two fields get merged.** The moment a
per-call fact lives in the constant section, you've created a bug that won't
show up until the second caller.

## Primary diagram

The full anatomy, every section labelled with its owner and lifetime.

```
  Production prompt anatomy — aptkit query agent

  ┌──────────────────────────────────────────────────────────────┐
  │ SYSTEM PROMPT            owner: PromptPackage   lifetime: const │
  │   role + hard rules + tool policy + output contract            │
  │   query.ts:3  "You are an AI analyst ... No JSON required"     │
  ├──────────────────────────────────────────────────────────────┤
  │ CONTEXT INJECTION        owner: assembly        lifetime: call  │
  │   {schema} {project_id} {intent}  via renderPromptTemplate     │
  │   + profile  via injectProfile (before render)                 │
  ├──────────────────────────────────────────────────────────────┤
  │ FEW-SHOT EXAMPLES        owner: PromptPackage   lifetime: const │
  │   examples[]  ← SLOT EXISTS, feeds evals, NOT spliced in       │
  ├──────────────────────────────────────────────────────────────┤
  │ USER MESSAGE             owner: runtime         lifetime: turn  │
  │   { role:'user', content: question }  run-agent-loop.ts:94     │
  └──────────────────────────────────────────────────────────────┘
   drift = a per-call fact leaking up into a const section
```

## Elaborate

The four-section model is the common denominator across every chat-model
API — OpenAI's `messages` roles, Anthropic's `system` + `messages` split,
Gemma's flattened `system`/`user`/`assistant` (see
`buildMessages`, `gemma-provider.ts:94`). The names differ; the
constant-vs-per-call distinction does not. Anthropic's prompt-engineering
guide and the OpenAI cookbook both push the same decomposition: stable role
and rules up top, variable input below. aptkit's `PromptPackage` is that
decomposition reified into a type — which is the subject of concept 3.

The reason this matters more for a local model: with a cloud model you can
afford a sloppy, long system prompt because the context window is huge. With
Gemma running on a laptop, every section competes for a smaller window, and
a per-call fact bloating the "constant" section costs you tokens on every
call. Anatomy discipline is also token discipline (concept 4).

## Interview defense

**Q: What are the sections of a production prompt and who owns each?**

System (constant role/rules, owned by the prompt package), context injection
(per-call facts, owned by the assembly step), few-shot examples (format
constraints, owned by the package), user message (the request, owned by the
runtime). The dividing line is constant-vs-per-call.

```
  const ──────────────┬────────────── per-call
  system, examples     │  context injection, user message
        the seam where drift happens ↑
```

Anchor: "In aptkit, `query.ts` is the constant system literal;
`query-agent.ts:79` fills the per-call slots through `renderPromptTemplate`.
The bug I watch for is a per-call fact hardcoded into the literal."

**Q: aptkit's `PromptPackage` has an `examples` field. Is that few-shot?**

Structurally yes, operationally no. The examples aren't rendered into the
prompt — `renderPromptTemplate` only does `{var}` substitution. The
`expectedContains` arrays feed evals. The slot exists; the splice doesn't.
Naming that gap is the signal you actually read the code, not just the type.

Anchor: "Slot exists in `types.ts:7`, never spliced — it's an eval fixture."

## See also

- [03-prompts-as-code.md](03-prompts-as-code.md) — the `PromptPackage` type
  as version-controlled source
- [04-token-budgeting.md](04-token-budgeting.md) — why bloating the constant
  section costs tokens every call
- [08-few-shot.md](08-few-shot.md) — the examples slot, and why it's empty
- [12-prompt-injection-defense.md](12-prompt-injection-defense.md) — keeping
  the contract in system, treating the user message as data
