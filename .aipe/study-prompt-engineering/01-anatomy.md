# 01 — Anatomy of a production prompt

**Industry name:** prompt structure / message-role decomposition — *Language-agnostic*

## Zoom out, then zoom in

Every prompt you send is four things wearing one coat: a *system* instruction
(constant), some *context* spliced in (per-call data), maybe a few *examples*,
and the *user message* (the actual ask). Junior prompts blend all four into one
blob. Production prompts keep them separate, because the seams between them are
where every drift bug lives.

Here's where the four sections sit in this repo's assembly path.

```
  Zoom out — the four sections, and who owns each

  ┌─ Authoring (constant across calls) ───────────────────────────┐
  │  ★ SYSTEM ★  packages/prompts/src/query.ts QUERY_PROMPT        │ ← we are here
  │  ★ FEW-SHOT ★ examples[] in the PromptPackage (mostly inline)  │
  └───────────────────────────┬───────────────────────────────────┘
                              │  renderPromptTemplate({schema, intent...})
  ┌─ Assembly (per call) ─────▼───────────────────────────────────┐
  │  ★ CONTEXT ★  {schema}, {intent}, {anomaly} spliced in         │
  │  ★ USER ★     messages:[{role:'user', content: question}]      │
  └───────────────────────────┬───────────────────────────────────┘
                              │  ModelRequest → provider.complete()
  ┌─ Model ───────────────────▼───────────────────────────────────┐
  │  system string + messages[] arrive as distinct fields          │
  └────────────────────────────────────────────────────────────────┘
```

Now zoom in. The thing worth learning isn't "prompts have sections" — it's the
*decomposition rule*: **one job per section, named explicitly, and the constant
stuff never mixes with the per-call stuff.** Break that rule and you get the
classic Friday bug where someone edits the system prompt to fix one query and
silently changes behavior for every query.

## The structure pass

**Layers:** authoring (the template, written once) → assembly (the per-call
render) → model (the wire format: a `system` field plus a `messages[]` array).

**Axis — what changes per call?** Trace it down the stack:

```
  One axis: "does this change per call?" — traced down the layers

  ┌──────────────────────────────────────────┐
  │ SYSTEM string (role, hard rules)          │  → NO  (constant)
  └──────────────────────────────────────────┘
      ┌──────────────────────────────────────┐
      │ {schema} {intent} {anomaly} context   │  → YES (per workspace/call)
      └──────────────────────────────────────┘
          ┌──────────────────────────────────┐
          │ user message (the question)       │  → YES (every call)
          └──────────────────────────────────┘

  the answer flips at the {placeholder} boundary — that's the seam
```

**Seam:** the `{placeholder}` boundary inside the template. Above it, constant
instructions; below it, interpolated data. `renderPromptTemplate`
(`packages/prompts/src/types.ts:24`) is literally the machine that crosses that
seam. If constant rules leak below the seam (hardcoding a project id into the
system text instead of passing `{project_id}`), you've coupled the prompt to one
caller. If per-call data leaks above it (pasting a question into the system
string), you've made the constant part non-constant — and your prompt versioning
(concept 03) now lies.

## How it works

### Move 1 — the mental model

You already know this shape from React: a component has **props** (constant
config passed once), **state/data** (changes per render), and **children** (the
actual content). A prompt is the same split. The system text is your props. The
interpolated context is your data. The user message is your children. Mixing
them is like hardcoding a fetch response inside a component's default props —
it works in the demo and rots the moment anything varies.

```
  Pattern — the four sections of one prompt

       ┌─────────────── one ModelRequest ───────────────┐
       │                                                 │
   system: "You are an AI analyst...     ← SECTION 1: role + hard rules
            ## Hard rules ...                (constant, authored once)
            ## Workspace schema {schema}" ← SECTION 2: context injected
                                              (per-call data)
   messages: [
     { role:'user', content: question }  ← SECTION 4: the actual ask
   ]
   (examples[] on the package)           ← SECTION 3: few-shot (optional)
       │                                                 │
       └─────────────────────────────────────────────────┘
```

### Move 2 — walking the real prompt

**The system section carries role + hard rules.** Open
`packages/prompts/src/query.ts:3`. The `QUERY_PROMPT` opens with "You are an AI
analyst for an ecommerce workspace," then a `## Role`, then `## Hard rules`
(numbered, imperative), then `## Output`. This is the constant skeleton — it's
identical whether the question is about revenue or refunds. **What breaks if it's
missing:** the model has no role, no output contract, no guardrails — you get
freeform prose where you wanted a bounded answer.

```
  Inline annotation — query.ts:3 QUERY_PROMPT

  "You are an AI analyst for an ecommerce workspace..."   ← role (constant)
  "## Hard rules
   1. ...pass project_id: {project_id} ..."               ← rule + a {var} seam
  "## Output
   Give a clear, concise answer in plain prose..."        ← output contract
  "## Workspace schema
   {schema}"                                              ← context seam (data)
```

**The context section is everything inside `{...}`.** `{schema}`, `{intent}`,
`{project_id}` are placeholders. They're resolved at call time by
`renderPromptTemplate` (`types.ts:24`), a 4-line regex substitution. **What
breaks if you mix this with the system section:** suppose someone, fixing one
workspace, replaces `{schema}` with that workspace's literal schema. Now the
template is hardcoded to one workspace; the next caller's `renderPromptTemplate`
finds no `{schema}` to substitute and silently ships a stale schema. The seam
existed precisely to stop that.

**The few-shot section is the package's `examples[]`.** On the same package
(`query.ts:79`) there's an `examples` array — `revenue-by-state` with an
`expectedContains`. In this repo these examples are not yet *spliced into the
prompt string* — they read as eval anchors and documentation. That's an honest
gap (see concept 08): the slot exists in the `PromptPackage` type
(`types.ts:7` `PromptExample`), but the wiring that turns them into in-context
few-shot examples is `not yet exercised`.

**The user section is the messages array.** In the agent loop the user message
is `[{ role: 'user', content: userPrompt }]` (`run-agent-loop.ts:94`). It is
*never* concatenated into the system string. That separation is what lets the
provider apply its own role handling (Anthropic and OpenAI treat system and user
turns differently at the model level).

### Move 3 — the principle

**A prompt is a function signature, not a paragraph.** The constant parts are
the body; the `{placeholders}` are the parameters; the user message is the
argument. The discipline that separates a prompt that survives six months from
one that drifts is the same discipline that separates a clean function from a
2000-line one: one job per section, parameters named explicitly, no global state
leaking in. Every prompt-drift incident I've debugged traced back to someone
collapsing two of these sections into one.

## Primary diagram

The full anatomy, authoring through wire.

```
  Anatomy of a production prompt — aptkit assembly path

  AUTHORING LAYER                         packages/prompts/src/query.ts
  ┌────────────────────────────────────────────────────────────────┐
  │ QUERY_PROMPT (system, constant)                                 │
  │   role + ## Hard rules + ## Output + ## Workspace schema {schema}│
  │ examples[] (few-shot slot — not yet spliced into the string)    │
  └───────────────────────────────┬──────────────────────────────────┘
            renderPromptTemplate({schema, intent, project_id})  types.ts:24
  ASSEMBLY LAYER                  ▼
  ┌────────────────────────────────────────────────────────────────┐
  │ system: rendered string   │   messages: [{role:'user', content}] │
  └───────────────────────────┴──────────────────────────────────────┘
            ModelRequest        ▼                  run-agent-loop.ts:94
  MODEL LAYER
  ┌────────────────────────────────────────────────────────────────┐
  │ provider.complete({ system, messages, tools, maxTokens })       │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The system/user split comes straight from the chat-completions message format
every major provider settled on. The reason it's a *role* distinction and not
just "first paragraph vs rest" is that providers weight system instructions
differently — and concept 12 (injection defense) leans on exactly that: a system
instruction outranks a user instruction in the model's instruction hierarchy.
Anthropic's prompt guide and the OpenAI cookbook both treat the system message
as the durable contract and the user message as the variable input — the same
props-vs-data split you already use in components.

This repo's PromptPackage adds a fifth thing the raw message format doesn't:
provenance (`id`, `version`, `capabilityId`). That's the bridge to concept 03.

## Interview defense

**Q: What are the sections of a production prompt and why keep them separate?**
System (constant role + rules), context (per-call data via placeholders), few-shot
examples, user message. Keep them separate because the constant/per-call boundary
is the seam where drift bugs live — if per-call data leaks into the constant
system text, your prompt versioning lies and the next caller gets stale data.

```
  constant ────────┊──────── per-call
  system + rules   ┊   {schema} {intent} + user question
                   ┊
              the {placeholder} seam — keep it sharp
```
*Anchor: `renderPromptTemplate` (`types.ts:24`) is the machine that crosses the seam.*

**Q: The load-bearing part people forget?** The *output contract* in the system
section (`query.ts:48` `## Output`). Drop it and the model's format becomes
nondeterministic, which breaks every downstream parser. Naming the output mode
in the system text is what makes concept 07 (output-mode mismatch) a non-issue.

## See also

- `03-prompts-as-code.md` — the provenance the PromptPackage adds on top.
- `07-output-mode-mismatch.md` — the output contract section, at depth.
- `08-few-shot.md` — the examples slot that isn't yet wired into the string.
- `12-prompt-injection-defense.md` — why the system/user role split is a defense.
