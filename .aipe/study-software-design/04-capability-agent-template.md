# 04 — The capability-agent template (the duplication)

**Industry names:** what it *should* be — Template Method / parameterised
factory. What it *is* — copy-paste-shaped boilerplate across sibling classes.
**Type:** Project-specific (this is a finding, not a pattern to copy).

This is the one file in the guide that names a weakness. The repo's foundation
is deep (`01`–`03`); this layer is the shallowest thing in it, and it's the
single highest-leverage fix. Read it back-to-back with `01` — the contrast is
the lesson.

---

## Zoom out, then zoom in

AptKit has five agents. Each is a class. Open any two of them and you'll read
the same thing twice.

```
  Zoom out — the five sibling classes

  ┌─ Capabilities (agents) ────────────────────────────────────────┐
  │  RecommendationAgent  AnomalyMonitoringAgent  DiagnosticAgent   │
  │  QueryAgent           RubricImprovementAgent                    │
  │                                                                 │
  │  each: constructor(options) { this.prompt = options.prompt ?? } │
  │  each: run() { listTools → filterToolsForPolicy →               │
  │               renderPromptTemplate → runAgentLoop → parse }     │
  │  ★ ~85% identical wiring; ~4 lines genuinely differ ★           │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ all call
  ┌─ Foundation ──────────────────▼─────────────────────────────────┐
  │  runAgentLoop  (the deep module doing the real work)            │
  └──────────────────────────────────────────────────────────────────┘
```

**Zoom in.** A *capability* in AptKit is defined as "prompt package + tool
policy + loop config + validator" (the project context says so). That's a
clean concept — and it's exactly the kind of thing that should be **one
parameterised function**: `runCapability<T>(config)`. Instead it's been hand-
copied into five classes. The concept is good; the *implementation of the
concept* duplicated it instead of abstracting it.

---

## Structure pass — layers · axis · seam

**Layers:** public class (name + type) → run method (wiring) → `runAgentLoop`
(the actual work).

**Axis — trace "what does each layer actually contribute?"**

```
  one question across the five agents: "what's unique here vs. copied?"

  ┌──────────────────────────────────────┐
  │ class name + capability type          │  → UNIQUE (and worth keeping —
  │   (QueryAgent, DiagnosticAgent)       │    it's the public surface, see 05)
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ run method body                    │  → ~85% COPIED. only the
      │   (the wiring)                     │    config values differ.
      └──────────────────────────────────┘
          ┌──────────────────────────────┐
          │ runAgentLoop                   │  → SHARED (good — already abstracted)
          └──────────────────────────────┘

  the middle layer is where the copy lives — and where the fix goes
```

**Seam:** the run method *is* a missing seam. Right now there's no boundary
between "wiring a capability" and "running a loop" — the wiring is inlined into
every agent. The fix introduces that seam: a `runCapability<T>(config)`
function the agents call, so the wiring lives in one place and each agent only
declares its config.

---

## How it works

You know how you'd never write `fetchUsers()`, `fetchPosts()`,
`fetchComments()` each with the same `fetch → check status → parse JSON →
handle error` body copy-pasted, and instead write one `getJSON(url, schema)`?
The five agents are the copy-pasted version. Here's what's shared and what
genuinely differs.

### Move 1 — the shape (what's duplicated)

```
  the copied skeleton — present in all 5 agents

  class XAgent {
    private readonly prompt: string;
    constructor(private readonly options: XOptions) {        ┐
      this.prompt = options.prompt ?? xPromptPackage.system; │ COPIED
    }                                                         ┘
    async run(input, runOptions = {}) {
      const allTools = await this.options.tools.listTools();          ┐
      const toolSchemas = filterToolsForPolicy(allTools, xToolPolicy);│
      const system = renderPromptTemplate(this.prompt, { ... });      │ COPIED
      const { parsed } = await runAgentLoop({                         │ (values
        capabilityId: X_CAPABILITY_ID,                                │  differ,
        model: this.options.model,                                    │  shape
        tools: this.options.tools,                                    │  identical)
        system, userPrompt, toolSchemas,                              │
        trace: this.options.trace, signal: runOptions.signal,         │
        maxTurns, maxToolCalls,                                       │
        synthesisInstruction: buildSynthesisInstruction('...'),       │
        parseResult, recoveryPrompt,                                  ┘
      });
      return /* light post-processing */;
    }
  }
```

### Move 2 — what actually differs (the ~4 lines)

Walk the five agents and the *only* genuine variation is:

- **the prompt variables** fed to `renderPromptTemplate` (schema, project_id,
  diagnosis vs. anomaly vs. intent),
- **the tool policy** (`queryToolPolicy` has 36 tools; `diagnostic` has 11),
- **the loop budget** (`maxTurns` 6 or 8, `maxToolCalls` 3, 4, or 6),
- **the `parseResult` / `recoveryPrompt`** (each agent's domain validator),
- **the post-processing** (recommendation slices to 3 + assigns ids; monitoring
  sorts by severity + slices to 10; diagnostic downgrades confidence on
  errors; query trims text; rubric throws on null).

That's it. Everything else — the `listTools → filter → render → runAgentLoop`
sequence, the constructor's `prompt ?? package.system` line, the options-bag
threading of `model`/`tools`/`trace`/`signal` — is identical text.

```
  the divergence, isolated — this is all that's unique per agent

           prompt vars   policy        budget        parse/recover   post-process
  ───────  ───────────   ──────        ──────        ─────────────   ───────────
  query    schema,intent queryPolicy   8 / 6         none (text)     trim || fallback
  diag     schema,anomaly diagPolicy   8 / 6         tryParseDiagnosis  confidence↓ on error
  recommend schema,diag   recPolicy    6 / 4         tryParseRecs    slice(3)+assign ids
  monitor  schema         monPolicy    8 / 6         tryParseAnomalies sort+slice(10)
  rubric   rubric prompt  rubricPolicy 6 / 3         validateRubric  throw on null

  five rows. each row is a config object. the columns ARE the parameters
  of the runCapability<T>() that should exist.
```

### Move 2.5 — current state vs. the fix

```
  Phase A: now                      Phase B: after the refactor
  ─────────────────────            ────────────────────────────
  5 classes ×                       5 thin classes, each:
  ~30 lines wiring each      ──►      run(input) {
  = ~150 lines, ~85% copied              return runCapability({
                                           policy: queryToolPolicy,
  edit the loop wiring? edit             promptVars: {...},
  5 files or diverge                     budget: { maxTurns: 8 },
                                         parse, recover,
  buildRecoveryPrompt evidence           post: (r) => ...,
  formatter copy-pasted 3×               });
  (see audit Lens 3)                   }
                                     runCapability + formatToolCalls
                                     live ONCE in runtime
```

**What doesn't have to change:** the class *names* and *types*
(`QueryAgent.answer()`, `DiagnosticInvestigationAgent.investigate()`) are part
of the published surface (`05`) and stay. The capability IDs and tool policies
stay — they're genuinely per-agent data. The fix touches *only* the run-method
bodies and adds one runtime helper. It's a low-risk extraction.

### Move 3 — the principle

**Duplication that the type system can't catch is the most dangerous kind:
five copies compile fine, pass their own tests, and silently drift.** The
recovery-prompt evidence formatter is already byte-identical in three files
(`audit.md` Lens 3) — that's drift waiting to happen. The constructive move is
the one AptKit already made *one layer down*: `runAgentLoop` abstracted the
loop so agents don't re-implement it. Do the same again — abstract the
*wiring* so agents don't re-implement that either. The concept "capability =
prompt + policy + budget + validator" is already a clean parameter list; make
it a function signature.

---

## Primary diagram

```
  the fix — collapse 5 shallow wrappers into config + 1 helper

  BEFORE                              AFTER
  ┌─ QueryAgent ─────┐                ┌─ QueryAgent ──┐
  │ 30 lines wiring  │                │ build config  │──┐
  └──────────────────┘                └───────────────┘  │
  ┌─ DiagnosticAgent ┐                ┌─ DiagnosticAgent┐ │
  │ 30 lines wiring  │   ──────►      │ build config   │─┼─► runCapability<T>(config)
  └──────────────────┘                └────────────────┘ │      (ONE place: wiring,
  ┌─ ...3 more ──────┐                ┌─ ...3 more ────┐  │       trace, budget, recovery)
  │ 30 lines each    │                │ build config   │──┘            │
  └──────────────────┘                └────────────────┘               ▼
   ~150 lines, copied                  ~5 configs + 1 helper     runAgentLoop
```

---

## Implementation in codebase

**Use cases.** Every agent invocation hits this duplicated wiring — there is
no shared base or helper today; each of the five agents independently threads
the same options into `runAgentLoop`.

**The copied constructor — four of five agents
(`query-agent.ts:70`, `diagnostic-agent.ts:50`, `monitoring-agent.ts:46`,
`recommendation-agent.ts:57`):**

```
  constructor(private readonly options: QueryAgentOptions) {
    this.prompt = options.prompt ?? queryPromptPackage.system;   ← same line,
  }                                                                 swap "query"
```

**The fifth agent uses a *different* convention — the consistency smell
(`rubric-improvement-agent.ts:40-55`):**

```
  constructor(options: RubricImprovementAgentOptions) {
    this.model = options.model;        ┐ destructures into private fields
    this.tools = options.tools;        │ instead of `this.options.x`.
    this.rubric = options.rubric;      │ two DI conventions for one job.
    this.toolPolicy = options.toolPolicy ?? rubricImprovementToolPolicy;
    this.prompt = options.prompt;      ┘
  }
```

**The copied run-method skeleton — `query-agent.ts:75-99` vs.
`diagnostic-agent.ts:55-80`:** the first four statements are identical in
shape (`listTools` → `filterToolsForPolicy` → `renderPromptTemplate` →
`runAgentLoop({ capabilityId, model: this.options.model, tools, system,
toolSchemas, trace, signal, maxTurns, maxToolCalls, synthesisInstruction,
... })`). Diff them and the differences are: the prompt vars object, the
policy constant, `maxTurns 8` (same), the `parseResult`/`recoveryPrompt`, and
the return statement. Roughly four lines of real divergence in a ~25-line
method.

**The duplication that's already drifting —
`buildRecoveryPrompt`'s evidence loop**, byte-identical at
`diagnostic-agent.ts:101-107`, `monitoring-agent.ts` (`buildRecoveryPrompt`),
and `recommendation-agent.ts` (`buildRecoveryPrompt`):

```
  toolCalls.map((call, index) => {
    const payload = call.error ? { error: call.error } : call.result;
    return `Query ${index + 1}: ${call.toolName} ${JSON.stringify(call.args).slice(0, 200)}
  Result: ${JSON.stringify(payload).slice(0, 900)}`;
  }).join('\n\n')
        │
        └─ the 200/900 truncation is a DECISION copied into 3 files.
           change it once and you edit three or diverge silently.
           fix: formatToolCallsAsEvidence(toolCalls, { argChars, resultChars })
           in packages/runtime.
```

**Why it was a reasonable call at the time.** Five agents extracted from one
working app, written close together, each shipped fast. Copy-paste is the
right *first* move when you don't yet know which parts will diverge — premature
abstraction is its own sin. But the columns in the divergence table above are
now stable and known. The information needed to abstract correctly exists. So
the copy has earned its replacement; it hasn't earned staying.

---

## Elaborate

The intended pattern is **Template Method** (a fixed algorithm skeleton with
pluggable steps) realised as a parameterised function rather than inheritance
— in TypeScript, a `runCapability<T>(config)` with callbacks beats an abstract
base class because the steps are data, not overrides. APOSD frames this under
"general-purpose modules are deeper": the five special-purpose agent bodies
are shallow; one general-purpose runner is deep, and the agents reduce to
declarations.

The drift risk is the real cost, not the line count. Five copies that compile
and pass tests will diverge under maintenance — someone tunes
`maxToolCalls` for diagnostic, forgets monitoring, and now two "identical"
agents behave differently for no documented reason. The recovery-formatter
already sits one careless edit away from that. Consolidation makes the shared
behaviour shared *in fact*, not just *by convention*.

Connects to: `01` (the deep module the agents correctly delegate to — proof
the team knows how to abstract), and `05` (why the class names must survive
the refactor).

---

## Interview defense

**Q: "You've got five agent classes. Is that good design?"**

The *concept* is good — each agent is a capability, which AptKit defines as
prompt + policy + budget + validator. The *implementation* duplicated it: the
five run methods are ~85% identical wiring around about four lines of real
divergence, and the recovery-prompt evidence formatter is already byte-
identical in three of them. That's drift waiting to happen — five copies
compile fine and diverge silently. The fix is the move the team already made
one layer down with `runAgentLoop`: extract a `runCapability<T>(config)` so
the wiring lives once and each agent declares only its config. The class names
stay because they're the published surface.

```
  the tell: diff two agents' run methods
  ┌─ query.answer ─┐  ┌─ diag.investigate ─┐
  │ listTools      │  │ listTools          │ ← same
  │ filterPolicy   │  │ filterPolicy       │ ← same
  │ renderPrompt   │  │ renderPrompt       │ ← same shape
  │ runAgentLoop{} │  │ runAgentLoop{}     │ ← same shape
  └────────────────┘  └────────────────────┘
   only the config values differ → that's a parameter list, not 5 classes
```

**Anchor:** "Five copies of one algorithm; the differences are a config
object, so they should be config, not classes." Naming the drift risk (the
already-triplicated recovery formatter) is the senior signal — it shows you
read the code, not just counted classes.

**Q: "Why not fix it with a base class?"** Inheritance forces the variation
into override methods and an `is-a` hierarchy the domain doesn't need. The
variation here is *data* (a policy, a budget, two callbacks), so a
parameterised function expresses it directly without the inheritance ceremony.

---

## Validate

1. **Reconstruct:** write the run-method skeleton shared by all five agents
   from memory (the four statements + `runAgentLoop` call). Check against
   `query-agent.ts:75`.
2. **Explain:** name the ~4 things that genuinely differ between
   `QueryAgent.answer` and `DiagnosticInvestigationAgent.investigate`. (Prompt
   vars, policy, parse/recover, post-processing.)
3. **Apply:** sketch the `runCapability<T>(config)` signature — what goes in
   the config object? (capabilityId, policy, promptVars, budget, parseResult,
   recoveryPrompt, post-process.)
4. **Defend:** a teammate says "five classes is fine, they're readable." Argue
   the drift risk using the already-triplicated `buildRecoveryPrompt` evidence
   loop (`diagnostic-agent.ts:101`) as evidence.

---

## See also

- `01-model-provider-deep-module.md` — the deep abstraction the agents
  correctly delegate to; read it against this file for the contrast.
- `05-bundle-as-public-surface.md` — why the class names survive the refactor.
- `audit.md` Lens 2 (shallow module), Lens 3 (the triplicated formatter), Lens
  7 (the two-DI-conventions consistency smell).
- `.aipe/study-ai-engineering/` — the agents as AI capabilities (intent,
  policy, synthesis) rather than as a duplication finding.
