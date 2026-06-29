# Debate / Verifier-Critic

**Industry standard.** "Debate," "verifier-critic," "producer-critic," "generator-discriminator." Type label: orchestration topology. **In this codebase: not yet exercised.** aptkit has a *judge* (the rubric-improvement agent, the `rubric-judge` eval), but no producer-critic *loop* where one agent's output is reviewed by a separate agent before returning.

## Zoom out, then zoom in

Agents argue or critique to refine quality. Two flavors: symmetric debate (two agents counter each other, a judge picks) and asymmetric verifier-critic (a producer makes, a critic approves or rejects, loop until approved). aptkit has the judging *component* but not the loop.

```
  Zoom out — the critic component exists, the loop doesn't

  ┌─ aptkit has the JUDGE ───────────────────────────────────┐
  │  rubric-improvement agent · rubric-judge eval (SECTION D) │ ← partial
  └───────────────────────────┬──────────────────────────────┘
                              │ but no producer→critic→revise LOOP
  ┌─ verifier-critic (not exercised) ─────────────────────────┐
  │  producer → critic (approve/reject) → loop until approved │
  └────────────────────────────────────────────────────────────┘
```

## Structure pass

**Axis: who checks the work, and are they independent?** The whole value of verifier-critic is an *independent* checker — a second perspective that catches errors the producer can't see. aptkit's `rubric-judge` is independent of the agents it scores (it's an eval, run after the fact), but it's not in the agents' *runtime* loop. The seam: critique-after-the-fact (aptkit's eval) vs critique-in-the-loop (verifier-critic gating the answer before it returns).

## How it works

### Move 1 — the mental model

Verifier-critic is a producer agent and a reviewer agent in a loop: produce → review → revise on reject → until approved (capped). You've seen this shape — a code author and a code reviewer, where the PR doesn't merge until the reviewer approves.

```
  Debate (symmetric):              Verifier-critic (asymmetric):
  ┌────────┐   ┌────────┐          ┌──────────┐   ┌──────────┐
  │agent A │◄─►│agent B │          │ producer │──►│ critic   │
  │(propose)│   │(counter)│         │          │◄──│(approve/ │
  └────────┘   └────────┘          └──────────┘   │ reject)  │
       │            │                              └──────────┘
       └─────┬──────┘                    loop until approved
             ▼                           (cap the rounds)
        judge picks
```

### Move 2 — what aptkit has and what it would take

**aptkit has the critic as an *evaluator*, not an in-loop agent.** The `rubric-judge` (`packages/evals`) scores agent output against a rubric *after* a run, as part of the replay-eval pipeline. The rubric-improvement agent scores a subject and emits a next action. Both are critique — but they run offline (eval) or over an external subject (rubric-improvement), not as a gate on another agent's live answer.

**What verifier-critic would add.** A loop where the rag-query agent produces a cited answer, then a *separate critic agent* checks "is every claim grounded in a retrieved chunk?" — and on reject, the producer re-searches and revises. aptkit has all the parts: the producer (rag-query), a critic prompt, and the loop kernel. The new code is wiring the critic into the runtime loop instead of the offline eval.

```
  Verifier-critic refactor in aptkit (would-be)

  rag-query produces cited answer
       │
       ▼
  critic agent: "every claim grounded? cite check?"  ← rubric-judge logic, in-loop
       │
   reject? → producer re-searches + revises (cap rounds)
   approve? → return
```

**The failure mode to design against — and aptkit already names it.** Two agents from the same model family share blind spots; the critic misses what the producer missed. aptkit's `study-ai-engineering` LLM-as-judge file names this self-preference bias, and aptkit's provider layer is the mitigation: run the critic on a *different* model family (Anthropic critic over a Gemma producer) when the stakes justify it. The swappable `ModelProvider` makes that a config change.

### Move 3 — the principle

Verifier-critic earns its overhead on high-stakes outputs where a second, *independent* perspective measurably catches errors. The cost is a full agent turn per round; the failure is a critic that shares the producer's blind spots. aptkit has the critic logic (as an eval) and the cure for the blind-spot problem (swappable providers) — it just hasn't moved critique from the offline eval into the live loop, because its current quality bar is met by the cheaper single-path hardening.

## Primary diagram

```
  Verifier-critic over rag-query (would-be), with cross-family critic

  ┌─ Producer (rag-query, Gemma) ───────────────────────────┐
  │  search → ground → cited answer                          │
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌─ Critic (different model family, e.g. Anthropic) ────────┐
  │  "every claim grounded? cite valid?"  → approve | reject │
  └─────────┬───────────────────────────────┬────────────────┘
            ▼ approve                        ▼ reject
        return                          producer revises, loop (capped)
```

## Elaborate

Verifier-critic formalizes "two heads are better than one" for agents — but only when the two heads are genuinely different. The research lesson is that same-model debate often degrades into mutual agreement (both share the bias), which is why cross-family critics matter. aptkit's replay-eval pipeline is a sibling of this pattern: it already critiques agent output with a rubric, just offline. Promoting that critique into the live loop is the step to verifier-critic, and the provider layer is ready to make the critic a different family.

## Interview defense

**Q: Do you use a critic agent?**
As an *evaluator*, not in the live loop. My `rubric-judge` scores agent output against a rubric in the replay-eval pipeline — that's critique, but offline. A real verifier-critic would move it into the loop: rag-query produces a cited answer, a separate critic checks grounding and rejects ungrounded claims, the producer revises. I have the parts; I haven't wired it because single-path hardening meets my current bar.

```
  producer → critic (approve/reject) → revise → loop (capped)
```
*Anchor: my critic exists offline (rubric-judge); promoting it into the loop is the step.*

**Q: Wouldn't a critic share the producer's blind spots?**
If it's the same model, yes — that's the self-preference bias. My mitigation is the swappable provider layer: run the critic on a different model family (Anthropic critic over a Gemma producer). It's a config change, not a rewrite.

## See also

- `01-reasoning-patterns/05-reflexion-self-critique.md` — single-agent self-critique vs this two-agent version
- `04-agent-infrastructure/04-agent-evaluation.md` — the rubric-judge eval (aptkit's offline critic)
- `04-agent-infrastructure/03-tool-calling-and-mcp.md` — the provider layer that makes a cross-family critic cheap
