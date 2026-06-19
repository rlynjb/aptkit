# 03 — Agentic Coding / Build System

> The plan → execute → verify template. The interviewer wants an agent that
> changes a codebase and proves the change is good. The defining move is the
> *verify* loop: a critic runs tests or review and sends the agent back to fix.
> AptKit has no coding agent at all — but it has the two seeds, a verifier-critic
> shape (rubric-improvement) and a replay-eval harness that is the verify half in
> a different domain.

---

- **The prompt:**
  "Design an agent that completes a coding task across a repo — read, plan, edit,
  verify."

- **Standard architecture:**
  Plan-and-execute, not pure ReAct: a planning phase produces an explicit
  ordered plan over the repo before any edit, an execution phase applies edits
  tool-by-tool, and a verifier-critic phase runs tests / static review and either
  accepts or loops back with the failures as new context. Guardrails scope which
  files are writable and cap the verify→fix iterations so a failing test can't
  drive an infinite edit loop.

  ```
    Plan → execute → verify loop: coding agent

    task
     │
     ▼
  ┌───────────┐   ┌───────────┐   ┌─────────────────────┐
  │   PLAN    │──▶│  EXECUTE  │──▶│      VERIFY         │
  │ read repo │   │ apply     │   │ run tests / review  │
  │ → ordered │   │ edits     │   │                     │
  │   plan    │   │ (scoped   │   └─────────┬───────────┘
  └───────────┘   │  writable │             │
                  │  files)   │      pass?  │
                  └─────▲─────┘   ┌─────────┴─────────┐
                        │         │ no                │ yes
                        │         ▼                   ▼
                        │   ┌───────────┐        ┌─────────┐
                        └───│  CRITIC   │        │  done   │
                  failures  │ failures  │        └─────────┘
                  as context│ → fixes   │
                            └───────────┘
                       (iteration cap stops the loop)
  ```

- **Data model:**
  A `Task`, a `Plan` (ordered steps, each naming target files), an `Edit` set
  (diffs / patches), a `VerifyResult` (test output, review findings, pass/fail),
  and an `Iteration` counter against the cap. The plan being a first-class
  artifact — inspectable before execution — is what separates plan-and-execute
  from ReAct, where the plan lives only implicitly in the transcript.

- **Key components:**
  - **Planner** — turns the task into an ordered, file-scoped plan.
    *Decision: plan up front or replan as you go?* Up-front plans are auditable
    and cheaper; replanning handles surprises but costs control.
  - **Executor** — applies edits via write tools. *Decision: which files are
    writable?* Scoping the writable surface is the primary safety boundary — an
    agent that can edit anything can break anything.
  - **Verifier-critic** — runs tests/review and produces actionable failures.
    *Decision: what counts as "verified"?* Tests passing, lint clean, a review
    rubric satisfied — pick concrete gates, not vibes.
  - **Iteration governor** — caps verify→fix loops. *Decision: how many tries
    before giving up to a human?*

- **Scale concerns:**
  Repo context doesn't fit a window — you need retrieval/navigation over the
  codebase, not whole-repo prompts. Verify cost dominates: running the full test
  suite every iteration is expensive, so you scope tests to the change. The
  edit→test→edit loop has unbounded worst-case cost without the iteration cap.
  Parallel agents editing the same repo create merge conflicts — isolation
  (worktrees / branches) becomes a hard requirement.

- **Eval framing:**
  The verify step *is* the inner eval, but you still need an outer eval: does the
  completed task pass an independent test suite the agent didn't see? Score task
  completion, edits-per-task (efficiency), and regression rate (did it break
  something outside scope). Hold out a verification suite from the agent so the
  inner critic can't be gamed.

- **Common failure modes:**
  Editing files outside the intended scope; gaming the verifier (changing the
  test instead of the code); infinite verify→fix loops with no progress; a plan
  that's stale by the time execution reaches it; context loss across iterations
  so the agent re-breaks what it just fixed.

- **Applies to this codebase:** **No.**
  AptKit has no coding agent, no plan-and-execute reasoning (all five capabilities
  are ReAct loops over `runAgentLoop`, never an explicit plan-then-execute
  phase), and no file-editing tools — every tool grant is read-only analytics
  (`packages/tools/src/tool-policy.ts:11`). The repo never writes anything as part
  of an agent run. *But* the two structural seeds exist. The
  rubric-improvement agent (`packages/agents/rubric-improvement/src/`,
  `.improve()` returning a judgment) is a **verifier-critic** in the
  self-critique sense — it scores a subject against a rubric, which is precisely
  the shape of the critic in the verify loop. And the replay-eval backbone
  (`packages/evals`: `assertRecommendationShape`, `structural-diff`,
  `detection-scorer`, `rubric-judge`, `replay-runner`, plus promoted fixtures at
  `fixtures/promoted/*.json` replayed deterministically via `FixtureModelProvider`)
  is the **verify half** of this architecture, just pointed at agent outputs
  instead of code edits. So AptKit has the critic and the verification harness;
  it has neither the planner nor the write-and-edit executor.

- **How to make it apply:**
  This is a large net-new build, not a refactor — be honest about that in the
  interview. You'd add a new capability with write/edit tools scoped by a
  `ToolPolicy` allowlist (`packages/tools/src/tool-policy.ts:11`) that bounds the
  writable file surface, a distinct **plan phase** ahead of execution (AptKit has
  no plan-and-execute today — see
  [04 — Plan and Execute](../01-reasoning-patterns/04-plan-and-execute.md)), and
  the existing eval/replay harness (`packages/evals`) repurposed as the verify
  loop. The reusable pieces are real: the rubric-improvement self-critique shape
  ([05 — Reflexion / Self-Critique](../01-reasoning-patterns/05-reflexion-self-critique.md))
  becomes the critic, and the `CapabilityEvent` trace
  (`packages/runtime/src/events.ts`) already makes a run's trajectory observable
  for the verifier to inspect. Everything else — planner, write tools, edit
  executor, repo navigation, iteration governor — is new code.
