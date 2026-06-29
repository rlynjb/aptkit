# Networking Red-Flags Audit

**Ranked protocol & network-failure risks · evidence per verdict** — *Project-specific*

## Zoom out — where the risks concentrate

Every risk in this audit lives at one boundary: the outbound `fetch` to Ollama. aptkit's network surface is so small that the failure modes concentrate at a single point — which is good (one place to fix) and a trap (one place to forget). Here's the risk map.

```
  Zoom out — risks cluster at the one outbound wire

  ┌─ aptkit ─────────────────────────────────────────────────┐
  │  defaultHttpTransport: await fetch(localhost:11434)       │ ← ALL ranked risks here
  │     #1 no timeout   #2 no retry/status-awareness          │
  │     #3 host override → silent plaintext exposure          │
  └──────────────────────────┬─────────────────────────────────┘
                             │
  ┌─ Ollama / Studio / buffr ▼─────────────────────────────────┐
  │  lower-severity / other-repo / not-yet-exercised items     │
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

A **red-flags audit** ranks the repo's network-failure and protocol risks by *consequence*, names the evidence for each, and says what to do. Not a checklist of best practices — a triage. The verdict shape: each item is `severity · evidence (file:line) · concrete failure · the move`. The partition: this names *what breaks on the wire*; **study-security** owns *whether each boundary is safe*; **study-system-design** owns *where the boundaries belong*.

## Structure pass — the skeleton

**Axis traced — "what's the blast radius when this fails?"** Ranked high→low by that single question.

```
  One question across the risks: "blast radius on failure?"

  #1 no timeout        → whole interactive session wedges      HIGH
  #2 no retry/status   → transient blip = hard failure         MEDIUM
  #3 host override     → silent plaintext-on-network exposure  MEDIUM (conditional)
  #4 no stream timeout → slow client buffers trace in memory   LOW
  #5 unbounded body    → huge Ollama response, no size cap     LOW
  ── not yet exercised: DNS, TLS, CORS, pooling, websockets ──
```

**Seam — the transport function.** Items #1, #2, #3, #5 all live inside the same ~15 lines (`defaultHttpTransport`). Fix the transport and four of five top risks close.

## How it works — the ranked audit

### Move 1 — the triage shape

Each risk is one card: severity, the line that proves it, the concrete failure, the fix. Read top to bottom; the top one is the only one that bites at one-user scale.

```
  The audit card shape

  ┌─────────────────────────────────────────────┐
  │ SEVERITY  · the risk in one line              │
  │ evidence: file:line                           │
  │ failure:  if X happens, Y breaks (concrete)   │
  │ move:     the fix, named                       │
  └─────────────────────────────────────────────┘
```

### Move 2 — the cards, ranked

---

**#1 · HIGH — No per-call timeout on the Ollama `fetch`.**

- **Evidence:** `packages/providers/gemma/src/gemma-provider.ts:201-215` and `packages/retrieval/src/ollama-embedding-provider.ts:60-75` — `await fetch(url, {...(signal ? {signal} : {})})` with no `AbortController` + `setTimeout`. The signal threads from `run-agent-loop.ts:91` but nothing fires it on a deadline.
- **Failure (concrete):** Ollama accepts the TCP connection, then stalls — loading a 9B model into VRAM, swapping under memory pressure, or a wedged daemon. `await fetch` never resolves. The agent turn blocks indefinitely; in the CLI/agent path no outer caller aborts, so the whole interactive session hangs with no error and no recovery.
- **Move:** Add a transport-local `AbortController` + `setTimeout(() => controller.abort(), DEADLINE)`, merged with the caller's signal. No contract above the transport changes (see `07` Move 2.5). This is the one resilience fix to ship even at one user — it guards liveness, not scale.

```
  the gap in one frame

  await fetch(…, {signal?})     ← signal present, nothing fires it
        │
        └─ Ollama stalls (socket open) → hangs forever ★
```

---

**#2 · MEDIUM — Binary status handling: any non-2xx is a terminal throw, no retry, no status-awareness.**

- **Evidence:** `gemma-provider.ts:210`, `ollama-embedding-provider.ts:69` — `if (!res.ok) throw new Error(...)`. No retry, no backoff, no `Retry-After`/429 handling.
- **Failure (concrete):** Ollama returns `503 model loading` during a cold start — a transient, self-healing condition. aptkit throws immediately; the agent run fails instead of waiting 2 seconds and succeeding. A 429, 500, and 404 are indistinguishable beyond the message string, so no condition-specific recovery is possible.
- **Move:** For idempotent calls, add retry-with-jittered-backoff on retryable statuses (429, 503, network errors). Keep fail-fast for 4xx that won't self-heal. Note the `FallbackModelProvider` is *provider* failover, not *call* retry — they're complementary, not substitutes.

---

**#3 · MEDIUM (conditional) — A `host` override silently turns plaintext-on-loopback into plaintext-on-a-network.**

- **Evidence:** `gemma-provider.ts:48` / `ollama-embedding-provider.ts:47` — `options.host ?? 'http://localhost:11434'`; buffr passes `OLLAMA_HOST` (`buffr/src/config.ts:14`). The scheme is `http`, hardcoded into the transport's URL build.
- **Failure (concrete):** Someone sets `host: 'http://10.0.0.5:11434'` to use a shared LAN Ollama. The prompts and embeddings now travel **unencrypted across the network** — and there's no code path that would add TLS, because the scheme is baked as `http`. No warning, no failure; it just works, insecurely.
- **Move:** When `host` is non-loopback, require `https:` (or fail loud), or front the remote Ollama with a TLS-terminating proxy. The `whether-it's-safe` framing belongs to **study-security**; the on-the-wire fact is "the bytes are plaintext the moment the host leaves the box."

---

**#4 · LOW — No backpressure handling on the NDJSON stream write.**

- **Evidence:** `apps/studio/vite.config.ts:908` — `res.write(encodeNdjsonRecord(...))` ignores the return value; no `drain` wait.
- **Failure (concrete):** A slow client consuming a very large trace can't keep up; writes buffer in the server's socket memory. For the small traces here (a handful of events) this never bites, but a pathological trace + slow reader would grow memory.
- **Move:** Honor `res.write`'s backpressure signal (wait for `drain`) if trace sizes ever grow. Today: acceptable, dev-only, small payloads.

---

**#5 · LOW — Unbounded response body read.**

- **Evidence:** `gemma-provider.ts:213`, `ollama-embedding-provider.ts:72` — `await res.json()` reads the full body with no size cap.
- **Failure (concrete):** A misconfigured or malicious Ollama returning a multi-gigabyte body would be buffered entirely into memory before parsing. For a trusted local daemon this is theoretical.
- **Move:** Acceptable for a trusted loopback dependency; would matter only if the host pointed at an untrusted server.

---

### Move 2.5 — what's NOT a red flag (correctly absent)

These are absences that are *right*, not gaps — naming them prevents a reviewer from flagging them as missing.

```
  Correctly absent — not findings

  DNS / routing      → loopback target, no resolution needed
  TLS on loopback    → same-machine, no network to encrypt
  CORS               → same-origin dev; static prod build has no API
  HTTP retry at scale→ one user, one local origin; fail-fast is honest
  WebSockets/SSE     → one-way request-scoped trace, chunked NDJSON suffices
```

Each is `not yet exercised` (see `00-overview.md`) and would become relevant only on a specific architecture change (remote host, hosted model, cross-origin UI).

### Move 3 — the principle

A small network surface concentrates risk rather than eliminating it. aptkit has one outbound wire, so it has one place to get timeouts, status-handling, and TLS-on-override right — and one place to forget them. The audit's verdict: the surface is honestly minimal and the absences are mostly correct, with exactly one that bites at any scale (the timeout) and two that bite the moment the wire goes remote or flaky (status-awareness, plaintext-on-override). Fix the transport function and four of five top risks close at once. The principle: rank by blast radius, fix the liveness bug first, and document the correct absences so they don't get cargo-culted into existence.

## Primary diagram

The full ranked audit in one frame.

```
  aptkit networking red-flags — ranked by blast radius

  HIGH    #1 no timeout          gemma-provider.ts:201  → session hangs forever
  ────────────────────────────────────────────────────────────────────────────
  MEDIUM  #2 binary status       gemma-provider.ts:210  → transient blip = hard fail
  MEDIUM  #3 host→plaintext      gemma-provider.ts:48   → remote http = exposed (cond.)
  ────────────────────────────────────────────────────────────────────────────
  LOW     #4 no stream drain     vite.config.ts:908     → slow client buffers memory
  LOW     #5 unbounded body      gemma-provider.ts:213  → huge body buffered (trusted)
  ────────────────────────────────────────────────────────────────────────────
  CORRECT DNS · TLS-loopback · CORS · retry-at-scale · websockets  (not findings)
  ABSENCE

  4 of 5 top risks live in ONE function: defaultHttpTransport
```

## Elaborate

Red-flags audits are most useful when they rank by consequence and resist the urge to flag every missing best practice. aptkit's network audit is short because its surface is short — and the discipline is distinguishing a *gap* (the timeout, which bites now) from a *correct absence* (TLS on loopback, which would be cargo-cult). The single highest-leverage move is the timeout, and it's cheap because the cancellation mechanism is already plumbed end-to-end. Everything else is either correctly deferred until the architecture changes or genuinely low-stakes for a single-user local tool. For *whether* the plaintext-on-override and the (gitignored) API keys are a security exposure, hand off to **study-security**; for how the timeout composes with the fallback chain under partial failure, hand off to **study-distributed-systems**.

## Interview defense

**Q: What's the biggest networking risk in your codebase?**
No per-call timeout on the outbound `fetch` to Ollama. The `AbortSignal` is threaded end-to-end, but nothing fires it on a deadline, so a stalled daemon hangs the whole session with no error. It's the only risk that bites at one-user scale, and the fix is local — a controller plus a timer inside the transport.

```
  HIGH: no timeout → hang   (4 of 5 top risks in one ~15-line function)
  fix the transport → most of the audit closes
```
Anchor: *"small surface concentrates risk — one function holds four of five top items; the timeout is the one that bites now."*

**Q: What network risks did you deliberately NOT address?**
DNS, TLS on loopback, CORS, retry-at-scale, WebSockets — all correctly absent for a single-user, single-local-origin tool. I name them as `not yet exercised` rather than building them speculatively; each becomes real only on a specific change (remote host, hosted model, cross-origin UI).

## See also

- `07-timeouts-retries-pooling-and-backpressure.md` — finding #1 in depth, with the fix
- `04-tls-and-trust-establishment.md` — finding #3, the plaintext-on-override path
- `05-http-semantics-caching-and-cors.md` — finding #2, the binary status model
- `00-overview.md` — the ranked findings and `not yet exercised` inventory
