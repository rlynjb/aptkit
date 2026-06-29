# TLS and Trust Establishment

**Encryption in transit · certificates · termination points** — *Industry standard*

## Zoom out — where TLS would live

TLS sits between TCP and HTTP: open the socket, then negotiate a cipher and verify a certificate before any application byte moves. In aptkit's hot path that layer is simply *not there* — the scheme is `http:`, not `https:`. Here's where it would sit, marked absent.

```
  Zoom out — the TLS layer, absent in the hot path

  ┌─ aptkit transport ─────────────────────────────────────────┐
  │  fetch('http://localhost:11434/api/chat')   ← plain http:    │ ← we are here
  └──────────────────────────┬─────────────────────────────────┘
                             │  ┌─────────────────────────────┐
                             │  │  [ TLS handshake ]           │  ← NOT present
                             │  │  cert verify · cipher · ALPN │     (http, loopback)
                             │  └─────────────────────────────┘
  ┌─ OS TCP / loopback ───────▼─────────────────────────────────┐
  │  plaintext bytes on the loopback interface                  │
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

**TLS** encrypts a connection and proves the server is who it claims to be, via a **certificate** signed by a trusted authority; **trust establishment** is that proof step; the **termination point** is where the encrypted tunnel ends and plaintext begins. The question here: does aptkit encrypt anything on the wire, and does it verify any identity? Verdict: in the local path, no — and that's correct for loopback. The TLS that *does* exist in the system is owned by code that isn't aptkit.

## Structure pass — the skeleton

**Layers:** scheme choice → handshake → cert verification → termination. aptkit's local path stops at the scheme (`http:`) and the rest never happen.

**Axis traced — "is this byte encrypted?"**

```
  One question across the system: "is this byte encrypted?"

  ┌────────────────────────────────────────────┐
  │ aptkit → Ollama (localhost:11434)           │  → NO  (plain http, loopback)
  └────────────────────────────────────────────┘
  ┌────────────────────────────────────────────┐
  │ Anthropic/OpenAI SDK → api.*.com            │  → YES (TLS, but SDK-owned)
  └────────────────────────────────────────────┘
  ┌────────────────────────────────────────────┐
  │ browser → GitHub Pages (Studio assets)      │  → YES (HTTPS, browser-owned)
  └────────────────────────────────────────────┘
  ┌────────────────────────────────────────────┐
  │ buffr pg.Pool → Supabase                    │  → SSL available, configured in buffr
  └────────────────────────────────────────────┘

  encryption exists in the system — just never in code aptkit wrote
```

**Seam — the `http:` vs `https:` scheme in the host string.** The trust boundary is decided by one character in `'http://localhost:11434'`. Loopback makes `http` safe; an off-box host would make it a real exposure, and aptkit has no TLS handling to add.

## How it works

### Move 1 — the mental model

You know how a browser shows a padlock for `https://` and a "not secure" warning for `http://`? aptkit's local wire is the "not secure" case *on purpose* — there's no one to eavesdrop on a loopback socket that never leaves the machine. The shape:

```
  The no-TLS-on-loopback pattern

   scheme = 'http://'  ──► no handshake ──► no cert ──► plaintext on loopback
        │                                                    │
        │                                              safe BECAUSE the bytes
        │                                              never touch a network
        │
        └─ if scheme were 'https://' to a remote host:
             handshake → verify cert against CA store → encrypted tunnel
             (aptkit has NO code for this path)
```

### Move 2 — walking it

**The scheme is plain `http` — no TLS negotiated.** The host default is `http://localhost:11434` (`gemma-provider.ts:48`, `ollama-embedding-provider.ts:47`). `fetch` against an `http:` URL opens a raw TCP socket and speaks HTTP directly — no `ClientHello`, no cipher negotiation, no certificate. Concretely: anyone with packet-capture on the loopback interface of *that machine* could read the prompts and embeddings in cleartext. On a single-user laptop, that "anyone" is already you — so the exposure is zero. The local Ollama daemon also has no key and no cert (it's a localhost service), so there's nothing to verify even if you wanted to.

**No certificate verification, no pinning, no custom CA.** There's no `tls`, no `https.Agent`, no `rejectUnauthorized`, no `ca` bundle anywhere in the transports. Because the scheme is `http`, the entire trust-establishment step is skipped — there's no identity to prove for a loopback service.

**The TLS that exists belongs to other code.** Three encrypted wires touch this system, none written by aptkit:
- **Cloud SDKs:** `AnthropicModelProvider` / `OpenAIModelProvider` call `api.anthropic.com` / `api.openai.com` over HTTPS, but the vendor SDK negotiates TLS and verifies certs against the system CA store. aptkit just passes a request object in. This path isn't on the local default.
- **GitHub Pages:** Studio's production build is served over HTTPS from Pages (`deploy-studio-pages.yml`). The *browser* establishes that TLS, not aptkit code — aptkit just produced static files.
- **buffr → Supabase:** the Postgres wire can run over SSL, configured in buffr (`buffr/src/db.ts`), not aptkit. Supabase enforces TLS on its connection string; that's a buffr concern.

```
  Layers-and-hops — where TLS terminates, per wire

  aptkit code ──http──► localhost Ollama          (no TLS, terminates nowhere)
  vendor SDK ──TLS───► api.*.com edge             (terminates at vendor)   [not default path]
  browser ────TLS───► GitHub Pages CDN            (terminates at GH edge)  [browser-owned]
  buffr pg ───SSL───► Supabase                    (terminates at Supabase) [other repo]
```

### Move 3 — the principle

TLS is non-negotiable the moment a byte crosses a network you don't control — and exactly *negotiable* when it doesn't. aptkit's local wire never leaves the host, so plain HTTP is the honest, correct choice; adding TLS to loopback would be cargo-culting. The trap is the `host` override: point it at a remote Ollama and you've silently turned a safe `http` into an exposed one, with no code to encrypt it. The principle: the scheme must match the threat model of the *actual* destination, and a configurable host means the threat model can change without the code noticing.

## Primary diagram

The full trust picture: aptkit's plaintext loopback vs the TLS owned elsewhere.

```
  aptkit trust map — plaintext where aptkit owns the wire

  ┌─ aptkit-owned wire ────────────────────────────────────────┐
  │  http://localhost:11434   →  NO TLS, NO cert, plaintext     │
  │  safe: loopback, never on a network                         │
  │  risk: host override → remote http → silent exposure        │
  └──────────────────────────────────────────────────────────────┘

  ┌─ TLS that exists, owned by NON-aptkit code ────────────────┐
  │  vendor SDK → api.*.com      TLS (SDK verifies cert)        │
  │  browser    → GitHub Pages   HTTPS (browser verifies cert)  │
  │  buffr pg   → Supabase       SSL (buffr config)             │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The reason TLS feels mandatory everywhere is that most production traffic crosses untrusted networks — public internet, shared datacenter fabric, the open office wifi. Loopback is the one place that assumption breaks: the kernel routes the packet from one process to another on the same box, never serializing it onto a NIC. aptkit leans on that hard, the same way contrl leans on keeping ML on-device — avoid the network and you avoid its whole threat surface. When buffr or a future deployment puts Ollama on another machine, this file flips from `not yet exercised` to "you now need an `https` Ollama or a TLS-terminating proxy in front of it." For *whether* the current setup is safe, see **study-security**; this guide only establishes *what's encrypted on the wire*.

## Interview defense

**Q: How do you handle TLS / certificate verification?**
In the local path I don't — the wire is plain `http` to a loopback Ollama, so there's no network to encrypt and no identity to verify. That's deliberate for a same-machine dependency. The TLS in the system belongs to other layers: the cloud SDKs verify their own certs, the browser handles GitHub Pages HTTPS, and buffr configures SSL to Supabase.

```
  http://localhost → no TLS (loopback, safe)
  the override knob: remote host over http → exposed, no code to encrypt it
```
Anchor: *"plaintext on loopback is correct; the risk is a host override turning it into plaintext-on-a-network."*

**Q: What would you change to put Ollama on another machine?**
Point `host` at an `https://` Ollama behind a TLS-terminating proxy, or run a mutual-TLS tunnel — and add the timeout I'm missing, because a remote host turns a stall into a network-latency hang.

## See also

- `03-tcp-udp-connections-and-sockets.md` — the TCP socket TLS would wrap
- `02-dns-routing-and-addressing.md` — why loopback removes the TLS need
- `05-http-semantics-caching-and-cors.md` — the HTTP that rides (un-encrypted) on top
- `00-overview.md` — TLS listed under `not yet exercised`
