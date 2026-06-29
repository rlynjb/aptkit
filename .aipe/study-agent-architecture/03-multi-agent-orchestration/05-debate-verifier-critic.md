# Debate / Verifier-Critic

**Industry term:** debate / verifier-critic (producer-critic) topology. *Industry standard.*

## Zoom out, then zoom in

Agents argue or critique to refine quality. aptkit does not run a critic agent against a producer agent. Its quality bar is held by *structural validators* and rubric scoring instead — a deliberate choice given a weak local model.

```
  Zoom out — not built; aptkit uses structural validators, not a critic agent

  ┌─ Capability layer ──────────────────────────────────────────┐
  │  each agent: produce → validate (validate.ts) → recovery turn │ ← we are here
  │  NO second agent critiques the first                          │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: **Not yet implemented in aptkit.** No producer-critic pair, no debate. The role a critic would play is filled by `validate.ts` (schema/rule checks) and, for one capability, the `rubric-improvement` agent — but that grades an external subject, not a peer agent's output ([../01-reasoning-patterns/05-reflexion-self-critique.md](../01-reasoning-patterns/05-reflexion-self-critique.md)).

## How it works

**Use case it would fit:** the agentic coding system — a developer agent writes a diff, a reviewer agent approves or rejects, loop until approved. High-stakes outputs where a second perspective measurably catches errors.

### Move 1 — the topology (two flavors)

```
  Debate (symmetric):              Verifier-critic (asymmetric):
  ┌────────┐   ┌────────┐          ┌──────────┐   ┌──────────┐
  │agent A │◄─►│agent B │          │ producer │──►│ critic   │
  │(propose)│  │(counter)│         │          │◄──│(approve/ │
  └────────┘   └────────┘          └──────────┘   │ reject)  │
       │            │                              └──────────┘
       └─────┬──────┘                    loop until approved
             ▼                           (cap the rounds)
        judge picks
```

### Move 2 — the walkthrough

**aptkit's quality gate is structural, not adversarial.** Each agent validates its own output against a schema before returning — for recommendation, `tryParseRecommendations` checks the JSON shape and the action taxonomy:

```ts
// recommendation-agent.ts:91 — the "critic" is a rule-based validator
parseResult: (text) => tryParseRecommendations(text, this.taxonomy),
recoveryPrompt: (toolCalls) => buildRecoveryPrompt(anomaly, diagnosis, toolCalls),
```

On a parse failure the loop runs one recovery turn (`run-agent-loop.ts:204`) — re-ask the same model for valid output. That's a *format* gate, not a *quality* critique by a second agent.

**Why aptkit avoids a critic agent (the load-bearing reason).** Two agents from the same model family share blind spots — a critic that's also Gemma is as likely to approve a wrong answer as catch it. The textbook fix is a *different model family* for the critic. But aptkit's default is a single local model (Gemma) with no cloud call; running a different-family critic would mean a cloud dependency aptkit deliberately doesn't require. So aptkit leans on deterministic validators, which don't share the model's blind spots at all. That's the right call for a local-first, weak-model system.

**What it would cost aptkit.** A critic agent (another `runAgentLoop`, ideally a different provider via the existing adapter system), a loop between producer and critic with a round cap, and a judge or approval gate. The provider abstraction makes a different-family critic *possible* (swap the `ModelProvider`); the orchestration is **not yet implemented**.

### Move 3 — the principle

A critic catches errors a producer can't — but only if it doesn't share the producer's blind spots, which means a different model family for high stakes. aptkit substitutes deterministic validators (no shared blind spots, no extra model cost) for a critic agent, the correct tradeoff for a local-first weak-model core. Every critic round is a full agent turn; the deterministic gate is free by comparison.

## Primary diagram

```
  aptkit's structural gate vs a verifier-critic topology

  aptkit (now):  produce ─► validate.ts (schema + taxonomy) ─┬─ ok ─► return
                                                             └─ fail ─► recovery turn
                 (same model; deterministic gate; no peer critic)

  verifier-critic:  producer ─► critic (DIFFERENT model family) ─┬─ approve ─► return
                                                                 └─ reject ─► revise (capped)
                    (Not yet implemented; provider swap makes the critic possible)
```

## Elaborate

The producer-critic split is the reliability play for high-stakes outputs — code that ships, medical summaries, financial actions. Its one hard rule is the different-model-family critic, because a same-family critic shares the self-preference bias and the blind spots (the same bias named in LLM-as-judge work). aptkit's position is honest: a local-first core can't assume a second model family is available, so it holds quality with deterministic validators instead. That's not a weaker choice — for the failures validators *can* catch (malformed output, off-taxonomy actions), they're strictly more reliable than a weak peer critic.

## Interview defense

**Q: How does aptkit ensure output quality without a critic agent?**

Deterministic validators per capability — `validate.ts` checks schema and the action taxonomy — plus a parse-recovery turn on failure. No peer critic, because a same-family critic (Gemma critiquing Gemma) shares the blind spots and adds model cost. A real verifier-critic needs a different model family, which a local-first core can't assume.

```
  validator: catches malformed / off-taxonomy   (no shared blind spot, free)
  peer critic: would need a DIFFERENT model family (not assumed locally)
```

*Anchor: a critic only helps if it doesn't share the producer's blind spots; deterministic validators never do.*

## See also

- [../01-reasoning-patterns/05-reflexion-self-critique.md](../01-reasoning-patterns/05-reflexion-self-critique.md) — the single-agent self-critique cousin.
- [../04-agent-infrastructure/04-agent-evaluation.md](../04-agent-infrastructure/04-agent-evaluation.md) — aptkit's rubric-judge, the eval-time critic.
- LLM-as-judge self-preference bias: `.aipe/study-ai-engineering/05-evaluation/`.
