# 04 — TLS and trust establishment

**Industry name(s):** TLS / encryption in transit / certificate trust. **Type:** Industry standard.

## Zoom out — where this concept lives

TLS sits between the TCP socket (file `03`) and HTTP (file `05`) — it's the encryption wrapper around the byte pipe. Here's which of AptKit's connections is wrapped and which is bare.

```
  Zoom out — TLS on one boundary, plaintext on the other

  ┌─ UI (browser) ────────────────────────────────────────────┐
  │  fetch('/api/...')  ── plaintext HTTP (localhost dev)      │
  └───────────────────────────┬────────────────────────────────┘
                              │  ★ NO TLS: same-machine dev loop ★
  ┌─ Service (Node/Vite) ─────▼────────────────────────────────┐
  │  SDK ── HTTPS to provider                                  │
  └───────────────────────────┬────────────────────────────────┘
                              │  ★ TLS 1.2/1.3: SDK + Node trust store ★
  ┌─ Provider (external) ─────▼────────────────────────────────┐
  │  api.anthropic.com / api.openai.com (presents a cert)      │
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — narrow to the concept

TLS answers two questions at once: *is the channel encrypted?* and *am I really talking to who I think I am?* In AptKit only connection 2 (Node↔provider) runs TLS, and the repo configures none of it — the SDK negotiates the handshake and Node's default CA trust store validates the provider's certificate. Connection 1 (browser↔Node) is plaintext HTTP because it's a same-machine dev loop where there's nothing to encrypt against. So "trust establishment" here is two short stories: one delegated, one deliberately absent.

## The structure pass

**Layers.** Connection 1 (plaintext — no TLS layer at all). Connection 2 (TLS layer present, owned by SDK + Node).

**Axis — trust (am I sure of the peer's identity, and is the channel private?).**

```
  One axis (trust) across the two connections

  connection 1 (browser↔Node):
    identity: implicit (same machine)   channel: plaintext
    → trust comes from "it's localhost", not from crypto

  connection 2 (Node↔provider):
    identity: provider cert vs CA store  channel: encrypted
    → trust comes from the TLS handshake the SDK runs
```

The trust mechanism flips completely: connection 1 trusts by *locality* (it's the same box), connection 2 trusts by *cryptography* (a certificate chain to a root CA). Neither is repo code — but the *reason* each is acceptable is the lesson.

**Seams.** Connection 2's seam is the TLS handshake inside the SDK — the point where the provider's certificate is validated against Node's trust store. The repo could intercept it (custom CA, cert pinning, `rejectUnauthorized`) only by injecting a configured HTTP agent into the SDK client, which it never does. Connection 1 has no TLS seam at all; the seam there is "is this localhost?" — and in dev, it always is.

## How it works

### Move 1 — the mental model

You know how your browser shows a padlock and you trust the site because its certificate chains up to a root CA your OS already trusts? Connection 2 is exactly that, run by Node instead of a browser. The SDK opens the socket, the provider presents a cert, Node checks it against the same kind of trust store your OS ships, and only then does any HTTP flow. The pattern: *encrypt the pipe, then prove the peer's identity with a certificate chain, before sending the secret (your API key)*.

```
  The TLS handshake shape (connection 2)

  client (SDK)                          provider
     │  1. ClientHello (TLS versions) ──►│
     │◄─ 2. ServerHello + certificate ───│
     │  3. validate cert vs CA store     │   ← Node's default trust store
     │  4. key exchange ────────────────►│
     │◄═════ encrypted channel ═════════►│
     │  5. NOW send HTTPS request         │   ← API key rides inside the
     │     (Authorization: Bearer …)      │     encrypted channel
```

### Move 2 — walking trust on each connection

**Connection 2: the SDK negotiates, Node validates.** When `client.chat.completions.create` opens its socket, the SDK initiates a TLS handshake. The provider sends its certificate. Node's TLS stack checks the cert chains to a trusted root CA (the default bundle Node ships) and that the hostname matches. If validation fails, the handshake aborts and `complete()` throws — which the fallback chain treats like any other failure. The repo writes none of this; it only set `apiKey`, which becomes the `Authorization` header *inside* the now-encrypted channel.

```
  Connection 2 trust — delegated handshake, then the key flows

  ┌─ Service (Node) ─┐  TLS handshake (SDK)   ┌─ Provider ─┐
  │ SDK opens socket │ ═══════════════════════►│ cert       │
  │ Node validates   │ ◄══════════════════════ │            │
  │ cert vs CA store │                          │            │
  │ key in encrypted │ ═══ Bearer apiKey ══════►│            │
  └──────────────────┘   (only after handshake) └────────────┘
```

**Connection 1: no TLS, and that's correct in dev.** The browser fetches `http://localhost:4187/...` (plaintext). There's no certificate, no handshake, no encryption. Why is that fine? Because both endpoints are the same machine — the bytes never leave the host, so there's no network to eavesdrop on. The boundary condition: this is *only* acceptable in dev. A deployed Studio would need HTTPS on connection 1 (TLS termination at a proxy or the server), which is `not yet exercised` because Studio is a dev tool.

```
  Connection 1 trust — locality, not crypto

  ┌─ browser ─┐   plaintext HTTP    ┌─ Node ────┐
  │ localhost │ ───────────────────►│ localhost │
  └───────────┘   (same machine)    └───────────┘
        trust = "the bytes never leave this box"
        NOT a deployable posture — dev only
```

**What the repo never does — and when it would.** No cert pinning, no custom CA, no mTLS, no `rejectUnauthorized: false`. Each of these would require injecting an HTTP agent into the SDK client via the `options.client` escape hatch. They'd become relevant behind a corporate TLS-inspecting proxy (custom CA) or for a high-security self-hosted gateway (mTLS). AptKit has none of those requirements.

### Move 3 — the principle

Trust establishment is the sharpest "different boundary, different rules" lesson in the guide. The *same repo* talks plaintext on one connection and full TLS on the other, and both are correct — because the trust comes from a different source on each. Locality justifies connection 1; cryptography justifies connection 2. The principle: match the trust mechanism to the threat model of the specific hop, not to a blanket "always encrypt" rule. (And know exactly when locality stops being enough — the moment the bytes leave the machine.)

## Primary diagram

Both connections, the trust source for each, the API key's path.

```
  AptKit trust — one TLS hop, one plaintext hop

  ┌─ UI (browser) ─────────────────────────────────────────────┐
  │  fetch http://localhost:4187  ── PLAINTEXT                  │
  │     trust source: same machine (dev only)                  │
  └───────────────────────────┬────────────────────────────────┘
                              │ connection 1: NO TLS
  ┌─ Service (Node) ──────────▼────────────────────────────────┐
  │  SDK TLS handshake → validate cert vs Node CA store        │
  │  API key sent as Bearer INSIDE the encrypted channel       │
  └───────────────────────────┬────────────────────────────────┘
                              │ connection 2: TLS 1.2/1.3 (SDK-owned)
  ┌─ Provider ────────────────▼────────────────────────────────┐
  │  presents certificate; operates the endpoint               │
  └──────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** TLS is established on every non-fixture provider call. The only repo input to it is the API key (which TLS protects, not configures).

**The API key is the repo's entire TLS-adjacent input.** `packages/providers/anthropic/src/anthropic-provider.ts:25`:

```
  anthropic-provider.ts  (constructor, line 25)

  this.client = options.client
    ?? new Anthropic({ apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY });
       │
       └─ apiKey is the ONLY security input the repo provides; the SDK turns it
          into an Authorization header sent INSIDE the TLS channel it negotiates.
          No agent, no CA, no cert config → Node's default trust store validates
          the provider cert
```

The key comes from `process.env`, populated from a gitignored `.env` (per project context). It never appears in repo source — which matters precisely because TLS is what keeps it private on the wire. (Whether the key is *handled* safely is a study-security question; this file only notes that TLS is what protects it in transit.)

**Connection 1 is plaintext by virtue of the dev server.** `apps/studio/src/api.ts:126` fetches a relative `/api/...` URL against an `http://localhost:4187` origin (`playwright.studio.config.ts:10`). No `https://` anywhere in the client. The Vite dev server serves plain HTTP.

## Elaborate

The "API key inside the TLS channel" detail is worth internalizing: the key is a bearer credential, so anyone who can read it gets full account access. The *only* thing keeping it private on connection 2 is the TLS encryption the SDK negotiated — if that channel were plaintext (or if cert validation were disabled with `rejectUnauthorized: false`), the key would be sniffable. This is why the absent custom-TLS config is actually a *good* default: the repo can't accidentally weaken cert validation because it never touches it. Where your AdvntrCue experience maps in: that app's GPT-4 calls run the identical delegated-TLS pattern from a serverless function — same SDK, same trust store, same "key inside the channel". The pattern transfers wholesale; only the runtime (serverless vs dev server) differs.

## Interview defense

**Q: Where does TLS happen and who configures it?**

```
  connection 2 only: SDK negotiates, Node CA store validates, repo sets apiKey
```

Only on connection 2 (Node↔provider). The SDK negotiates the handshake; Node's default CA trust store validates the provider's certificate; the repo configures none of it beyond supplying the API key, which rides inside the encrypted channel as a bearer header. Connection 1 is plaintext localhost — fine in dev, not deployable. **Anchor:** the API key's privacy depends entirely on the SDK's TLS, which the repo can't accidentally weaken because it never configures it.

**Q: When would you need to touch TLS config?**

Behind a TLS-inspecting corporate proxy (inject a custom CA via an HTTP agent into the SDK client) or for mTLS to a self-hosted gateway. Both go through the `options.client` injection seam. **Anchor:** `not yet exercised` — no such requirement exists.

## Validate

1. **Reconstruct:** Draw the connection-2 handshake; mark where the API key first flows.
2. **Explain:** Why is plaintext acceptable on connection 1 but not connection 2? (Locality vs cross-network — same machine has no eavesdrop surface.)
3. **Apply:** A security review asks "can the API key be sniffed?" What's the answer and what protects it? (No, on connection 2 — TLS the SDK negotiates; the repo never disables cert validation.)
4. **Defend:** Why is having no TLS config a good default? (Can't accidentally weaken cert validation; SDK + Node defaults are correct; no requirement to override.)

## See also

- `03-tcp-udp-connections-and-sockets.md` — the socket TLS wraps
- `05-http-semantics-caching-and-cors.md` — what flows inside the encrypted channel
- `02-dns-routing-and-addressing.md` — the `options.client` seam for custom TLS
- study-security — whether the API-key trust boundary is actually safe
