# DNS, Routing, and Addressing

**Name resolution · host addressing · edge & proxy layers** — *Industry standard*

## Zoom out — where addressing lives

Every `fetch` has to answer one question before a single byte moves: *what machine, at what address?* In AdvntrCue that meant a hostname (`api.openai.com`) that DNS turned into an IP, routed across the internet. aptkit answers that question with a constant string — `localhost` — and the answer never leaves the box. Here's where addressing sits.

```
  Zoom out — addressing in the provider layer

  ┌─ Provider/adapter layer ──────────────────────────────────┐
  │  defaultHttpTransport(host)                                │
  │     host = 'http://localhost:11434'  ← ★ THE ADDRESS ★     │ ← we are here
  │     fetch(`${host}/api/chat`)                              │
  └──────────────────────────┬─────────────────────────────────┘
                             │  resolve "localhost" → 127.0.0.1 / ::1
  ┌─ OS resolver / loopback ─▼─────────────────────────────────┐
  │  no DNS server hit — /etc/hosts or built-in loopback        │
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

**DNS** maps a name to an address; **routing** picks the path to that address; **addressing** is the literal `host:port` a socket targets. The whole point of this topic is the journey from "I want to talk to *that service*" to "I have a socket to *this IP*." In aptkit that journey is trivial — and understanding *why* it's trivial is the lesson.

## Structure pass — the skeleton

**Layers:** application address string → OS resolver → routing → physical hop. aptkit only touches the first; the rest collapse because the target is loopback.

**Axis traced — "how far does the packet travel?"**

```
  One question across the addressing layers: "how far does it travel?"

  ┌────────────────────────────────────┐
  │ host = 'http://localhost:11434'     │  → application names the box
  └────────────────────────────────────┘
      ┌────────────────────────────────┐
      │ resolve 'localhost'             │  → 127.0.0.1 / ::1 (no DNS query)
      └────────────────────────────────┘
          ┌────────────────────────────┐
          │ route                        │  → loopback interface, 0 network hops
          └────────────────────────────┘
              ┌────────────────────────┐
              │ deliver to Ollama       │  → same machine, never on a NIC
              └────────────────────────┘

  the packet never leaves the host — every routing concern is N/A
```

**Seam — the `host` option.** `host` is a constructor option (`gemma-provider.ts:48`, `ollama-embedding-provider.ts:47`), defaulting to `http://localhost:11434`. That's the one knob that *could* point at a remote Ollama and turn this into a real DNS/routing problem. Today it doesn't.

## How it works

### Move 1 — the mental model

You know how `localhost` in a dev server "just works" with no DNS setup? Same primitive here. The address is a literal in the adapter, and `localhost` is special-cased by the OS to the loopback interface — no nameserver, no route table that matters.

```
  The loopback-address pattern

   host string ──► OS resolver ──► loopback ──► same process box
   'localhost'      special-cased    127.0.0.1     Ollama daemon
                    (no DNS query)    / ::1
        │
        └─ overridable: pass host:'http://10.0.0.5:11434' → real DNS/route
```

### Move 2 — walking it

**The address is a default string, normalized once.** Both transports take a `host` and strip a trailing slash before building the URL.

```ts
// packages/providers/gemma/src/gemma-provider.ts:48 + 201-202
this.chat = options.chat ?? defaultHttpTransport(options.host ?? 'http://localhost:11434');
// ...
const base = host.replace(/\/$/, '');     // 'http://localhost:11434' → same, no trailing /
const res = await fetch(`${base}/api/chat`, { ... });
```

`host` is `http://localhost:11434` unless a caller overrides it. The embedding provider mirrors this exactly (`ollama-embedding-provider.ts:47, 61`). There's no service-discovery, no environment-based host selection in aptkit itself — though buffr reads `OLLAMA_HOST` from env (`buffr/src/config.ts:14`, also defaulting to `http://localhost:11434`) and would pass it down.

**`localhost` resolution skips DNS.** When the OS sees `localhost`, it resolves to `127.0.0.1` (IPv4) or `::1` (IPv6) from `/etc/hosts` or a built-in rule — no UDP query to a nameserver on port 53. Concretely: if you unplug your network cable, these calls still work, because nothing is routed off the box. That's the defining consequence of loopback addressing.

**Port is fixed in the address.** `11434` is Ollama's default chat port, baked into the host string. There's no port discovery, no SRV record, no negotiation — the port is part of the constant.

**No proxy / edge layer in front.** There's no reverse proxy, CDN, or load balancer between aptkit and Ollama; the `fetch` hits the daemon directly. The only "edge" anywhere in the system is GitHub Pages serving Studio's static build (HTTPS, a real hostname, DNS resolved by the *browser* — not by aptkit code). That edge serves *assets*, not API traffic.

### Move 3 — the principle

When your target is loopback, DNS and routing aren't "simple" — they're *absent*, and that absence buys you determinism: no resolution latency, no DNS cache poisoning, no split-horizon surprises, no route flaps. The cost is the obvious one: it only works when the dependency is on the same machine. The moment `host` points off-box, every DNS and routing concern you skipped comes back at once — and aptkit has no code to handle them, because it never needed any.

## Primary diagram

The full addressing path, with the override that would change everything.

```
  aptkit addressing — loopback today, the one knob that changes it

  ┌─ aptkit code ──────────────────────────────────────────────┐
  │  options.host ?? 'http://localhost:11434'                   │
  │       │                                                     │
  │       ├── default ──► 'localhost' ──► loopback ──► 0 hops   │
  │       │                (no DNS, no NIC)                     │
  │       │                                                     │
  │       └── override ─► 'http://host.example:11434'           │
  │                        │                                     │
  │                        ▼  ← real DNS query (UDP :53)        │
  │                       resolve → IP → route → network hops   │
  │                       (no aptkit code handles this path)    │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

DNS, routing, edge layers, and proxies are a deep topic precisely because the internet is a hostile, lossy, multi-hop network. Loopback sidesteps all of it. aptkit's choice to keep the LLM dependency on `localhost` is the same instinct as contrl keeping ML in the hot path on-device: when you can avoid the network entirely, the hardest distributed-systems problems evaporate. The `host` override is the escape hatch for the day you want a shared Ollama box on a LAN — at which point this file stops being mostly `not yet exercised`.

## Interview defense

**Q: How does your system do service discovery / DNS?**
Honest answer: it doesn't need to. The only dependency is a local Ollama daemon at a constant `http://localhost:11434`, so there's no DNS query and no routing — it's the loopback interface. The host is an overridable constructor option, so pointing at a remote Ollama is a one-line change, but then I'd be taking on DNS resolution, routing, and TLS that the code doesn't currently handle.

```
  'localhost' → loopback → 0 network hops   (no nameserver touched)
       └── override host → real DNS/route (uncovered path)
```
Anchor: *"loopback by default; the host string is the only addressing knob."*

**Q: What breaks if DNS is slow?**
Nothing, today — there's no DNS in the path. If `host` pointed off-box, a slow resolver would block the `await fetch` with no timeout to bound it (see `07`), so a DNS stall would become an indefinite hang.

## See also

- `03-tcp-udp-connections-and-sockets.md` — what happens after the address resolves
- `04-tls-and-trust-establishment.md` — why loopback means no TLS
- `07-timeouts-retries-pooling-and-backpressure.md` — why an off-box host would hang
- `00-overview.md` — DNS listed under `not yet exercised`
