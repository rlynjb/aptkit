# audit.md — the 8 APOSD lenses, walked against AptKit

Pass 1. One section per design lens. Every lens checked; where a principle
has nothing to bite on, it says so. The deep walks for the significant
patterns live in the Pass 2 files (`01`–`05`); this audit cross-links rather
than restating them.

Source for every term: Ousterhout, *A Philosophy of Software Design*.

---

## 1. complexity-in-this-codebase

The diagnostic overview. Ousterhout names three symptoms of complexity:
**change amplification** (one decision forces edits in many places),
**cognitive load** (the module nobody wants to touch), and **unknown-unknowns**
(you can't tell what you'd have to change). Where do they live here?

**Change amplification — the load-bearing contracts.** Five types ripple
across the whole repo if their shape changes: `ModelProvider`
(`packages/runtime/src/model-provider.ts:54`), `CapabilityEvent`
(`packages/runtime/src/events.ts:1`), `ToolRegistry`
(`packages/tools/src/tool-registry.ts:17`), and the agent
`*_CAPABILITY_ID`/`toolPolicy` pairs. This is *expected* amplification — these
are deliberately central. The project context even names them
"must-not-change constraints." A change to `CapabilityEvent`'s union touches
the loop emitter, the NDJSON guard (`ndjson-stream.ts:41`), the usage ledger
(`usage-ledger.ts:25`), and Studio. That's the price of a shared trace
envelope, and it's a price worth paying.

**Cognitive load — the agent classes.** The highest *unnecessary* load is in
`packages/agents/*/src/*-agent.ts`. Not because any one agent is hard — each
is ~100 lines — but because to understand the system you read the same
skeleton five times and have to diff them in your head to find the 4 lines
that differ. That's cognitive load with no payoff. → `04`.

**Unknown-unknowns — the pricing table.** `usage-ledger.ts:71`
`pricingForModel` returns `undefined` for any non-OpenAI provider. Nothing at
the call site signals that Anthropic cost is *structurally* unknowable, not
just missing for this run. A reader sees `formatCost` print `n/a` and can't
tell whether the run was free, uncosted, or a bug. That's the textbook
unknown-unknown: the information you'd need to reason about it isn't visible
where you'd look.

**Top 3 hotspots by path:**
1. `packages/agents/*/src/*-agent.ts` — duplicated wiring (cognitive load).
2. `packages/runtime/src/usage-ledger.ts:71` — provider pricing as a hidden
   `if`-ladder (unknown-unknown).
3. `packages/runtime/src/run-agent-loop.ts:76` — the deepest single module;
   high *intrinsic* load (it does a lot), but well-contained. Worth knowing it
   exists; not a defect.

---

## 2. deep-vs-shallow-modules

> red flags: shallow module, classitis.

**The deepest module — `ModelProvider`.** Three members:
`id`, `defaultModel?`, `complete(request)`
(`packages/runtime/src/model-provider.ts:54-58`). Behind that one method sits
every vendor SDK — Anthropic's content-block flattening, OpenAI's message
mapping, retry, fallback, token estimation. The interface is about as small
as an LLM call can be; the body it hides is the largest in the repo. This is
the canonical deep module. → full walk in `01-model-provider-deep-module.md`.

Runner-up: `runAgentLoop` (`run-agent-loop.ts:76`). The interface is one
function + an options bag; the body hides the turn loop, forced-synthesis
final turn, per-tool trace emission, result truncation, budget enforcement,
and an optional recovery turn. Big behaviour, one entry point.

And `evaluateStructuralDiff` (`structural-diff.ts:20`): one function takes a
value and a rule list and hides six different assertion strategies behind a
single switch. → `03`.

**The shallowest modules — the agent classes.** Take `QueryAgent`
(`packages/agents/query/src/query-agent.ts:67-103`). The class body is:
store a prompt in the constructor, then in `answer()` call `listTools`,
`filterToolsForPolicy`, `renderPromptTemplate`, `runAgentLoop`, and return.
The interface (`new QueryAgent(opts).answer(question)`) is nearly as complex
as the body, and the body is mostly forwarding to deeper modules. That's the
definition of shallow. It's not *classitis* in the worst sense (these aren't
one-method-per-class fragmentation), but it's five near-identical shallow
wrappers where one parameterised helper would do.

**The fix for the worst:** don't delete the agent classes — their *names*
and types are part of the public surface. Fold the shared body into one
`runCapability<T>(config)` runtime helper and let each agent's method become
"build my config, call the helper." → `04`.

---

## 3. information-hiding-and-leakage

> red flags: information leakage; the same knowledge edited in two places.

**Leak 1 — the recovery-prompt evidence formatter, copy-pasted three times.**
The block that turns `toolCalls` into an evidence string —

```
  toolCalls.map((call, index) => {
    const payload = call.error ? { error: call.error } : call.result;
    return `Query ${index+1}: ${call.toolName} ... slice(0, 200) ... slice(0, 900)`;
  }).join('\n\n')
```

— is byte-for-byte identical at `diagnostic-agent.ts:101`,
`monitoring-agent.ts` (`buildRecoveryPrompt`), and
`recommendation-agent.ts` (`buildRecoveryPrompt`). The 200/900 truncation
limits are a *decision* — how much tool evidence to feed back — and that
decision now lives in three files. Change the limit for one agent and you
either edit three files or silently diverge. **Same knowledge, edited
thrice.** Fix: one `formatToolCallsAsEvidence(toolCalls, limits)` in runtime.

**Leak 2 — the 16,000-char tool-result truncation.** `run-agent-loop.ts:52`
caps tool results at `MAX_TOOL_RESULT_CHARS`. That's correctly hidden — the
agents never see it, the loop owns it. **This is the good version** of the
same concern as Leak 1: a decision about how much text to carry, hidden
behind one module. Contrast it directly with the recovery formatter to see
hiding done right vs. done wrong.

**Leak 3 — provider-id strings.** `usage-ledger.ts:72` branches on
`provider !== 'openai'` using the literal `'openai'`, which must match
`OpenAIModelProvider.id`. The fallback provider hardcodes `id = 'fallback'`
(`fallback-provider.ts:28`). These string ids are a shared vocabulary spread
across packages with no single enum. Minor, but it's a fact known in two
modules that must agree.

**No temporal decomposition found.** The packages are split by responsibility
(provider / loop / tools / evals), not by execution phase — there's no
"setup module / runtime module / teardown module" smell. Good.

---

## 4. layers-and-abstractions

> red flag: pass-through method / pass-through variable.

**The agent classes are pass-through wrappers.** `QueryAgent.answer()`
(`query-agent.ts:75`) takes `question`, does a little setup, and forwards to
`runAgentLoop`. The class adds a *name* and a *type binding* (this is the
query capability, these are its tools) but little behaviour the layer below
doesn't already offer. That's close to a pass-through layer — it earns its
place only through the policy binding and the public-API name, not through
new logic. → `04`.

**A layer that genuinely earns its place — `filterToolsForPolicy`.**
`tool-policy.ts:11` sits between "the registry has 49 tools" and "the model
sees these 7." It's a thin function, but the abstraction it provides
(least-privilege tool scoping) is not offered by either neighbour. Not a
pass-through; a real seam.

**A real pass-through variable — `defaultModel` through the guard.**
`ContextWindowGuardedProvider` copies `this.defaultModel = provider.defaultModel`
(`context-window-guard.ts:47`) and `id = provider.id`. That's deliberate and
correct for a decorator (it must impersonate the wrapped provider's identity),
so it's a pass-through *by design*, not a smell. → `02`. Worth flagging only
so you recognise the pattern: a decorator's identity-forwarding is the one
place pass-through variables are the right call.

---

## 5. pull-complexity-downward

> red flag: avoidable config exposed to callers.

**The worst exposed knob — pricing as caller-invisible control flow.**
This is the *inverse* of an exposed knob: `pricingForModel`
(`usage-ledger.ts:71`) doesn't expose pricing to callers at all — it buries a
three-family lookup (`gpt-4.1-nano`, `gpt-4.1-mini`, `gpt-4.1`) in an
`if`-ladder and returns `undefined` for everything else. The complexity is
pushed *down*, which is right, but it's encoded as control flow instead of a
data table, so adding Anthropic pricing means editing the function body, not
a map. The constructive move: make pricing a `Record<provider, Record<model,
UsagePricing>>` data structure the function reads. Same hiding, but now the
knowledge is data you can extend without touching logic. → this is the
`03`-style rules-as-data move applied to pricing.

**A knob pushed up that maybe shouldn't be — `charsPerToken`.**
`ContextWindowGuardOptions.charsPerToken` (`context-window-guard.ts:12`) lets
the caller tune the chars-per-token estimate, defaulting to 3. The module has
enough information to own a sane default (it does), and almost no caller will
ever set it. It's a reasonable escape hatch, but it's complexity offered up
that the module could decide. Verdict: keep it (estimation accuracy is
model-specific and the default is documented), but know it's the kind of knob
that earns its place only if a caller actually flips it.

**Done right — `runAgentLoop` defaults.** `maxTurns = 8`, `maxTokens = 4096`,
`outputReserve = 768` (`run-agent-loop.ts:87`, `context-window-guard.ts:51`)
are all defaulted in the module. Callers *can* override but never *have to*.
Complexity owned downward. This is the pattern the pricing table should copy.

---

## 6. errors-and-special-cases

> red flags: try/except everywhere; special-case sprawl.

**Errors are defined out, not scattered — mostly.** The strongest move in the
repo: `decodeNdjsonLine` (`ndjson-stream.ts:65`) *returns* a warning shape
instead of throwing on malformed JSON. A bad line becomes a value
(`{ ok: false, warning }`), so callers never wrap NDJSON parsing in
try/catch — the special case is defined into the normal return type. Same in
`json-output.ts:30` `parseValidatedJson`, which returns
`{ ok: false, error }` rather than throwing. This is Ousterhout's "define
errors out of existence" done deliberately.

**Errors masked at the right layer — the agent loop.**
`run-agent-loop.ts:158-168` catches a tool failure, turns it into a
`tool_result` with `isError: true`, and *keeps the loop running* so the model
can react. The error never propagates up to the agent; it's masked low, where
the loop has the context to handle it. Good.

**Special-case sprawl — the abort-error check, three times.** `isAbortError`
appears as a standalone helper in `fallback-provider.ts:92` and
`structured-generation.ts:163`, and inline in `run-agent-loop.ts:219`
(`error instanceof DOMException && error.name === 'AbortError'`). The same
"is this a cancellation, not a real failure?" special case is written three
ways. Minor, but it's a special case that one shared `isAbortError` in runtime
would erase. The risk if they drift: one path swallows an abort that another
re-throws.

**The good aggregation — `ProviderFallbackError`.**
`fallback-provider.ts:16` collects every provider's failure into one error
carrying `attempts[]`. Instead of N scattered failures, the caller gets one
exception that explains the whole chain. Errors aggregated, not multiplied.

---

## 7. readability (names · comments · consistency · obviousness)

**Names — strong.** No `data`/`obj`/`tmp`/`manager` smell anywhere I looked.
Names carry intent: `forceFinal` (`run-agent-loop.ts:102`), `budgetSpent`,
`runnableRequirements`, `lastSelectedProvider`. The one mild offender:
`asRecord` (`anthropic-provider.ts:97`) is a generic name for a specific
"coerce tool_use input to a record" coercion — fine, but `toToolInput` would
say why it exists.

**Comments — better than most repos.** Interface comments exist where they
matter: `/** Capability-scoped allowlist that keeps agents from seeing tools
outside their role. */` (`tool-policy.ts:4`) tells you *why*, not *what*. The
`structured-generation.ts:49-53` block comment carries history a comment is
uniquely good for — "this is the provider-neutral version of Dryrun's
on-device JSON pipeline." Missing: `runAgentLoop` (`run-agent-loop.ts:76`),
the deepest module in the repo, has *no* interface comment explaining the
forced-synthesis contract or the recovery turn. The one place a comment would
carry the most is the one place it's absent.

**Consistency — one real split.** Two dependency-injection conventions for
agents: four agents use `constructor(private readonly options: XOptions)` and
read `this.options.model`; `RubricImprovementAgent` destructures into
`private readonly model`, `private readonly tools`, etc.
(`rubric-improvement-agent.ts:40-55`). Two conventions for one job. Pick one.

**Obviousness — the `getPath` string protocol.** `structural-diff.ts:53`
`getPath(value, 'recommendations.0.title')` splits a dot-path and walks
objects *and* arrays (numeric segments index arrays). That's a small DSL
hidden in a string argument — powerful, but a reader has to discover that
`.0.` means "array index" by reading the implementation. Not wrong, but a
one-line doc on the path grammar would remove the "huh?". → `03`.

---

## 8. red-flags-audit (capstone)

Ousterhout's red flags as a checklist, marked against this repo, sorted by
severity. This is the actionable index.

```
  red flag                  fires?  where + one-line fix
  ───────────────────────── ──────  ─────────────────────────────────────
  Shallow module            YES     5 agent classes ≈ wiring around 4 lines.
   (highest severity)               Fold body into runCapability<T>().  → 04

  Information leakage        YES     buildRecoveryPrompt evidence formatter
                                    copy-pasted 3×. Hoist to runtime.  → 03/04

  Same knowledge twice       YES     isAbortError written 3 ways (fallback,
                                    structured-gen, loop). One helper.

  Special-case sprawl        MINOR   abort-error check (same as above).

  Conjoined / config-leak    MINOR   pricing as if-ladder, OpenAI-only,
                                    returns undefined silently. → usage-ledger:71
                                    Make it a data table.

  Pass-through method        SOFT    agent classes forward to runAgentLoop;
                                    earn their place only via policy + name. → 04

  Vague name                 RARE    asRecord (anthropic-provider:97). Cosmetic.

  Hard to pick interface     NO      ModelProvider is the opposite — exemplary.

  Comment restates code      NO      comments explain why, not what.

  Missing interface comment  YES     runAgentLoop (deepest module) has none.
                                    Document the forced-synthesis + recovery
                                    contract.

  Nonobvious code            MINOR   getPath dot-path DSL ('.0.' = array index)
                                    undocumented. → 03

  Temporal decomposition     NO      packages split by responsibility, clean.

  Hidden / surprise control  NO      nothing jumped out.
```

**Severity-ranked verdict:** the repo's foundation passes the red-flag
checklist cleanly — the contracts are deep, errors are defined out, comments
explain why. Every *firing* flag clusters in one place: the capability/agent
layer, where five classes duplicate wiring instead of sharing one
abstraction. Fix that one layer (`04`) and most of this table goes quiet.

The deep walks: `01` (the deep module to copy), `02` (the decorator stack),
`03` (rules-as-data, which also shows the fix for the pricing flag), `04`
(the shallow-module fix), `05` (the public surface).
