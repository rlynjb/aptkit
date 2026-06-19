# 01 — Anatomy of a production prompt

**Industry name(s):** system prompt / context injection / few-shot / user
message. **Type:** Language-agnostic.

## Zoom out, then zoom in

Before you reason about a single instruction, look at where a prompt sits in the
machine. In AptKit a prompt is not a string you pass to `complete()` — it's a
structured envelope that gets assembled, rendered, and forced through a loop.

```
  Zoom out — where a prompt's anatomy lives

  ┌─ Prompt layer (packages/prompts/src) ───────────────────────┐
  │  ★ THE FOUR SECTIONS ★                                       │ ← we are here
  │  system literal  +  {var} holes  +  examples[]  +  user msg  │
  └───────────────────────────┬──────────────────────────────────┘
                             │  renderPromptTemplate fills the holes
  ┌─ Runtime layer ──────────▼──────────────────────────────────┐
  │  runAgentLoop: system + messages → Provider.complete         │
  └───────────────────────────┬──────────────────────────────────┘
                             │  provider request
  ┌─ Provider layer ─────────▼──────────────────────────────────┐
  │  anthropic / openai / fallback / local guard                 │
  └───────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern: a production prompt has four sections, each with one
job. The system prompt holds what's constant across every call. Context
injection holds what changes per workspace but not per question. Few-shot
examples pin the output shape. The user message holds the one variable thing —
the actual question or task. Mix those jobs into one blob and the prompt drifts:
nobody can tell which line is policy and which line is data.

## Structure pass

**Layers.** Two: the *template* (the literal string with `{var}` holes) and the
*rendered instance* (holes filled, ready for the provider). The four anatomy
sections live in the template; the runtime produces the instance.

**Axis — held constant: "is this constant or per-call?"** Trace it down:

```
  One question across the four sections: constant or per-call?

  ┌─ system prose ────────────┐   → CONSTANT  (ships with the package)
  │ "You are a recommendation │
  │  agent... read-only..."   │
  └───────────────────────────┘
  ┌─ {schema} injection ──────┐   → PER-WORKSPACE (changes per tenant, not per Q)
  │ schemaSummary(workspace)  │
  └───────────────────────────┘
  ┌─ examples[] ──────────────┐   → CONSTANT  (pinned shape, ships with package)
  └───────────────────────────┘
  ┌─ user message ────────────┐   → PER-CALL  (the actual question/task)
  └───────────────────────────┘
```

**Seam — the `{var}` boundary.** The load-bearing seam is the substitution point
in `renderPromptTemplate`. On the template side, `{schema}` is a hole; on the
rendered side, it's deterministic text. The axis flips here: above it everything
is constant, at it the per-workspace and per-call values get poured in. That's
the joint to study before any instruction wording.

## How it works

#### Move 1 — the mental model

You already build React components with props: the JSX is the constant
structure, the props are what changes per render. A prompt's anatomy is the same
split. The system prompt is the JSX; the variables are the props. You write the
structure once and pour different values through it.

```
  The four-section prompt — shape

  ┌───────────────────────────────────────────────┐
  │ SYSTEM  (constant)                             │
  │   role · hard rules · output contract          │
  │   ┌─────────────────────────────────────────┐  │
  │   │ CONTEXT INJECTION  {schema} {diagnosis}  │  │ ← per-workspace / per-task
  │   ├─────────────────────────────────────────┤  │
  │   │ FEW-SHOT  examples[]                     │  │ ← pinned output shape
  │   └─────────────────────────────────────────┘  │
  └───────────────────────────────────────────────┘
  ┌───────────────────────────────────────────────┐
  │ USER MESSAGE  (per-call)                       │ ← the one variable thing
  │   "Propose recommendations for this diagnosis" │
  └───────────────────────────────────────────────┘
```

#### Move 2 — the walkthrough

**The system prompt — role, rules, output contract.** This is the part the
reader already expects. It opens by naming the role ("You are a recommendation
agent for an ecommerce workspace. You are read-only"), states hard rules as a
numbered list, and ends with the output contract. It's constant: it ships inside
the package and never changes between calls. **Breaks if missing:** the model has
no frame, picks its own behavior per call, and your outputs are inconsistent run
to run.

```
  System prompt — three constant blocks

  ┌─ role ────────┐  "You are X. You are read-only."
  ┌─ hard rules ──┐  "1. Pass project_id. 2. At most 4 tool calls. ..."
  ┌─ output ──────┐  "Return ONLY a JSON array of at most 3 objects."
```

**Context injection — the `{var}` holes.** Per-workspace facts the model needs
but that don't change per question: the schema summary, the diagnosis to act on,
the classified intent. These are holes in the template, filled at render time.
**Breaks if missing:** the model hallucinates the schema, invents event names,
or answers about the wrong tenant.

```
  Context injection — holes filled per call

  template:   "...## Workspace schema\n{schema}"
                                       │ render
  instance:   "...## Workspace schema\nProject: Olist (proj_123)\n
               Total customers: 99,441\nTop events: purchase, view_item..."
```

**Few-shot examples — pinned shape.** A short list of input → expected-contains
pairs that show the model the output form it should produce. In AptKit these
live in the package's `examples[]` array and inside the system prose itself (the
query prompt's "Tool catalog reminders" are worked EQL examples). **Breaks if
missing:** for format-sensitive tasks, the model free-styles the structure and
your parser misses. (Full treatment in 08.)

**The user message — the one per-call variable.** Everything above is reusable;
the user message is the single thing that changes per invocation. In the
recommendation agent it's a fixed instruction string ("Propose recommendations
for this diagnosis and return the JSON array"); in the query agent it's the
literal user question. **Breaks if missing:** there's nothing for the model to
act on.

#### Move 3 — the principle

One job per section, named explicitly. The reason this matters isn't tidiness —
it's drift. When constant policy and per-call data live in the same paragraph,
the next person who "just adds one instruction" can't tell whether they're
editing the contract or the data, and the prompt slowly rots. Separation is what
lets you change the schema injection without touching the rules, and change the
rules without re-testing every workspace.

## Primary diagram

The full anatomy, assembled, as `runAgentLoop` sees it.

```
  Assembled prompt — what reaches Provider.complete()

  system  = renderPromptTemplate(PACKAGE.system, {
              schema:     schemaSummary(workspace),   ← context injection
              project_id: workspace.projectId,        ← context injection
              diagnosis:  JSON.stringify(diagnosis),  ← context injection
            })
            └─ contains: role + hard rules + output contract + examples (constant)

  messages = [{ role: 'user', content: userPrompt }] ← the one per-call variable

  on the LAST turn:
  system = `${system}\n\n${synthesisInstruction}`     ← forced final answer (02, 09)
```

## Implementation in codebase

**Use cases.** Every one of the four agents assembles a prompt this way. The
cleanest example is the recommendation agent, which injects three context
variables and a constant output contract.

The `PromptPackage` type defines the envelope — the system string plus its
declared variables and examples:

```
  packages/prompts/src/types.ts  (lines 13–22)

  export type PromptPackage = {
    id: string;            ← provenance (see 03)
    version: string;       ← provenance (see 03)
    capabilityId: string;  ← which agent owns this prompt
    description: string;
    system: string;        ← the constant system section
    compactSystem?: string;← shorter variant (declared, not yet used — see 04)
    variables: PromptVariable[]; ← declares the {var} holes
    examples: PromptExample[];   ← few-shot (see 08)
  };
```

The recommendation system prompt shows the four sections in one literal — role,
hard rules, the `{diagnosis}` and `{schema}` injection holes, and the output
contract:

```
  packages/prompts/src/recommendation.ts  (lines 3–76, excerpt)

  `You are a recommendation agent for an ecommerce workspace.       ← ROLE
   You are read-only: you do NOT execute anything.
   ...
   ## Hard rules                                                     ← RULES
   1. Pass project_id: {project_id} to every tool call...
   ...
   ## The diagnosis to act on
   {diagnosis}                                                       ← CONTEXT INJECTION
   ...
   ## Output
   Return ONLY a JSON array ... of at most 3 objects.                ← OUTPUT CONTRACT
   ...
   ## Workspace schema
   {schema}`                                                         ← CONTEXT INJECTION
       │
       └─ the {diagnosis} and {schema} holes are the per-task seam; everything
          else is constant and ships with the package. Mixing a per-call fact
          into the rules section is how this prompt would start to drift.
```

And the render call that fills the holes — the user message is the one per-call
variable, separate from the system:

```
  packages/agents/recommendation/src/recommendation-agent.ts  (lines 71–82)

  const system = renderPromptTemplate(this.prompt, {
    schema: schemaSummary(this.options.workspace),       ← per-workspace
    project_id: this.options.workspace.projectId,        ← per-workspace
    diagnosis: JSON.stringify(diagnosis),                ← per-task
  });
  ...
  userPrompt: 'Propose recommendations for this diagnosis and return the JSON array.',
       │
       └─ system carries the four constant/injected sections; userPrompt is the
          single per-call message. Clean separation = the seam stays clean.
```

## Elaborate

The four-section split is the oldest stable convention in production prompting —
it predates tool calling and survives every model upgrade because it's about
*ownership of lines*, not provider syntax. Anthropic's prompt guide and the
OpenAI cookbook both land on the same decomposition under different names.

Where it connects: the system/user split is also a trust boundary (12 — user
content belongs in the user message, never spliced into the system rules), and
the output-contract section is where structured-output discipline starts (02).
Read 03 next for why the whole envelope carries a version.

## Interview defense

**Q: Why split system from user instead of one big prompt?**
Constant vs per-call. The system prompt is the contract — role, rules, output
shape — and ships with the package, versioned. The user message is the one thing
that changes per call. Separation is what stops drift: you can change the schema
injection without re-testing the rules.

```
  ┌─ system (constant, versioned) ─┐  seam  ┌─ user (per-call) ─┐
  │ role + rules + output contract │ ═════► │ the question/task │
  └────────────────────────────────┘ (flip) └───────────────────┘
   constant ──────────────────────── axis ──────────── per-call
```
Anchor: "constant lives in `system`, per-call lives in `messages` —
`recommendation-agent.ts:71`."

**Q: Where does context injection go and why not the user message?**
In the system prompt, at a named `{var}` hole. Schema is per-workspace, not
per-question — it's stable across many user messages for the same tenant, so it
belongs with the constant contract, filled once per render by
`renderPromptTemplate`. Putting it in the user message re-sends it every turn and
muddies the trust boundary.
Anchor: "`{schema}` is per-workspace context, filled at `types.ts:24`."

## Validate

- **Reconstruct:** Draw the four sections and label each constant / per-workspace
  / per-call, without opening the file.
- **Explain:** Why does `renderPromptTemplate` (`packages/prompts/src/types.ts:24`)
  leave an unknown `{var}` untouched instead of erroring? (Hint: the regex
  returns `match` when the value is undefined.) What does that buy and what does
  it risk?
- **Apply:** A new agent needs a per-call `{customer_id}`. Which section does it
  go in, and where in `recommendation-agent.ts:71` do you wire it?
- **Defend:** Someone wants to move the `## Hard rules` into the user message "so
  it's easier to tweak per request." Argue against it using the constant/per-call
  axis.

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — the output-contract section, enforced.
- [03-prompts-as-code.md](03-prompts-as-code.md) — why the envelope carries id + version.
- [08-few-shot.md](08-few-shot.md) — the examples section in depth.
- [12-prompt-injection-defense.md](12-prompt-injection-defense.md) — the system/user split as a trust boundary.
