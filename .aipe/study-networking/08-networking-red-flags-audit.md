# Networking Red-Flags Audit

**Industry name:** network-failure risk audit / protocol-resilience review · *Project-specific*

## Zoom out, then zoom in

This is the file you reopen. It ranks every protocol-and-network-failure risk in aptkit by consequence, with the evidence for each verdict. No new mechanisms — just the ranked list and where to fix each.

```
  Zoom out — risks mapped onto the network surface

  ┌─ aptkit ────────────────────────────────────────────────┐
  │  Gemma/embed fetch → Ollama  ★ R1 no timeout ★           │
  │                              ★ R2 no transport retry ★    │
  │  Studio stream               R4 no stream timeout         │
  │  Studio dev API (unauth)     R5 (→ study-security)        │
  │  unbounded concurrent calls  R3 no client-side cap        │
  └──────────────────────────────────────────────────────────┘
  ┌─ buffr ──────────────────────────────────────────────────┐
  │  pg.Pool                     R6 TLS unset in code         │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** A red-flags audit is verdict-first risk triage: name the failure, rate its consequence, point at the line, name the fix. The pattern: **rank by what actually breaks in production, not by what's easy to spot.**

## Structure pass

**Axis — consequence: "if this fires, what does the user/system lose?"** That single axis orders the whole list. A hang (R1) loses the whole request with no recovery; an unset TLS option (R6) is governed by config that's probably already correct. Same surface, very different blast radius — that contrast is the ranking.

```
  Axis — blast radius — orders the risks

  R1 no timeout         ──► request hangs forever, no recovery    HIGH
  R2 no transport retry ──► transient blip = hard failure         MEDIUM
  R3 no concurrency cap  ──► burst could flood Ollama             LOW (seq. today)
  R4 no stream deadline  ──► a stuck stream hangs the UI          LOW-MED
  R5 unauth dev API      ──► (security seam, cross-linked)        SCOPED OUT
  R6 pg TLS unset in code──► relies on connection string          LOW
```

## How it works — the ranked audit

#### R1 — No per-call timeout on the Ollama `fetch` · HIGH

**Verdict:** the single most consequential network risk in the repo. A wedged Ollama daemon hangs the agent loop indefinitely.

**Evidence:** `defaultHttpTransport` in `packages/providers/gemma/src/gemma-provider.ts:201-215` and `packages/retrieval/src/ollama-embedding-provider.ts:60-75` both call `fetch` with only an optional caller `signal` — no `AbortSignal.timeout`. Nothing in the repo constructs a timeout signal to pass in.

```
  R1 — the hang path

  complete() ─► fetch(signal?) ─► Ollama stuck ─► ⧖ forever
                    ▲ no AbortSignal.timeout means no deadline
```

**Fix:** in each `defaultHttpTransport`, attach `AbortSignal.timeout(ms)` — merged with the caller's signal if present (`AbortSignal.any([signal, AbortSignal.timeout(ms)])`). One line per transport. Full treatment: `07-timeouts-retries-pooling-and-backpressure.md`.

#### R2 — No transport-level retry or backoff · MEDIUM

**Verdict:** a transient network blip (Ollama mid-restart, connection reset) becomes a hard failure, because the only retry is *semantic* (bad tool-call JSON), not *transport*.

**Evidence:** the retry loop in `gemma-provider.ts:62-89` re-issues the call only when the response parses but isn't a valid tool call (`looksLikeToolAttempt`). A thrown `fetch` error (connection refused, reset, non-2xx) propagates immediately — no retry, no backoff, no jitter. `FallbackModelProvider` retries across *providers*, which is a different mechanism and only configured in Studio's live modes.

**Fix:** wrap the transport `fetch` in a small retry-with-jitter for connection-level errors (not for `4xx`). Gate on R1 first — retry without a timeout never fires on a hang.

#### R3 — No client-side concurrency cap on Ollama calls · LOW (today)

**Verdict:** nothing limits in-flight requests to the daemon. Low *today* because agents run sequentially, so concurrency is effectively 1.

**Evidence:** no semaphore, queue, or `p-limit` around the `fetch` calls. Contrast buffr's `pg.Pool`, whose bounded size *does* provide backpressure (`buffr/src/pg-vector-store.ts`, `connect()` queues when saturated). aptkit's HTTP path has no equivalent.

**Fix:** none needed while execution is sequential; if Studio or buffr ever fans out agents concurrently against one Ollama, add a concurrency limiter. Tracked as a `not yet exercised` mechanism in `07`.

#### R4 — No deadline on the streaming response · LOW-MEDIUM

**Verdict:** the NDJSON stream has no overall timeout; a replay whose underlying model call hangs (see R1) holds the response open and leaves the browser's `for await` loop waiting.

**Evidence:** `streamReplayResponse` (`apps/studio/vite.config.ts:888-919`) writes until `run` resolves; if the inner provider call hangs (R1), the stream never reaches its `result` line. The client loop in `apps/studio/src/api.ts:138-161` reads until the body ends — with no client-side abort.

**Fix:** this is mostly downstream of R1 — bounding the model call bounds the stream. A belt-and-suspenders client `AbortController` with a deadline would also cap it.

#### R5 — Unauthenticated Studio dev API · SCOPED OUT → `study-security`

**Verdict:** the vite middleware exposes replay/promote/save routes with no auth (`apps/studio/vite.config.ts:201-526`), and `/api/replay/save` writes files. This is a *trust-boundary* concern, not a *protocol/network-failure* one.

**Evidence:** `resolveReplayPath` (`vite.config.ts:1416-1425`) does constrain writes to `artifacts/replays`, which is the one network-input-validation control on that surface. Full analysis belongs to the neighbor guide.

**Fix:** owned by `study-security` (boundary safety). Mentioned here only so the audit is complete; the dev server is local-only by design.

#### R6 — Database TLS not set in buffr's code · LOW

**Verdict:** `pg.Pool` is built from `connectionString` alone with no explicit `ssl` option, so encryption to Supabase depends entirely on the `DATABASE_URL` and the PaaS, not on code.

**Evidence:** `buffr/src/db.ts:4-6` — `new pg.Pool({ connectionString: databaseUrl })`, no `ssl`. Whether the wire is encrypted is `not yet verified in code`; Supabase URLs typically imply TLS, but the repo is silent.

**Fix:** make TLS explicit (`ssl: { rejectUnauthorized: true }` or a documented `sslmode=require` in the URL) so encryption isn't an implicit assumption. Treatment: `04-tls-and-trust-establishment.md`.

## Primary diagram

```
  Networking red-flags — ranked, with fix location

  ┌──────┬──────────────────────────────┬────────┬─────────────────────────┐
  │ rank │ risk                         │ sever. │ fix lives in            │
  ├──────┼──────────────────────────────┼────────┼─────────────────────────┤
  │  R1  │ no Ollama fetch timeout      │ HIGH   │ transport (1 line) · 07 │
  │  R2  │ no transport retry/backoff   │ MEDIUM │ transport wrapper  · 07 │
  │  R4  │ no stream deadline           │ LOW-MED│ downstream of R1        │
  │  R3  │ no concurrency cap           │ LOW    │ limiter if concurrent   │
  │  R6  │ pg TLS unset in code         │ LOW    │ buffr db.ts · 04        │
  │  R5  │ unauth dev API               │ → sec  │ study-security          │
  └──────┴──────────────────────────────┴────────┴─────────────────────────┘
```

## Elaborate

The shape of this audit is typical of a young, well-factored system: the *architecture* is sound (injectable transports, a provider contract, loopback-only sockets), and the risks are all missing *hardening* — timeouts, retries, explicit TLS — rather than structural flaws. That's the good kind of debt: each fix is local and additive because the seams are already in the right place. The `AbortSignal` is plumbed (R1's fix is one line *because* the wire exists), the transports are swappable (R2's retry wrapper has a clean place to live), and the pool already gives backpressure where it matters. Rank-ordering forces the honest call: fix the hang first, because retries and stream deadlines are all downstream of it.

## Interview defense

**Q: "What's the biggest network risk in your system and how would you fix it?"**
One sentence, then the fix: "A wedged Ollama daemon hangs the agent loop forever, because the `fetch` to it has no timeout — it forwards a caller's `AbortSignal` but never sets a deadline. The fix is one line: `AbortSignal.timeout` in the transport, merged with the caller's signal." Then show you ranked it: "Everything else is downstream — transport retry and stream deadlines only matter once the wait is bounded, and concurrency limits only matter once agents run in parallel, which they don't yet."

```
  sketch: fix order follows the dependency

  R1 timeout ──► unblocks ──► R2 retry ──► R4 stream deadline
  (fix this first; the rest are downstream)
```

Anchor: *the hang is the root risk — bound the wait before adding any retry.*

## See also

- `07-timeouts-retries-pooling-and-backpressure.md` — R1/R2/R3/R4 in full
- `04-tls-and-trust-establishment.md` — R6, the TLS story
- `00-overview.md` — the ranked findings in the context of the whole map
- `study-security` (neighbor guide) — R5 and every trust boundary
