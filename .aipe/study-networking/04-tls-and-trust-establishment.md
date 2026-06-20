# 04 — TLS and trust establishment

**Industry name(s):** TLS / encryption in transit / certificate trust. **Type:** Industry standard.

## Zoom out — where this concept lives

TLS sits between the TCP socket (file `03`) and HTTP (file `05`) — it's the encryption wrapper around the byte pipe. Here's which of AptKit's connections is wrapped and which is bare.

```
  Zoom out — TLS on one connection, plaintext on two

  ┌─ UI (browser) ────────────────────────────────────────────┐
  │  fetch('/api/...')  ── plaintext HTTP (localhost dev)      │
  └───────────────────────────┬────────────────────────────────┘
                              │  ★ CONN 1: NO TLS — same-machine dev loop ★
  ┌─ Service (Node/Vite) ─────▼────────────────────────────────┐
  │  SDK ── HTTPS to cloud provider                            │
  │  fetch ── plaintext HTTP to local Ollama                   │
  └────────────┬────────────────────────────┬──────────────────┘
               │ ★ CONN 2: TLS ★            │ ★ CONN 3: NO TLS ★
               │ SDK + Node trust store      │ plaintext, no auth
  ┌─ Cloud ────▼─────────────┐  ┌─ Local Ollama ──▼────────────┐
  │ api.* (presents a cert)  │  │ localhost:11434 (no cert)    │
  └──────────────────────────┘  └──────────────────────────────┘
```

## Zoom in — narrow to the concept

TLS answers two questions at once: *is the channel encrypted?* and *am I really talking to who I think I am?* In AptKit only connection 2 (Node↔cloud provider) runs TLS, and the repo configures none of it — the SDK negotiates the handshake and Node's default CA trust store validates the provider's certificate. Connection 1 (browser↔Node) and connection 3 (Node↔local Ollama) are both plaintext HTTP because both are same-machine where there's nothing to encrypt against. So "trust establishment" here is three short stories: one delegated TLS (conn 2), and two deliberately-absent (conn 1, conn 3) — and conn 3 is the interesting new one, because it carries *no auth at all* across a process boundary.

## The structure pass

**Layers.** Connection 1 (plaintext, same process tree). Connection 2 (TLS layer present, owned by SDK + Node). Connection 3 (plaintext, cross-process to the Ollama daemon).

**Axis — trust (am I sure of the peer's identity, and is the channel private?).**

```
  One axis (trust) across the three connections

  connection 1 (browser↔Node):
    identity: implicit (same machine)   channel: plaintext
    → trust comes from "it's localhost", not from crypto

  connection 2 (Node↔cloud):
    identity: provider cert vs CA store  channel: encrypted
    → trust comes from the TLS handshake the SDK runs

  connection 3 (Node↔local Ollama):
    identity: NONE (any local caller)    channel: plaintext
    → trust comes from "the port is only reachable on this box"
```

The trust mechanism flips across all three: conn 1 and conn 3 trust by *locality* (same box), conn 2 trusts by *cryptography* (a certificate chain to a root CA). Conn 3 is the sharpest case — it sends a model request with *no bearer key* and reads a response with *no cert check*, accepting both because Ollama binds to `localhost` and anything that reached the port is already on the trusted machine. The *reason* each is acceptable is the lesson; conn 2 is the only one where "acceptable" rests on math instead of geography.

**Seams.** Connection 2's seam is the TLS handshake inside the SDK — the point where the provider's certificate is validated against Node's trust store. The repo could intercept it (custom CA, cert pinning, `rejectUnauthorized`) only by injecting a configured HTTP agent into the SDK client, which it never does. Connection 1 has no TLS seam at all. Connection 3's seam is the injectable transport (`GemmaChatTransport`, `gemma-provider.ts:19`; `EmbedTransport`, `ollama-embedding-provider.ts:18`) — that's where a future deployment *could* swap the plaintext `fetch` for an HTTPS+keyed one if Ollama ever moved off-host, without touching the provider's logic.

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

**Connection 3: no TLS, no key, cross-process — and correct *only* on localhost.** When `GemmaModelProvider.complete` calls its default transport, it `fetch`es `http://localhost:11434/api/chat` with a `content-type: application/json` header and *nothing else* — no `Authorization`, no cert validation, no handshake (`gemma-provider.ts:204-209`). The Ollama daemon answers any caller that opened its port. Why is that acceptable? Because Ollama binds to loopback, so "reached the port" already means "runs on this machine." The boundary condition — and it's a real one — is that this is correct *only* while Ollama stays local. The day someone points `host` at a remote inference box (`http://gpu-box.internal:11434`), this connection sends model prompts unauthenticated over plaintext across a real network, which is a credential-and-data exposure. The fix isn't a code change to the provider — it's swapping the injectable transport for an HTTPS+keyed one. That's why the transport is injectable in the first place.

```
  Connection 3 trust — locality, cross-process, no auth

  ┌─ Node (provider) ─┐  plaintext HTTP   ┌─ Ollama daemon ─┐
  │ fetch /api/chat   │ ─────────────────►│ localhost:11434  │
  │ no Authorization  │  (same machine)   │ trusts any local │
  │ no cert check     │ ◄─────────────────│ caller           │
  └───────────────────┘                   └──────────────────┘
        trust = "the port is only reachable on this box"
        SAFE on localhost · UNSAFE the moment host points off-box
```

**What the repo never does — and when it would.** On conn 2: no cert pinning, no custom CA, no mTLS, no `rejectUnauthorized: false` — each would require injecting an HTTP agent into the SDK client via `options.client`. On conn 3: no key, no TLS — each would require swapping the injectable transport. Conn 2's extras become relevant behind a corporate TLS-inspecting proxy or a self-hosted gateway; conn 3's become *mandatory* the moment Ollama moves off-host. AptKit has neither requirement today, so both are `not yet exercised`.

### Move 3 — the principle

Trust establishment is the sharpest "different boundary, different rules" lesson in the guide. The *same repo* talks plaintext on two connections and full TLS on the third, and all three are correct — because the trust comes from a different source on each. Locality justifies connections 1 and 3; cryptography justifies connection 2. The principle: match the trust mechanism to the threat model of the specific hop, not to a blanket "always encrypt" rule. (And know exactly when locality stops being enough — the moment the bytes leave the machine. Conn 3 is the one to watch: its safety is a deployment assumption — `localhost` — not a property of the code, so a single config change can invalidate it silently.)

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
2. **Explain:** Why is plaintext acceptable on connections 1 and 3 but not 2? (Locality vs cross-network — same machine has no eavesdrop surface; conn 2 crosses the open internet.)
3. **Apply:** A security review asks "can the API key be sniffed?" What's the answer and what protects it? (No, on connection 2 — TLS the SDK negotiates; the repo never disables cert validation.)
4. **Defend:** Connection 3 sends prompts with no key over plaintext — defend it, then name the one change that breaks the defense. (Defensible only while Ollama is `localhost` — bytes never leave the box; pointing `host` off-machine — `gemma-provider.ts:48` — sends unauthenticated prompts over a real network. Fix via the injectable transport, not the provider.)

## See also

- `03-tcp-udp-connections-and-sockets.md` — the socket TLS wraps (and conn 3's bare socket)
- `05-http-semantics-caching-and-cors.md` — what flows inside the encrypted channel
- `02-dns-routing-and-addressing.md` — the `options.client` seam for custom TLS; conn 3's `host` option
- `08-networking-red-flags-audit.md` — conn 3's off-host exposure ranked among the risks
- study-security — whether the API-key trust boundary (and conn 3's keyless one) is actually safe
