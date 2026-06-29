# The Injectable Transport Seam

**Industry name(s):** dependency injection / seam / test double · **type:**
Industry standard

A sub-port inside the Gemma adapter. The HTTP call to Ollama isn't hard-
wired — it's a function (`GemmaChatTransport`) passed into the
constructor. That one injection point turns an adapter that *requires a
running Ollama server* into one you can test with recorded responses and
zero network. The seam is small; what it buys is the whole emulation
walked in `02` becoming deterministically testable.

---

## Zoom out, then zoom in

Here's the adapter from the inside. Everything in `02` — render tools,
parse the reply, retry — sits above one line: the actual `POST /api/chat`.
That line is the seam, and it's swappable.

```
  Zoom out — the transport seam inside the adapter

  ┌─ Client layer ───────────────────────────────────────────────┐
  │ runAgentLoop → ModelProvider.complete()                       │
  └────────────────────────────┬──────────────────────────────────┘
  ┌─ Adapter: GemmaModelProvider ▼─────────────────────────────────┐
  │ buildSystemText · parseToolCall · retry  (the emulation, see 02)│
  │                          │ calls this.chat(payload)             │
  │  ┌─ Transport sub-port ★ ▼──────────────────────────────────┐ │  ← we are here
  │  │ GemmaChatTransport: (payload) => Promise<OllamaChatResponse>│ │
  │  └──────────────────────────────────────────────────────────┘ │
  └────────────────────────────┬──────────────────────────────────┘
       real adapter ───────────┤────────────── test adapter
  ┌─ Provider layer ───────────▼──┐   ┌────────────────────────────┐
  │ defaultHttpTransport → Ollama │   │ recorded responses (no net) │
  └───────────────────────────────┘   └────────────────────────────┘
```

Zoom in: the concept is a **seam** — a boundary you can swap on one side
without touching the other. The question: *how do you test an adapter
whose entire job is talking to a local server, without standing up the
server?* Answer: make the talking-to-the-server part injectable, and pass
a fake.

---

## The structure pass

**Layers.** Emulation logic (the adapter's body) → transport sub-port
(`GemmaChatTransport`) → I/O (real HTTP, or a recorded map in tests).

**Axis — trace `lifecycle` (when does the real network happen?).**

```
  One axis: "does this run touch the network?"

  ┌─ emulation logic ──┐  pure — same code in prod and test
  │ build/parse/retry  │ ═══════════════════════════════╪══►
  └────────────────────┘                           (it flips)
  ┌─ transport sub-port┐  PROD: real fetch · TEST: recorded, no net
  │ this.chat(payload) │
  └────────────────────┘
```

**Seam.** The transport boundary is load-bearing because the `lifecycle`
axis flips: above it, identical pure logic; below it, real I/O in
production and zero I/O in tests. A boundary where "does this hit the
network?" changes is exactly the boundary you want to control in a test.

---

## How it works

### Move 1 — the mental model

You've passed a `fetch` implementation (or a mock) into a function so a
test doesn't hit the real API — `new ApiClient({ fetch: fakeFetch })`. A
seam is that, named and typed. The Gemma adapter's constructor takes an
optional `chat` function; pass nothing and it builds the real HTTP one,
pass a fake and the same emulation logic runs against your canned
responses.

```
  Pattern — one constructor arg flips the I/O side

   new GemmaModelProvider()                → real HTTP transport (prod)
   new GemmaModelProvider({ chat: fake })  → recorded transport (test)
                                  │
                                  ▼
            same buildSystemText / parseToolCall / retry runs either way
```

### Move 2 — the step-by-step walkthrough

**Step 1 — the transport is a typed function, not a class.** The seam is
defined as a single function type (`gemma-provider.ts:18–25`):

```ts
export type GemmaChatTransport = (payload: {
  model: string;
  messages: { role: string; content: string }[];
  stream: false;
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<OllamaChatResponse>;
```

That's the whole sub-port. A function in, a response out — the smallest
possible seam.

**Step 2 — injected with a real default.** The constructor takes it
optionally and falls back to the real HTTP transport
(`gemma-provider.ts:46–50`):

```ts
this.chat = options.chat ?? defaultHttpTransport(options.host ?? 'http://localhost:11434');
```

Default behavior is the real thing — no test ceremony in production. This
is dependency injection with a sensible default: the adapter works out of
the box and is swappable when you need it.

**Step 3 — the emulation calls the seam, blind to which side it got.**
Inside `complete`, the body just calls `this.chat(...)`
(`gemma-provider.ts:69`):

```ts
lastResponse = await this.chat({ model, messages, stream: false, ...(signal ? { signal } : {}) });
```

`buildSystemText`, `parseToolCall`, and the retry loop all run against
whatever `this.chat` returns. They can't tell a real Ollama response from
a recorded one — which is exactly the point. The emulation logic from
`02` is tested in full without a server.

**Step 4 — the real transport is isolated below the seam.** The actual
`fetch` lives in one place (`defaultHttpTransport`, :201) — the only
network code in the file, behind the seam, never touched by a test that
injects its own `chat`.

```
  Layers-and-hops — same logic, two transports

  PRODUCTION                          TEST
  ┌─ complete() ─┐                    ┌─ complete() ─┐
  │ build/parse  │  hop: this.chat()  │ build/parse  │  hop: this.chat()
  └──────┬───────┘                    └──────┬───────┘
         ▼ real                              ▼ fake
  ┌─ defaultHttpTransport ┐           ┌─ recorded map ──────┐
  │ POST :11434/api/chat  │           │ returns canned      │
  │ (network)             │           │ OllamaChatResponse  │
  └───────────────────────┘           │ (no network)        │
                                       └─────────────────────┘
       the box above the hop is byte-identical in both columns
```

### Move 2 variant — the load-bearing skeleton

1. **Kernel:** a typed transport function + constructor injection with a
   real default + the body calling only the injected function.

2. **What breaks if removed:**
   - Hard-wire `fetch` inside `complete` → you can't test the emulation
     without a running Ollama; the parse/retry logic (the part most
     likely to have bugs) becomes untestable in CI.
   - Drop the real default → every construction site must supply a
     transport, including production; the adapter stops being usable out
     of the box.
   - Let the body branch on "am I in a test?" → the test-vs-prod
     knowledge leaks into the emulation logic; the seam exists precisely
     so it doesn't.

3. **Skeleton vs hardening:** the kernel is type + injection + default.
   The `signal` threading through the payload is hardening (cancellation
   support), and the `host` option is convenience.

### Move 3 — the principle

The unit you most need to test is usually wrapped around an I/O call you
can't make in a test. Put a seam at the I/O boundary — inject it, default
it to the real thing — and the logic above the seam becomes pure and
testable while production stays zero-ceremony. The smaller the seam (here,
one function), the cheaper the swap.

---

## Primary diagram

```
  The injectable transport seam — full recap

  ┌─ Adapter: GemmaModelProvider ───────────────────────────────────┐
  │  EMULATION (pure — see 02)                                       │
  │   buildSystemText → this.chat → parseToolCall → retry            │
  │                         │ calls the seam                         │
  │  ┌─ Seam ★: GemmaChatTransport ▼──────────────────────────────┐ │
  │  │ (payload) => Promise<OllamaChatResponse>                    │ │
  │  │ injected via ctor; defaults to defaultHttpTransport(:201)   │ │
  │  └──────────────────────────────┬──────────────────────────────┘ │
  └─────────────────────────────────┼────────────────────────────────┘
              prod ──────────────────┼────────────────── test
  ┌─ defaultHttpTransport ───────────▼──┐   ┌──────────────────────────┐
  │ POST localhost:11434/api/chat (net) │   │ recorded responses (no net)│
  └─────────────────────────────────────┘   └──────────────────────────┘
        lifecycle axis flips here: real I/O ↔ no I/O
```

---

## Elaborate

This is dependency injection used to create a *seam for testing* — the
classic reason DI earns its keep. The whole point of the deep adapter in
`02` is that it hides a lot of fragile logic (JSON parsing, retry
heuristics) behind the port. That fragility is exactly what you must
test, and you can't if the only way to run it is against a live model.
The transport seam resolves the tension: deep adapter, fully testable.

It's the same instinct as the `FixtureModelProvider` test double (the
audit's lens-2 duplication finding) but one level finer — there, the
*whole provider* is faked; here, only the *transport inside* one provider
is faked, so you test the real emulation logic rather than bypassing it.
Both are seams; they sit at different depths.

You've built this shape before: dryrun's on-device AI with an API
fallback is the same move — the on-device call and the cloud call sit
behind one boundary so the app code doesn't branch. The transport seam is
that pattern shrunk to a single function inside one adapter.

Read next: `02-emulation-hidden-behind-the-port.md` (the logic this seam
makes testable), `01-deep-provider-port.md` (the port this all sits under).

---

## Interview defense

**Q: Why inject the transport instead of mocking `fetch` globally?** A
typed, injected seam is local and explicit: the test passes exactly the
responses it wants, scoped to this adapter, and the type
(`GemmaChatTransport`) documents the contract. Global `fetch` mocking is
implicit, leaks across tests, and couples the test to the URL and HTTP
details rather than to the adapter's logic. The injected function tests
the *emulation*, not the network plumbing.

```
  what the test exercises

  global fetch mock:  HTTP details + emulation (coupled, leaky)
  injected transport: emulation ONLY (the fragile parse/retry part)
```

Anchor: "inject the seam, test the logic, skip the network."

**Q: The transport defaults to real HTTP — doesn't that risk a test
accidentally hitting Ollama?** No, because the test *constructs* the
provider with its own `chat`; the default only applies when no transport
is passed, which a test never does. The default exists so production is
zero-ceremony, not so tests fall back to it. If a test forgot to inject,
it'd fail trying to reach `localhost:11434` — loud, not silent. The
design makes the prod path the default and the test path explicit, which
is the right bias.

Anchor: "default to real for prod ergonomics; tests opt into the fake explicitly."

---

## See also

- `02-emulation-hidden-behind-the-port.md` — the logic this seam makes testable
- `01-deep-provider-port.md` — the outer port; this is a sub-port inside it
- `00-overview.md` — seam / DI in the PATTERN VOCABULARY
- `audit.md` — lens 2 (the `FixtureModelProvider` double at a coarser depth)
- `../study-testing/` — the deterministic test strategy this enables
