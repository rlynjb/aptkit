# Context Engineering

**Industry standard.** "Context engineering," "context assembly," "prompt assembly." Type label: discipline (the superset of prompt engineering + RAG). **In this codebase: yes — `injectProfile` and `schemaSummary` are aptkit's context-assembly primitives.**

## Zoom out, then zoom in

Context engineering is the discipline RAG and prompt engineering are subsets of: it's *everything the model sees at inference time*, and the job is curating what fills the window for the next step. aptkit has two pure context-assembly functions — `injectProfile` (splices the user profile) and `schemaSummary` (renders workspace metadata) — that decide what goes in the window before the loop ever runs.

```
  Zoom out — context engineering is the superset

  ┌───────────────────────────────────────────────┐
  │            Context engineering                │
  │  (everything the model sees at inference time)│
  │   ┌─────────────┐  ┌─────────────┐            │
  │   │   prompt    │  │     RAG     │            │
  │   │ (template)  │  │ search_kb   │            │
  │   └─────────────┘  └─────────────┘            │
  │   ┌─────────────┐  ┌─────────────┐            │
  │   │ ★injectProfile│ │★schemaSummary│           │ ← we are here
  │   │ (user state) │  │ (workspace) │            │
  │   └─────────────┘  └─────────────┘            │
  └───────────────────────────────────────────────┘
```

## Structure pass

**Axis: what fills the window, and who decides?** Trace the rag-query agent's system prompt assembly: a template + an injected profile + (at runtime) retrieved chunks. Each piece is a context decision made by *code* before the model sees it. The seam is between context-assembly (code curates the window) and the loop (model consumes it). aptkit's context functions are *pure string→string* — no `fs`, no side effects — which makes the assembly testable and deterministic.

## How it works

### Move 1 — the mental model

Prompt engineering writes the instructions; context engineering decides *everything else* in the window — user state, retrieved facts, workspace schema, tool outputs. You know how a component's render depends on its props *and* its context *and* fetched data? Context engineering is assembling all of those into the model's input.

```
  Context engineering = assembling the whole window, not just the prompt

  template (instructions)
     + injectProfile(user me.md)      ← who it's serving
     + schemaSummary(workspace)        ← what data exists
     + retrieved chunks (at runtime)   ← grounding
     ───────────────────────────────
     = the system prompt the model sees
```

### Move 2 — aptkit's two assembly primitives

**`injectProfile` — splice the user's profile into the system template.** Pure string-in/string-out; the caller reads the file, this function never touches `fs`.

```typescript
// packages/context/src/profile-injector.ts:25, 33-37
export function injectProfile(systemTemplate, profileText, opts?) {
  const block = heading ? `${heading}\n${profileText}` : profileText;
  return position === 'end'
    ? `${systemTemplate}\n\n${block}`
    : `${block}\n\n${systemTemplate}`;   // ← default: prepend the profile
}
```

The subtle, important detail: injection happens *before* template rendering (the docstring, line 15-18), so `{placeholder}`s in the template survive untouched for `renderPromptTemplate` to fill later. The rag-query agent uses it to make answers personal (`rag-query-agent.ts:55`): the user's `me.md` becomes a `# About the person you are assisting` block at the top of the system prompt. That's context engineering — the model now answers *for this user*, not generically.

**`schemaSummary` — render workspace metadata into the window.** The analytics agents (recommendation, monitoring, diagnostic) get a deterministic summary of the workspace's schema (events, catalogs, totals, data horizon) so the model knows what data it can reason about.

```typescript
// packages/agents/recommendation/src/recommendation-agent.ts:71-75
const system = renderPromptTemplate(this.prompt, {
  schema: schemaSummary(this.options.workspace),   // ← workspace shape → window
  project_id: this.options.workspace.projectId,
  diagnosis: JSON.stringify(diagnosis),            // ← upstream context (the pipeline message)
});
```

Three context pieces assembled: the schema (what data exists), the project id, and the diagnosis (the upstream agent's output). The model sees exactly the context it needs to propose grounded actions.

**The reframe to hold onto.** Most agent failures are not model failures — they're *context* failures: stale retrieval, lost-in-the-middle on a bloated window, no user state loaded, the wrong tool outputs in the window. Prompt engineering gets the first good output; context engineering keeps the thousandth good. Bigger context windows don't solve this — they make room for more noise. aptkit's pure assembly functions are the discipline applied: each one is a deliberate decision about what fills the window, testable in isolation.

### Move 3 — the principle

The job is curating what fills the window for the next step — and in a multi-agent system, *which agent sees what* (the context routing from SECTION C file 08). aptkit's `injectProfile` and `schemaSummary` are the single-agent version: deterministic, pure, testable assembly of user state and workspace shape into the window. The discipline is the same whether you're filling one agent's window or routing context across a topology.

## Primary diagram

```
  Context assembly for the rag-query agent — full frame

  ┌─ assembly (code, pure, before the loop) ────────────────┐
  │  DEFAULT_SYSTEM_TEMPLATE ("search first, ground, cite")  │
  │       + injectProfile(me.md, position: start)            │ profile-injector.ts:25
  │       → renderPromptTemplate(withProfile, {})            │
  │  = this.system                                           │
  └───────────────────────────┬──────────────────────────────┘
                              ▼ (at runtime, the loop adds)
  ┌─ runtime context ─────────────────────────────────────────┐
  │  + retrieved chunks (search_knowledge_base results)        │
  │  + tool results (accumulated in messages)                  │
  └─────────────────────────────────────────────────────────────┘
              = everything the model sees at inference time
```

## Elaborate

Context engineering is the name the field landed on once it became clear that prompt wording was a small part of the problem — what *else* is in the window (retrieval, memory, user state, history, tool outputs) determines quality far more than phrasing. aptkit's design choice to make context assembly *pure functions* (no `fs`, string→string) is the right one: it makes the window contents deterministic and unit-testable, and it keeps the assembly logic out of the agent loop. The injection-before-rendering order is a small but real piece of engineering — it lets profile injection and template rendering compose without fighting over `{placeholders}`.

## Interview defense

**Q: How do you control what the model sees?**
Context engineering — pure assembly functions that run before the loop. `injectProfile` splices the user's profile into the system template (so answers are personalized), and `schemaSummary` renders the workspace's data shape into the window (so the model knows what it can reason about). Both are string→string, no side effects, so the window contents are deterministic and testable. The key detail: injection happens before template rendering, so `{placeholders}` survive.

```
  template + injectProfile(user) + schemaSummary(data) + retrieved chunks
  = the window (curated by code, consumed by the model)
```
*Anchor: most agent failures are context failures, not model failures.*

**Q: Doesn't a bigger context window solve this?**
No — it makes room for more noise. The job is curating *what* fills the window, not fitting more in. Lost-in-the-middle gets worse with a fuller window, not better.

## See also

- `02-agentic-retrieval/01-agentic-rag.md` — injectProfile as Package C
- `02-agent-memory-tiers.md` — memory as another context source
- `03-multi-agent-orchestration/08-shared-state-and-message-passing.md` — context routing across agents
- `study-prompt-engineering/` — the prompt-template mechanics (cross-ref)
- `study-ai-engineering/` — context-window and lost-in-the-middle mechanics (cross-ref)
