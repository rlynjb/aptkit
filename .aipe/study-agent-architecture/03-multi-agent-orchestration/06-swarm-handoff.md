# Swarm / Handoff

**Industry standard.** "Swarm," "handoff," "peer-to-peer agents," "agent-to-agent transfer." Type label: orchestration topology. **In this codebase: not yet exercised.** aptkit has no agent-to-agent control transfer. Its agents never call each other; there is no peer handoff and no central boss either.

## Zoom out, then zoom in

Peer-to-peer control transfer, no central supervisor. One agent decides "you take it" and hands control to a peer specialist, who can hand it back or onward. More flexible than supervisor-worker (no central bottleneck), much harder to debug (no single place that knows the whole state). aptkit does none of this.

```
  Zoom out — swarm/handoff (the shape, not in aptkit)

      ┌────────┐  "you take it"  ┌────────┐
      │agent A │ ──────────────► │agent B │
      └────────┘                 └───┬────┘
           ▲                         │ "back to you"
           └─────────────────────────┘
```

## Structure pass

**Axis: who holds control, and who knows the whole state?** In supervisor-worker, control and global state live in the supervisor. In a swarm, control *moves* between peers and no one holds the global state. The seam is the handoff itself: a control transfer with no central record. That missing central record is both the flexibility (no bottleneck) and the danger (no one can answer "what's the whole conversation state").

## How it works

### Move 1 — the mental model

A swarm is supervisor-worker with the supervisor deleted — agents transfer control directly, peer to peer. The model itself decides when to hand off. Think of an on-call rotation where one engineer pages another directly, no manager routing the page.

```
  Swarm — peers transfer control, no boss

  agent A ──handoff──► agent B ──handoff──► agent C
     ▲                                         │
     └──────────────── handoff back ───────────┘
  (the MODEL decides each transfer; no central router)
```

### Move 2 — why aptkit is far from this, and the failure it would introduce

**aptkit is the opposite of a swarm.** Its agents are isolated capabilities with no awareness of each other — there's no "hand off to the diagnostic agent" tool, no shared conversation state to transfer. Even the would-be supervisor-worker (file 02) keeps central control (tools-style). A swarm would require giving each agent handoff tools (`handoff_to(diagnostic)`) and a shared state object that travels with control.

**The failure mode a swarm introduces: infinite handoff.** A → B → "back to you" → A → B forever, because no one agent decides the work is done. aptkit's single-agent loops can't have this — there's no peer to hand to — but a swarm built on aptkit would need the mitigation from the coordination-failure-modes file: a handoff counter that force-stops or escalates after N transfers, the multi-agent analog of the `maxToolCalls` budget aptkit already uses inside one loop.

**Why aptkit wouldn't reach for a swarm.** Swarm's flexibility buys nothing for aptkit's tasks. Its analytics task is a strict dependency chain (pipeline), and its rag-query task is one specialist (no peers to hand to). Swarm earns its debugging cost only when the routing between specialists is genuinely dynamic and unpredictable — a customer-support system where any agent might need any other. aptkit has neither dynamic routing needs nor multiple peers per task.

### Move 3 — the principle

Swarm trades the supervisor's central control (and central observability) for peer flexibility. The price is debuggability — no single point knows the whole state — and a new failure class (infinite handoff) that needs its own budget. It's the topology you reach for *last*, when routing is too dynamic for a supervisor to enumerate. aptkit, with static task shapes, would never benefit.

## Primary diagram

```
  Swarm vs aptkit's isolation

  SWARM (not in aptkit):
    A ⇄ B ⇄ C   control moves peer-to-peer, shared state travels
    needs: handoff tools + shared state + handoff counter (anti-infinite-loop)

  APTKIT (today):
    A   B   C   isolated capabilities, NO handoff, NO shared state
    each is a self-contained runAgentLoop
```

## Elaborate

Swarm/handoff (popularized by OpenAI's Swarm and similar) is the most decentralized topology — agents as autonomous peers that route work among themselves. It shines for open-ended, dynamic routing (you can't predict which specialist a request needs), and it suffers exactly where decentralization always does: no global view, hard debugging, new coordination failures. aptkit sits at the far other end — fully centralized, isolated capabilities — which is correct for its static, predictable tasks. The honest read: aptkit is so far from a swarm that adopting one would be a near-total rewrite, and nothing in its task shape asks for it.

## Interview defense

**Q: Does aptkit use agent handoff / a swarm?**
No — it's the opposite. My agents are isolated capabilities with no awareness of each other; there's no handoff tool and no shared state to transfer. A swarm transfers control peer-to-peer with no central boss, which buys flexibility for dynamic routing I don't have — my analytics task is a strict dependency chain and my rag-query task has one specialist. Swarm is the topology you reach for last.

```
  swarm: A ⇄ B ⇄ C (dynamic, no boss)   vs   aptkit: A | B | C (isolated)
```
*Anchor: swarm's flexibility buys nothing for static, predictable task shapes.*

**Q: What new failure would a swarm introduce?**
Infinite handoff — A → B → A forever, because no peer decides it's done. The fix is a handoff counter that force-stops after N transfers, which is the multi-agent version of the `maxToolCalls` budget I already use inside one loop.

## See also

- `02-supervisor-worker.md` — the centralized contrast aptkit is closer to
- `09-coordination-failure-modes.md` — the infinite-handoff mitigation
- `02-agent-loop-skeleton.md` — the budget exit that's the single-agent analog of a handoff counter
