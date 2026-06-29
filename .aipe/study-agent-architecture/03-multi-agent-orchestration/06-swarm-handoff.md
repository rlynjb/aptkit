# Swarm / Handoff

**Industry term:** swarm / handoff (peer-to-peer control transfer, no central boss). *Industry standard.*

## Zoom out, then zoom in

Peer agents pass control to each other directly — the model itself decides when to hand off to a specialist peer. There is no supervisor. aptkit has no handoff of any kind.

```
  Zoom out — not built; aptkit has no agent-to-agent control transfer

  ┌─ Capability layer ──────────────────────────────────────────┐
  │  6 agents; none transfers control to another                 │ ← we are here
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: **Not yet implemented in aptkit.** No agent says "you take it" to a peer. The host calls agents in a fixed order (a pipeline), which is the *opposite* of swarm — there the *code* decides the order, not the model.

## How it works

**Use case it would fit:** a support assistant where a general agent hands off to a billing specialist mid-conversation when it detects a billing question, and the billing agent hands back when done.

### Move 1 — the topology

```
      ┌────────┐  "you take it"  ┌────────┐
      │agent A │ ──────────────► │agent B  │
      └────────┘                 └───┬─────┘
           ▲                         │ "back to you"
           └─────────────────────────┘
```

### Move 2 — the walkthrough

**The defining trait: the model decides the handoff.** In swarm, the handoff is an action the model emits — like a tool call whose effect is "transfer control to peer B." That's more flexible than supervisor-worker (no central bottleneck) and harder to debug (no single point knows the whole state).

**Why aptkit is structurally the opposite.** aptkit's flow control is the host's fixed sequence — the code decides monitor → diagnose → recommend. Swarm would invert that: the *agents* decide who runs next. aptkit has no mechanism for one agent to emit "now run agent B"; the loop only emits tool calls, and no tool transfers control.

**The failure mode it introduces.** Infinite handoff — A → B → A → B forever. The mitigation is a handoff counter that force-stops or escalates ([09-coordination-failure-modes.md](09-coordination-failure-modes.md)). aptkit doesn't face this because it has no handoff, but any swarm adoption would need the counter on day one.

**What it would cost aptkit.** A handoff primitive (a special tool or control signal the loop interprets as "switch active agent"), a shared or passed conversation state, and a handoff counter. This is the largest departure from aptkit's current design — it breaks the one-loop-per-capability model entirely. **Not yet implemented**, and the least likely topology for aptkit given its debuggable, replay-centric style.

### Move 3 — the principle

Swarm trades a central bottleneck for debuggability: peers decide the flow, so no single point knows the whole state. It's the most flexible and least traceable topology. For a replay-centric system like aptkit, that tradeoff runs against the grain — supervisor-worker (one trace) fits far better than swarm (distributed state).

## Primary diagram

```
  Swarm vs aptkit's host-fixed order

  swarm:   agent A ──model decides──► agent B ──model decides──► A
           (no boss; handoff counter required to stop A↔B loops)

  aptkit:  HOST fixes monitor → diagnose → recommend
           (code decides order; the opposite of swarm)
  (Not yet implemented)
```

## Elaborate

Swarm topologies (popularized by OpenAI's Swarm and similar handoff frameworks) suit conversational systems where the right specialist changes mid-conversation and a central router would be a bottleneck. The cost is observability — debugging "why did the conversation end up here" across peer handoffs is genuinely hard. For analytics and retrieval workloads like aptkit's, where the flow is knowable and traceability is prized, swarm is the wrong tool; supervisor-worker gives the same specialization with one trajectory to debug.

## Interview defense

**Q: Would a swarm topology fit aptkit?**

No — it runs against aptkit's grain. Swarm lets agents decide the flow with no central point that knows the whole state, which is the hardest topology to debug. aptkit is replay-centric and prizes one trace per run. If specialization were needed I'd reach for supervisor-worker (one trajectory) over swarm (distributed state) every time.

```
  swarm: peers decide flow, distributed state, hard to trace
  aptkit fit: supervisor-worker — same specialization, one trace
```

*Anchor: swarm trades a bottleneck for debuggability; a replay-centric system should not make that trade.*

## See also

- [02-supervisor-worker.md](02-supervisor-worker.md) — the traceable alternative.
- [09-coordination-failure-modes.md](09-coordination-failure-modes.md) — infinite handoff and its counter.
- [07-graph-orchestration.md](07-graph-orchestration.md) — explicit-state control flow, the opposite extreme.
