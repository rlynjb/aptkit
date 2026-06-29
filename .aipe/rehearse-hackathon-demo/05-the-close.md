# Chapter 5 — The Close + The Ask   (8:45–9:30, 45 seconds)

## Opening hook

Forty-five seconds, and then you stop talking — on a beat, not a
trail-off. The most common way a good demo loses its last point is
ending on "yeah, so, that's it." You won't. You have three moves: name
where it goes next (clearly future, never demoed as if it exists), say
what you want from the room, and land one sentence they repeat to each
other after you sit down.

The discipline here is restraint. You've earned credibility; don't
spend it pitching a roadmap. Three crisp moves, then the last line,
then silence. The silence is part of the close — let the last line
land before you say "thank you."

## The time-budget bar

You own forty-five seconds and a thirty-second buffer after. Vision,
ask, last line — then stop.

```
  ┌──────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓░▓▓▓▓░░░ │
  │ 8:45 ─ 9:30 ──── buffer ──── 10:00                     │
  │     CLOSE + ASK — you own 8:45 to 9:30 (45 sec)       │
  └──────────────────────────────────────────────────────┘
```

## The diagram — now vs next vs the ask

The shape of the close: what's true today, what's clearly framed as
next, and the single ask. The dashed box is future — say it as future.

```
  THE CLOSE — now / next / ask

  ┌─ NOW (shipped, you just saw it) ─────────────────────────────┐
  │ toolkit on npm · 6 agents · grounded+cited RAG · live evals  │
  └───────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ NEXT (future — never demoed as if it exists) ────────────────┐
  ┊ buffr graduates the toolkit to a live Supabase pgvector store ┊
  ┊ — same VectorStore contract, swap the adapter, real persistence┊
  └───────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ THE ASK ─────────────────────────────────────────────────────┐
  │ "Try it — npm install, or open the demo. Tell me what breaks." │
  └───────────────────────────────────────────────────────────────┘
```

## Beat 1 — the vision (8:45–9:05)

Where it goes next, said as future. The honest, verifiable next step
is buffr — the companion repo that consumes the same toolkit and
binds it to a live Supabase pgvector store.

```
┃ "Everything you saw runs in-memory or local today. The next step
┃  is already underway in a companion repo: it takes this same
┃  toolkit and points the vector-store contract at a live Postgres
┃  pgvector store. Same contract — I swap the adapter, not the loop.
┃  That's the payoff of building on the two ports."
```

Note the framing: "is already underway," "the next step." Never "it
does." The persistence layer is future from this room's point of view,
and you say so.

## Beat 2 — the ask (9:05–9:20)

One concrete ask. Not "give me feedback" in the abstract — tell them
exactly what to do.

```
┃ "What I want from you: try it. It's on npm — one install — and the
┃  demo you saw is a static page you can open right now. Run a query,
┃  and tell me where the retrieval gets it wrong."
```

## Beat 3 — the last line (9:20–9:30)

The one sentence you want them repeating. It points back at the money
shot — the measured answer — because that's the thing that made them
react.

```
┃ "Most AI demos ask you to trust the answer. This one shows you the
┃  score that says it's right — and it runs on your own laptop."
```

Then stop. Let it sit for a beat. *Then* "thank you." Don't step on
your own last line.

## Strong vs weak — the close

```
  WEAK close                         STRONG close
  ─────────────────────────────      ──────────────────────────────
  "So in the future we could add     "Next step's already underway:
  cloud sync, maybe a hosted          point the same vector contract
  version, multi-tenant, a            at live pgvector — swap the
  marketplace, and… yeah, that's      adapter, not the loop. Try it
  basically it, any questions?"       on npm. Tell me where it's wrong."

  trails off; vision is vapor;        ends on a beat; future is one
  no concrete ask; no memorable       real step; ask is concrete; last
  line                                line points at the money shot
```

## IF IT BREAKS

The close has no live on-screen beat, so the failure mode is the
*demo before it* having eaten the clock.

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS (you're at 9:20 and only just starting the close)     ║
║ Skip beats 1 and 2 entirely. Go straight to the last line:         ║
║ "Most AI demos ask you to trust the answer — this one shows you    ║
║ the score that says it's right, on your own laptop. Thank you."    ║
║ The last line is the one thing in this chapter you never drop.     ║
╚══════════════════════════════════════════════════════════════════╝
```

## Tighten it

Cut the vision beat first — buffr/pgvector is the most skippable line
in the whole presentation. Then cut the ask down to "it's on npm — try
it." The floor: the **last line** always gets said, in full, with a
beat of silence after. End on the beat, every time.

## One-page run sheet — THE CLOSE

```
  ┌──────────────────────────────────────────────────────────────┐
  │ CLOSE + ASK            8:45–9:30          (no money shot)      │
  │                                                                │
  │ BEAT 1 (20s) — vision, as FUTURE:                              │
  │  • "Next step's underway in a companion repo — same toolkit,  │
  │     pointed at a live Postgres pgvector store. Swap the        │
  │     adapter, not the loop."                                   │
  │                                                                │
  │ BEAT 2 (15s) — the ask, concrete:                              │
  │  • "Try it — it's on npm, the demo's a static page you can    │
  │     open now. Tell me where retrieval gets it wrong."          │
  │                                                                │
  │ BEAT 3 (10s) — LAST LINE, then a beat of silence:              │
  │  • "Most AI demos ask you to trust the answer. This one shows │
  │     you the score that says it's right — on your own laptop."  │
  │                                                                │
  │ NAIL: the last line, verbatim, then pause, then "thank you"    │
  │ IF SHORT ON TIME: skip beats 1–2, go straight to last line     │
  │ TIGHTEN: cut vision first, then ask; never cut the last line   │
  └──────────────────────────────────────────────────────────────┘
```
