# 11 — Meta-prompting

**Subtitle:** meta-prompting — an LLM writes prompts for another LLM call
(Industry standard)

## Zoom out, then zoom in

Meta-prompting is using a model to write or improve the prompts that other
model calls consume. aptkit is *built by* this workflow — its slash-command
toolchain leans on an LLM to draft prompts and study guides — but inside the
runtime, prompts are assembled by deterministic string code, not generated
by a model at runtime. The distinction matters: meta-prompting is an
authoring-time practice here, not a runtime one.

```
  Zoom out — meta-prompting at authoring time, not runtime

  ┌─ Authoring time (LLM drafts prompts) ───────────────────────┐
  │  ★ human writes goal → LLM drafts prompt → human reviews ★    │ ← we are here
  │     → prompt enters the codebase as a PromptPackage          │
  │     (aptkit's slash commands lean on this under the hood)    │
  └───────────────────────────┬──────────────────────────────────┘
                              │ committed prompt
  ┌─ Runtime (deterministic assembly) ▼───────────────────────────┐
  │  renderPromptTemplate({var}) + injectProfile — STRING code,   │
  │  no model generates a prompt at runtime → NOT YET EXERCISED   │
  └────────────────────────────────────────────────────────────────┘
```

Zooming in: the meta-prompting workflow is human writes the goal → LLM drafts
the prompt → human reviews and edits → prompt enters the codebase. The
review step is load-bearing: it's what keeps the prompt from reading like LLM
output instead of an engineering spec. aptkit's runtime prompt *assembly* is
deterministic, so the meta-prompting in this repo lives in how its prompts
and docs were authored, not in a runtime self-prompting loop.

## Structure pass

**Layers.** Authoring (LLM drafts, human reviews) → source (committed
`PromptPackage`) → runtime (deterministic assembly).

**Axis — what writes the prompt text?** Trace it:

```
  Axis: "what produces the prompt string?"

  authoring time   → an LLM drafts it (then a human edits)   ← meta-prompting
  committed source → a static template literal              (frozen draft)
  runtime assembly → renderPromptTemplate, string substitution (deterministic)
  runtime model    → does NOT generate prompts for other calls → not exercised
```

**Seam.** The boundary between *authoring* and *runtime* is the load-bearing
one. Meta-prompting happens on the authoring side of that seam — a model
helps write the template. Once the template crosses into source, runtime
treats it as fixed and assembles it with pure string code. Conflating the two
sides is the mistake: a runtime that lets a model rewrite the prompt is a
different, riskier system than one that assembles a reviewed template.

## How it works

You know how you might ask a model to scaffold a component, then read and fix
every line before committing? Meta-prompting is that for prompts: the model
drafts, you review, the result enters the repo as code you own. Let's walk
where this lives in aptkit and where it deliberately stops.

### Step 1 — the authoring workflow (how these prompts were born)

aptkit's interface is slash commands that compose markdown templates into
prompts (per the project context — "markdown-as-source-of-truth, prompt
templates as code, slash commands as the interface"). The study guide you're
reading and the prompt packages were drafted through exactly the
meta-prompting loop:

```
  Pattern — the meta-prompting authoring loop

  ┌──────────────────────────────────────────────────────┐
  │ 1. human writes the GOAL (a spec, a capability intent) │
  │ 2. LLM DRAFTS the prompt / template                    │
  │ 3. human REVIEWS and edits  ← the load-bearing step    │
  │ 4. prompt enters the codebase as a PromptPackage       │
  │ 5. from here, runtime treats it as fixed source        │
  └──────────────────────────────────────────────────────┘
```

The output of this loop is the static system literals you've seen —
`QUERY_PROMPT`, `RECOMMENDATION_PROMPT`. They read like engineering specs
(numbered hard rules, explicit output contracts), not like model chatter,
*because* a human edited them after the draft. Skip step 3 and you get the
failure mode below.

### Step 2 — runtime assembly is deterministic, not generative

At runtime, no model writes a prompt. The assembly is pure string code:

```ts
// packages/prompts/src/types.ts:24
export function renderPromptTemplate(template, variables): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, name) =>
    variables[name] === undefined ? m : variables[name]);
}
```

```ts
// packages/context/src/profile-injector.ts:25 — also pure string-in/string-out
export function injectProfile(systemTemplate, profileText, opts): string {
  const block = opts?.heading ? `${opts.heading}\n${profileText}` : profileText;
  return opts?.position === 'end' ? `${systemTemplate}\n\n${block}`
                                  : `${block}\n\n${systemTemplate}`;
}
```

Both are deterministic transforms. A model is never in the loop that builds
the prompt sent to another model. So *runtime* meta-prompting — a model
generating a prompt for a downstream call — is `not yet exercised`. The
meta-prompting in this repo is the authoring history of those literals.

### Step 3 — when meta-prompting saves time, when it doesn't

```
  Comparison — meta-prompting fit

  initial drafting of a complex prompt → USE (LLM gets you to a v0 fast)
  a study guide / a long template      → USE (aptkit's docs were drafted so)
  a small tweak to a live prompt       → SKIP (faster to edit by hand)
  a prompt under high iteration pressure→ SKIP (the eval loop is the tool,
                                              not a re-draft each cycle)
```

The rule of thumb: meta-prompting is a *drafting* accelerator. It gets you
from a blank file to a reviewable v0. Once a prompt is live and you're tuning
it against evals (concept 5), the eval loop — not another LLM draft — is the
right tool. Re-drafting a live prompt with a model throws away the
hard-won, eval-tested edits.

### Step 4 — the risk: prompts that read like LLM output

The failure mode meta-prompting invites: a prompt that sounds like a model
wrote it — hedged, padded, vague ("please try your best to be helpful and
thorough"). Compare that to aptkit's actual prompts, which are terse and
spec-like:

```ts
// packages/prompts/src/recommendation.ts:18 — reads like a spec, not chatter
## Hard rules
1. Pass project_id: {project_id} to every tool call when a tool accepts ...
2. Make at most 4 tool calls. Mostly reason from the diagnosis ...
4. Each recommendation MUST set bloomreachFeature to exactly one ...
```

Numbered, imperative, testable. That's the human review step (step 1's #3)
having done its job — the LLM draft got edited down into an engineering
artifact. The risk is real precisely when you skip the review and commit the
draft.

### The principle

**Meta-prompting is an authoring accelerator — a model drafts, a human
reviews into a spec, the result enters the codebase as owned source.** Keep
it on the authoring side of the seam: runtime should assemble reviewed
templates deterministically, not let a model rewrite the prompt on the fly.
And never skip the review — an unedited LLM-drafted prompt reads like
chatter, not a contract.

## Primary diagram

The authoring loop, the seam, and the deterministic runtime.

```
  Meta-prompting in aptkit — authoring vs runtime

  ┌─ AUTHORING (meta-prompting lives here) ─────────────────────┐
  │  goal ─► LLM drafts ─► HUMAN REVIEWS/EDITS ─► PromptPackage  │
  │  slash commands compose markdown templates under the hood    │
  └────────────────────────────┬──────────────────────────────────┘
              ════════════════ seam ════════════════
                              │ committed, frozen source
  ┌─ RUNTIME (deterministic, no model writes prompts) ▼───────────┐
  │  renderPromptTemplate({var})  +  injectProfile(profile)       │
  │  pure string transforms → the prompt sent to the model        │
  │  runtime meta-prompting → NOT YET EXERCISED                   │
  └────────────────────────────────────────────────────────────────┘
   risk if review skipped: a prompt that reads like LLM output, not a spec
```

## Elaborate

Meta-prompting spans a spectrum: at the light end, using a model to draft a
prompt you then own (aptkit's authoring practice); at the heavy end, runtime
systems where a model generates the next prompt in a chain (prompt-rewriting
agents, automatic prompt optimization like DSPy or APE). aptkit sits firmly
at the light end — its slash-command toolchain is a meta-prompting authoring
surface, and its runtime is deterministic by design.

That design choice is defensible for a toolkit: deterministic assembly is
reviewable, testable, and reproducible (it feeds the replay eval pipeline,
concept 5). A runtime that regenerates prompts would break replay
determinism. So the absence of runtime meta-prompting isn't a gap to rush to
fill — it's a deliberate boundary that keeps the system testable.
Automated prompt *optimization* (a model searching prompt-space against an
eval) is the genuinely-unbuilt extension, and it would compose with the
existing eval harness.

## Interview defense

**Q: What is meta-prompting and where does it belong?**

Using an LLM to write or improve prompts for other LLM calls. It belongs at
authoring time: a model drafts, a human reviews the draft into an engineering
spec, the result enters the codebase as owned source. Keep it off the runtime
path — a system that lets a model rewrite prompts on the fly is harder to
test and breaks replay determinism. aptkit's slash-command toolchain is the
authoring surface; its runtime assembly (`renderPromptTemplate`,
`injectProfile`) is pure deterministic string code.

```
  authoring: LLM drafts → human reviews → committed spec
  runtime:   deterministic string assembly (no model writes prompts)
```

Anchor: "aptkit's prompts read like specs — numbered hard rules, explicit
output contracts — because a human edited the LLM draft. Runtime is
deterministic; runtime meta-prompting isn't exercised, and that keeps replay
deterministic."

**Q: What's the risk of meta-prompting, and how do you avoid it?**

Prompts that read like LLM output — hedged, padded, vague — instead of like
specs. The avoidance is the human review step: edit the draft down to
numbered, imperative, testable instructions. And scope it to drafting; once a
prompt is live, tune it against evals rather than re-drafting it with a model,
or you throw away eval-tested edits.

Anchor: "Skip the review → chatter prompts. aptkit's
`recommendation.ts` hard-rules are the reviewed-spec shape."

## See also

- [03-prompts-as-code.md](03-prompts-as-code.md) — the committed
  `PromptPackage` the authoring loop produces
- [01-anatomy.md](01-anatomy.md) — `injectProfile` and template rendering as
  the deterministic assembly
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — the tool for
  tuning a live prompt instead of re-drafting it
