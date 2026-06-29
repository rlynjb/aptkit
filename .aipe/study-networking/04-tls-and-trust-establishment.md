# TLS and Trust Establishment

**Industry name:** TLS / transport encryption / certificate trust · *Industry standard*

## Zoom out, then zoom in

Above the TCP connection sits the question "is this byte stream encrypted, and do I trust the other end?" Here's where that question gets answered in this system — and where it's deliberately skipped.

```
  Zoom out — where encryption lives (and doesn't)

  ┌─ aptkit code ──────────────────────────────────────────────┐
  │  fetch('http://localhost:11434/api/chat')                  │
  │    ★ http:// — NO TLS ★  (loopback, plaintext)             │
  └───────────────────────────┬────────────────────────────────┘
                              │
  ┌─ dependency boundary ────▼─────────────────────────────────┐
  │  Anthropic/OpenAI SDK → https:// → TLS handshake (SDK owns) │
  │  buffr pg.Pool → TLS to Supabase (driver/PaaS owns)         │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** TLS does two jobs: it encrypts the byte stream so no one in the middle can read it, and it proves the server is who it claims via a certificate signed by a trusted authority. In aptkit's own code, neither job is needed — the only socket goes to loopback, where there's no "middle" to defend against. So TLS in this system is entirely a dependency concern. The pattern to learn: **TLS is a cost you pay to defend a hop against an untrusted network, and a loopback hop has no untrusted network to defend.**

## Structure pass

**Layers:** TCP (the raw connection) → TLS (encryption + identity, optional) → HTTP (the application). TLS is the middle layer that aptkit's code skips and its dependencies add.

**Axis — trust: "could someone read or tamper with these bytes in flight?"** Trace it:

```
  Axis — in-flight trust — across the encryption surfaces

  hop                       scheme   TLS?   why
  ──────────────────────────────────────────────────────────────────
  Gemma → Ollama            http://  NO     loopback: no network to sniff
  embed → Ollama            http://  NO     same
  Anthropic/OpenAI SDK      https:// YES    public internet (SDK enforces)
  buffr pg.Pool → Supabase  (pg)     YES*   public internet (PaaS expects TLS)
```

\* `not yet verified in buffr's code` — the pool is built from `connectionString` alone (`buffr/src/db.ts:4-6`) with no explicit `ssl` option; Supabase's URL typically carries the TLS expectation, but the repo doesn't set it.

**Seam:** the scheme flip from `http://` to `https://` is the seam. It's the exact line where "trusted local channel" becomes "must encrypt and authenticate." aptkit's code lives entirely on the `http://` side.

## How it works

#### Move 1 — the mental model

You've seen the padlock in the browser. That padlock is TLS: before any HTTP data flows, the client and server do a handshake where the server presents a certificate (a public key signed by a CA the client trusts), they agree on a shared secret, and from then on the stream is encrypted. The kernel is *identity + encryption negotiated up front*.

```
  The pattern — TLS handshake on top of TCP

  client                                  server
    │ ── (TCP handshake first) ──────────►  │
    │ ── ClientHello (ciphers) ──────────►  │
    │ ◄── ServerHello + CERTIFICATE ──────  │   server proves identity
    │ ── verify cert against trusted CAs ─  │   (client checks the signature)
    │ ── key exchange ───────────────────►  │
    │ ◄══ encrypted application data ═════► │   everything after = ciphertext
```

The part people forget: TLS adds *round trips on top of the TCP handshake* (one extra RTT for TLS 1.3, two for 1.2) before your first byte of HTTP. On loopback that cost is pointless — there's no attacker between two processes on the same machine — so skipping it is the right call, not a shortcut.

#### Move 2 — walking the trust boundaries in this repo

**The Ollama hop is plaintext on purpose.** The transport builds a `http://localhost:11434` URL (`packages/providers/gemma/src/gemma-provider.ts:48`, `packages/retrieval/src/ollama-embedding-provider.ts:47`). The `http` scheme means `fetch` opens a raw TCP connection with no TLS handshake. There's no certificate to verify, no cipher to negotiate, no key to manage. This is correct: the traffic never leaves the machine, so encrypting it defends against nothing.

```
  Layers-and-hops — the plaintext loopback hop

  ┌─ aptkit transport ──────────┐  hop C: plaintext HTTP   ┌─ Ollama ──────┐
  │  fetch('http://localhost..')│ ───────────────────────► │ :11434        │
  └──────────────────────────────┘  no TLS, no cert check   └───────────────┘
        no attacker possible between two processes on 127.0.0.1
```

**Cloud TLS is real but invisible to aptkit.** `new Anthropic({ apiKey })` and `new OpenAI({ apiKey })` (`packages/providers/anthropic/src/...:25`, `packages/providers/openai/src/openai-provider.ts:30`) talk `https://` to their APIs. The full handshake — certificate verification against the system trust store, cipher negotiation, key exchange — happens inside the SDK. aptkit never writes a line of TLS code; it just hands over an API key (the *application*-layer credential, carried inside the already-encrypted channel). The key in `.env` is the secret; TLS is what keeps it from being readable on the wire — and that's the SDK's job.

**buffr's database TLS is unset in code.** `createPool(databaseUrl)` passes only `{ connectionString }` to `pg.Pool` (`buffr/src/db.ts:4-6`) with no `ssl: ...` option. Whether the connection is encrypted depends on the `DATABASE_URL` (e.g. an `sslmode=require` query param) and Supabase's server policy. The code itself is silent on TLS — that's a real observation, not a recommendation: the repo delegates the decision to the connection string and the PaaS.

**TLS termination, mTLS, cert pinning, custom CAs:** `not yet exercised`. The repo terminates no TLS itself (it runs no public server — Studio in prod is static files behind GitHub's CDN, which terminates TLS for you). There's no mutual TLS, no certificate pinning, no custom trust store anywhere in aptkit's code.

#### Move 3 — the principle

The principle: **encrypt the hops that cross an untrusted network; don't pay TLS where there's no network to defend.** aptkit gets this exactly right by accident of design — its only socket is loopback, so plaintext is correct, and every encrypted hop is owned by a dependency that does TLS properly. The danger is the same one timeouts have: the moment the Ollama `host` points at a remote box, that `http://` becomes a plaintext credential leak across the internet, and the scheme would have to flip to `https://` with a real certificate.

## Primary diagram

```
  TLS recap — the http:// → https:// seam

  aptkit owns          │  http:// (plaintext, loopback)
  ─────────────────────┼─────────────────────────────────────
  Gemma / embed ───────┼──► localhost:11434   NO TLS  ✓ correct
                       │
  dependencies own     │  https:// (encrypted, internet)
  ─────────────────────┼─────────────────────────────────────
  Anthropic/OpenAI SDK ┼──► api.*.com         TLS, cert-verified
  buffr pg.Pool ───────┼──► Supabase          TLS expected (not set in code)
  Studio Pages (prod) ─┼──► github.io         TLS terminated by GitHub CDN
```

## Elaborate

TLS exists because the internet is a shared medium — any router on the path can read plaintext. Loopback isn't shared, which is why local-daemon protocols (Ollama, Postgres-on-localhost, Redis) routinely run unencrypted. The hard parts of TLS — certificate chain validation, revocation, cipher downgrade attacks — all live in the libraries here, which is the right place for them; reimplementing TLS is how you get CVEs. When aptkit goes remote, the upgrade isn't subtle: flip the scheme, get a cert, and the handshake-cost from `03` doubles the round trips before first byte. See `study-security` for the trust-boundary view of the same hops (this file owns *the encryption mechanism*; security owns *whether each boundary is safe*).

## Interview defense

**Q: "Is your traffic encrypted? Walk me through the TLS story."**
Lead with the verdict: "My own code opens one socket — plaintext HTTP to a local Ollama daemon — and that's correct, because it's loopback, so there's no network to encrypt against. Every hop that crosses the internet is encrypted by a dependency: the Anthropic and OpenAI SDKs do `https://` with full cert verification, and the database connection's TLS is governed by the connection string and Supabase." Then name the trap: "If I pointed Ollama at a remote host, that `http://` would leak across the wire and I'd have to switch to TLS."

```
  sketch: the scheme seam

  http://  loopback   → no TLS (correct, no network)
     │ flip when remote
  https:// internet   → TLS, verify cert, +1 RTT
```

Anchor: *don't encrypt a channel that has no eavesdropper — loopback has none.*

## See also

- `03-tcp-udp-connections-and-sockets.md` — TLS rides on top of the TCP handshake
- `02-dns-routing-and-addressing.md` — resolution happens before TLS can start
- `study-security` (neighbor guide) — whether each trust boundary is *safe*, not just *encrypted*
