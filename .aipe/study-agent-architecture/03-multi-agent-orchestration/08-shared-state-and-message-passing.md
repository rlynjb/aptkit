# 08 — Shared State and Message Passing

> The substrate question underneath every topology: *how do agents share data?*
> Two answers — a shared blackboard everyone reads and writes, or typed messages
> handed point to point. AptKit's latent pipeline is message passing, by
> construction, because the contracts are typed.

## Zoom out

Pick any topology from the last six files and ask: when agent A's work needs to
reach agent B, *how does the data get there?* There are exactly two
architectures. Either there's one shared object every agent reads and writes (a
**blackboard**), or each agent receives only a specific, typed payload from a
specific sender (**message passing**). This choice is orthogonal to topology —
you can run a pipeline over a blackboard or over messages — but it determines
how coupled the agents are, how big their context gets, and how hard the system
is to debug.

```
  The two data-sharing substrates as layers

  ┌─ Topology layer (pipeline / fan-out / supervisor / ...) ──────────┐
  │  decides the SHAPE of who-talks-to-whom                           │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  but rides on ONE of ↓
  ┌─ Substrate A: BLACKBOARD ─────┐  ┌─ Substrate B: MESSAGE PASSING ─┐
  │ one shared object;            │  │ each agent gets ONLY a typed    │
  │ all agents read + write it    │  │ payload from a known sender     │
  │ implicit, broad coupling      │  │ explicit, narrow coupling       │
  └───────────────────────────────┘  └─────────────────────────────────┘
```

The substrate is the foundation the topology sits on. Choose it deliberately —
it's harder to change later than the topology.

## Structure pass

The axis is **how much each agent can see**. Blackboard: everything (the whole
shared state). Message passing: only what was sent to it (one typed payload).
The seam is the read/write boundary — global in a blackboard, point-to-point in
message passing.

```
  The visibility axis

  BLACKBOARD (see everything)          MESSAGE PASSING (see only your input)
  ────────────────────────►            ◄──────────────────────────────
  agents read the whole shared state   agents receive one typed payload
  any agent can write any field         only the sender hands you data
  context grows with the WHOLE run      context = just your input
  coupling: who-wrote-what is implicit  coupling: explicit, in the type
  → flexible, but bloats + hard to      → narrow, typed, debuggable;
    trace + corruptible                   can't see siblings' work

       ┌───────────┐                      A ──msg──► B ──msg──► C
       │ blackboard │ ◄─ A,B,C all R/W       each gets only the prior payload
       └───────────┘
```

The blackboard's flexibility is also its liability: every agent's context grows
to include the whole shared state (context bloat, file 09), any agent can
clobber any field, and tracing "who set this value" means reading the whole
history. Message passing trades that flexibility for a narrow, typed, traceable
seam.

## How it works

### Move 1 — the mental model

The two substrates map to two state-management styles you already know in
frontend.

```
  The state-management mental model (the topology IS this picture)

  BLACKBOARD = one global store       MESSAGE PASSING = props down, events up
  (Redux/Vuex: any component          (parent passes typed props to child;
   reads/writes the one store)         child gets ONLY its props)

  ┌──────────────┐                    <Parent>
  │ global store  │ ◄── compA           <Child anomaly={a} />   ← child sees
  │ {everything}  │ ◄── compB          </Parent>                   only `anomaly`
  └──────────────┘ ◄── compC
   any component sees all state         child can't reach the whole tree
```

For a frontend reader: a blackboard is a single global store (Redux/Vuex/Pinia)
where any component can read or dispatch to any slice — convenient, but you've
felt the pain of "which of forty components mutated this field?" Message passing
is plain props: a child component receives exactly the typed props its parent
hands it, nothing more. You reach for the global store when many distant
components need the same data; you reach for props when a child has a clean,
narrow input. The same trade-off, exactly, governs agents.

### Move 2 — step by step

**Blackboard substrate — agents share one mutable object.**

```
  blackboard: all agents R/W the same state
  ┌─────────────────────────────────────────┐
  │ state = { anomaly, diagnosis, recs, ... } │
  │   scan WRITES anomaly                      │
  │   investigate READS anomaly, WRITES diag.  │
  │   propose READS everything, WRITES recs    │
  └─────────────────────────────────────────┘
```

```
runBlackboard():
  state = {}                       # shared, mutable, global
  scan(state)                      # writes state.anomaly
  investigate(state)               # reads state.anomaly, writes state.diagnosis
  propose(state)                   # reads ALL of state, writes state.recs
  # every agent's context can include the whole state object
```

**Message-passing substrate — each agent gets only a typed payload.**

```
  message passing: typed handoff, point to point
  ┌────────┐ Anomaly  ┌──────────────┐ Diagnosis ┌──────────┐
  │ scan   │ ───────► │ investigate   │ ────────► │ propose   │
  └────────┘          └──────────────┘            └──────────┘
   investigate sees ONLY Anomaly; propose sees ONLY (Anomaly, Diagnosis)
```

```
runMessages():
  anomaly   = scan()                       # returns a typed Anomaly
  diagnosis = investigate(anomaly)         # receives ONLY the Anomaly
  recs      = propose(anomaly, diagnosis)  # receives ONLY those two values
  # no agent can see anything it wasn't handed
```

### Move 3 — the principle

The substrate decides coupling and context size. A blackboard couples every
agent to the whole shared state — convenient when many agents need broad
context, costly because each agent's context bloats toward the full state and
any agent can corrupt any field. Message passing couples each agent only to its
typed input — narrower, traceable (the type *is* the contract), and naturally
small context (you get your input, not the world). The principle: prefer message
passing with typed payloads unless agents genuinely need shared, broadly-read
state; the blackboard's flexibility is rarely worth its bloat and its
who-wrote-this debugging tax. And critically — if your handoffs are *already
typed*, you're already doing message passing for free.

## Primary diagram

AptKit's latent pipeline is message passing, by construction — drawn against the
blackboard alternative it deliberately isn't.

```
  AptKit's substrate: message passing (NOT a blackboard)

  WHAT AptKit's pipeline IS (message passing):
    ┌────────┐ Anomaly   ┌──────────────┐ Diagnosis ┌──────────┐
    │ scan   │ ────────► │ investigate(  │ ────────► │ propose( │
    │        │           │  anomaly)     │           │ anomaly, │
    └────────┘           └──────────────┘            │ diagnosis)│
                                                      └──────────┘
    each stage receives ONLY the prior stage's typed output ✓

  WHAT it is NOT (blackboard):
    ┌─────────────────────────────┐
    │ shared { anomaly, diagnosis }│ ◄── scan / investigate / propose all R/W
    └─────────────────────────────┘
    no agent reaches into a global store — the handoff is the typed value
```

## Implementation in this codebase

This is real and structural: AptKit's latent pipeline is **message passing by
construction**, because the handoffs are typed.

Use cases — the typed payloads that *are* the messages:

1. **`investigate` receives only an `Anomaly`.**
   `DiagnosticInvestigationAgent.investigate(anomaly: Anomaly)`
   (`packages/agents/diagnostic-investigation/src/diagnostic-agent.ts:55`). The
   anomaly is the entire message — the agent has no handle to a shared store, no
   way to read what `scan` was thinking. It gets the typed value and nothing
   else (`Anomaly` defined at
   `packages/agents/diagnostic-investigation/src/types.ts:5`).

2. **`propose` receives only `(Anomaly, Diagnosis)`.**
   `RecommendationAgent.propose(anomaly: Anomaly, diagnosis: Diagnosis)`
   (`packages/agents/recommendation/src/recommendation-agent.ts:64`). Two typed
   messages, no blackboard. The `Diagnosis` type
   (`packages/agents/recommendation/src/types.ts:16`) *is* the contract — that's
   the message-passing seam.

3. **No shared state object exists.** There is no global store any agent reads or
   writes; the only "state" inside a run is the `messages` array *local* to one
   `runAgentLoop` call (`packages/runtime/src/run-agent-loop.ts:94`), which never
   escapes the agent. Each agent's world is its function arguments.

This is the natural shape *because the contracts are typed* — once you've
written `investigate(anomaly: Anomaly)`, you've committed to message passing;
there's no shared mutable state to fall back into. The "naturally small context"
benefit follows for free: each agent's context is built from its typed input,
not from a growing shared object (which is one reason AptKit doesn't suffer
context bloat across the pipeline — see file 09).

One honest nuance carried from file 03: `Anomaly` and `Diagnosis` are
*structurally duplicated* across packages
(`diagnostic-investigation/src/types.ts:5-23` is byte-identical to
`recommendation/src/types.ts:5-23`). That doesn't make it a blackboard — it's
still point-to-point typed payloads — but a real orchestrator would hoist these
into one shared type package so the message contract has a single source of
truth.

## Elaborate

The reason this matters more than it looks: the substrate choice is *sticky*. If
you build a multi-agent system on a blackboard and later want to scale it, every
agent that grew to depend on reading arbitrary fields of the shared state is now
coupled to the whole thing — you can't move or replace one without auditing what
it reads. Message passing keeps each agent's dependency surface to its function
signature, so you can swap, mock, or test one stage in isolation (which is
exactly why AptKit can replay each agent against its own fixture — file 03 — with
no shared state to set up). Typed message passing isn't just cleaner; it's what
makes per-agent testing and per-agent replay possible.

The context-size consequence connects directly to file 09. On a blackboard,
every agent's prompt tends to grow toward "here's the whole shared state" —
context bloat that costs tokens and confuses the model. With typed message
passing, an agent's context is bounded by its input type. AptKit's pipeline gets
this bound for free: `investigate`'s context is one `Anomaly`, not the entire
run.

## Interview defense

**Q: "How do your agents share data — a shared state object?"**

"Message passing, not a blackboard — and I got it for free by typing the
handoffs. `investigate` takes an `Anomaly`; `propose` takes an `Anomaly` and a
`Diagnosis`. Each agent receives exactly its typed input and has no handle to a
shared store, so there's nothing global to corrupt and no who-wrote-this
debugging tax. It also keeps each agent's context small — bounded by its input
type rather than growing toward the whole run — which is part of why we don't
get context bloat across the pipeline. The frontend analogy is props-down versus
a global store: I'd only reach for a blackboard if many distant agents needed
the same broadly-read state, and even then I'd think twice. The one cleanup
before going live is hoisting the duplicated `Anomaly`/`Diagnosis` types into a
shared package so the message contract has a single source of truth."

```
  The one-line defense
  typed handoff = message passing (narrow, traceable, small context)
  shared mutable object = blackboard (flexible, but bloats + couples + corruptible)
```

Anchor: `diagnostic-agent.ts:55` and `recommendation-agent.ts:64` (the typed
payloads = the messages); `run-agent-loop.ts:94` (state is loop-local, never
shared); `types.ts:5,16` (the contracts that *are* the messages).

## Validate your understanding

1. **Spot the message.** Read `diagnostic-agent.ts:55`. What's the entire payload
   `investigate` receives? (One `Anomaly` — nothing else; no shared store.)

2. **Confirm no blackboard.** Search for a shared mutable state object every
   agent reads/writes. (There isn't one; `run-agent-loop.ts:94`'s `messages`
   array is local to one run.)

3. **Connect to context size.** Why does typed message passing keep an agent's
   context small? (Context is built from the typed input, not from a growing
   shared object — bounded by the input type.)

4. **Spot the sticky risk.** If you'd built this on a blackboard instead, what
   gets harder when you later want to replace one stage? (Every stage that reads
   arbitrary shared fields is coupled to the whole state — you can't swap or test
   one in isolation. Message passing keeps the dependency to the signature.)

## See also

- `03-sequential-pipeline.md` — the latent pipeline whose typed handoffs *are*
  the messages
- `07-graph-orchestration.md` — a graph threads state through nodes; it can do
  either substrate (this file is the choice it makes)
- `09-coordination-failure-modes.md` — context bloat (the blackboard failure)
  and why typed message passing avoids it
- `../04-agent-infrastructure/` — context engineering, where small typed inputs
  pay off
