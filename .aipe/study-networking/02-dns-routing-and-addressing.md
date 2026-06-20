# 02 — DNS, routing, and addressing

**Industry name(s):** name resolution / address resolution / origin routing. **Type:** Industry standard.

## Zoom out — where this concept lives

Names and addresses are the very first thing that happens on any network hop, below everything else in this guide. Here's where resolution sits relative to AptKit's two boundaries.

```
  Zoom out — resolution sits below both boundaries

  ┌─ UI (browser) ────────────────────────────────────────────┐
  │  fetch('/api/stream/replay')  ← relative URL, no hostname  │
  └───────────────────────────┬────────────────────────────────┘
                              │  resolves to: same origin (localhost:4187)
  ┌─ Service (Node/Vite) ─────▼────────────────────────────────┐
  │  ★ DNS happens here, inside the SDK ★                       │
  │  client.chat.completions.create → resolves api.openai.com  │
  └───────────────────────────┬────────────────────────────────┘
                              │  hostname → IP (OS resolver + SDK)
  ┌─ Provider (external) ─────▼────────────────────────────────┐
  │  api.anthropic.com / api.openai.com                        │
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — narrow to the concept

DNS answers "what IP do I open a socket to?" In AptKit there are now three addresses, and the repo writes a real hostname for exactly one of them. The browser uses a relative URL (no hostname — it inherits the page's origin). The cloud provider hostname is resolved inside the SDK by Node's default resolver. The *new* one: the repo's own Gemma/Ollama transports name `http://localhost:11434` explicitly (`gemma-provider.ts:48`, `ollama-embedding-provider.ts:47`) — but `localhost` resolves to the loopback `127.0.0.1` with no real DNS query, so even this hand-written hostname touches no resolver. So this concept stays almost entirely `not yet exercised` at the resolver level — but the repo now *does* write an addressable host string, which is the change worth noting.

## The structure pass

**Layers.** Browser address resolution (relative URL), Node-side address resolution (SDK + OS resolver), provider address (a public DNS name someone else operates).

**Axis — control (who decides the address?).**

```
  One axis (control of addressing) down the stack

  ┌─ browser ──────┐   → the PAGE decides (relative URL = same origin)
  ┌─ Node/SDK ─────┐   → the SDK decides (default base URL constant)
  ┌─ provider ─────┐   → the PROVIDER decides (they run the DNS record)
```

Control of the address flips at every layer, and crucially *no layer is the repo's own code making a routing decision*. The browser inherits the origin from the dev server it was served by; the SDK hardcodes its base URL (`api.openai.com`); the provider operates the DNS zone. The repo never writes a hostname.

**Seams.** The load-bearing seam is the SDK boundary: it's where a logical name (`api.openai.com`) becomes a concrete socket address, and it's entirely behind the SDK. If you ever needed to point the SDK at a proxy or a self-hosted gateway, *this* is the seam you'd intercept — by passing `baseURL` to the client constructor, which the repo currently does not.

## How it works

### Move 1 — the mental model

You know how a relative `fetch('/api/foo')` in a React app "just works" without you typing the domain? The browser fills in the origin of whatever page it's running on. Provider DNS is the same idea one layer down: the SDK fills in `api.openai.com` and Node's resolver turns it into an IP. The pattern is *somebody else supplies the address; you supply only the path or the intent*.

```
  The resolution shape — name to address, owned by a layer below you

   logical name              resolver               socket address
  "api.openai.com"  ──────►  OS / SDK   ──────►  104.x.x.x:443
   (SDK constant)            (cached)            (TLS connects here)

   "/api/stream/replay" ──► browser origin ──► 127.0.0.1:4187
   (relative URL)           (the served page)
```

### Move 2 — walking each resolution

**The browser's address: a relative URL inherits the origin.** Every Studio `fetch` call uses a leading-slash path — `'/api/stream/replay'`, `'/api/model-status'`. There's no `http://` and no hostname. The browser resolves this against the origin of the page, which Vite served from the dev server. The boundary condition: this is *why* there's no CORS — same origin means the browser never does a cross-origin preflight (file `05`).

```
  Browser resolution — relative path → page origin

  page served from http://localhost:4187
       │
  fetch('/api/stream/replay')
       │  browser prepends the page origin
       ▼
  http://localhost:4187/api/stream/replay   ← same origin, no DNS lookup of
                                               a remote host needed
```

**The provider's address: the SDK owns it, the OS resolves it.** When `client.chat.completions.create` runs, the SDK already knows its base URL is `api.openai.com` (a default baked into the OpenAI client; same for Anthropic's `api.anthropic.com`). It hands that hostname to Node's networking stack, which calls the OS resolver (`getaddrinfo`), which returns an IP, possibly from a cache. None of this surfaces in repo code.

```
  Provider resolution — entirely below the repo

  repo code: client.chat.completions.create(...)
       │
       ▼  (inside SDK)
  base URL = "api.openai.com"
       │
       ▼  (inside Node)
  OS resolver: api.openai.com → 104.x.x.x   ← cached per OS/TTL
       │
       ▼
  TLS socket opens to that IP:443
```

**What the repo would have to do to participate.** If it ever needed to route through a proxy or self-hosted gateway, it'd pass `baseURL` into the SDK constructor — `new OpenAI({ apiKey, baseURL })`. The constructor in `openai-provider.ts:30` passes only `apiKey`. That single absent argument is the entire reason addressing is delegated.

### Move 3 — the principle

Addressing is the cleanest example in this whole guide of *delegation as a design choice*. The repo wrote no hostname because the SDK is a better place to own it — base URLs change, regional endpoints get added, the SDK ships those updates. The principle: own the *intent* (which provider, what request), delegate the *address*. You only pull addressing back in-house when you have a routing requirement the SDK can't express, and AptKit doesn't.

## Primary diagram

Both resolutions in one frame, neither owned by repo code.

```
  AptKit addressing — two names, zero repo-owned hostnames

  ┌─ UI ──────────────────────────────────────────────────────┐
  │  fetch('/api/...')  ──► browser prepends page origin       │
  │                          → localhost:4187 (same origin)    │
  └────────────────────────────────────────────────────────────┘
  ┌─ Service / SDK ───────────────────────────────────────────┐
  │  client constructed with apiKey only (no baseURL)          │
  │     │  SDK supplies "api.openai.com" / "api.anthropic.com" │
  │     ▼  Node OS resolver: name → IP (cached, TTL)           │
  └────────────────────────────────────────────────────────────┘
  ┌─ Provider ────────────────────────────────────────────────┐
  │  provider operates the DNS zone + the endpoint             │
  └────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Addressing is reached for implicitly on every provider call and every Studio fetch. The only place the repo could insert itself — the client constructor — deliberately doesn't.

**The provider client constructors take no `baseURL`.** `packages/providers/openai/src/openai-provider.ts:28-31` and `packages/providers/anthropic/src/anthropic-provider.ts:23-26`:

```
  openai-provider.ts  (constructor, lines 28–31)

  this.client = options.client                 ← caller can inject a client…
    ?? new OpenAI({ apiKey: options.apiKey      ← …otherwise: apiKey only
        ?? process.env.OPENAI_API_KEY });       ← NO baseURL → SDK default host
       │
       └─ the absent baseURL is the whole addressing story: the SDK's default
          (api.openai.com) wins, resolved by the OS; the repo never names a host
```

Note the `options.client` escape hatch — a caller *could* inject a pre-configured client with a custom `baseURL`, which is the seam for routing through a proxy. The repo never uses it, but it's there.

**The local provider names its host explicitly — and exposes it as a `host` option.** Unlike the cloud providers, the Gemma/Ollama transports write the address themselves. `packages/providers/gemma/src/gemma-provider.ts:48`:

```
  gemma-provider.ts  (constructor, line 48)

  this.chat = options.chat
    ?? defaultHttpTransport(options.host ?? 'http://localhost:11434');
       │
       └─ the repo writes a real host string here (the only one in the codebase),
          but `localhost` → 127.0.0.1 loopback, so no resolver runs. `host` is the
          addressing seam: pass a different value and you re-point boundary 3 —
          which is also where the off-host TLS/auth risk enters (see 04/08 R8)
```

The embedder mirrors this (`ollama-embedding-provider.ts:47`). So addressing is *authored* on boundary 3 but still doesn't exercise DNS — loopback is resolver-free.

**The browser uses relative URLs.** `apps/studio/src/api.ts:11` (`fetch('/api/model-status')`), `:126` (`fetch(endpoint, ...)` where `endpoint` is `/api/stream/replay`). Leading slash = same-origin, no remote hostname.

## Elaborate

DNS is where a lot of production incidents actually originate — a stale cache, a slow resolver, a TTL that's too long after a provider fails over. AptKit is insulated from all of it precisely *because* it delegates: the SDK and OS handle resolution and caching, and a single-user dev tool never generates the resolver pressure that exposes those bugs. The flip side — and this is the honest cost — is that if a provider's DNS misbehaves, the repo has no hook to observe or override it; the failure surfaces only as a thrown error inside `complete()`, which the fallback chain then treats like any other failure (file `07`). For the scale AptKit operates at, that's the correct trade.

## Interview defense

**Q: How does AptKit resolve the model API hostname?**

```
  client (no baseURL) ─► SDK default "api.openai.com" ─► OS resolver ─► IP
```

It doesn't — the SDK does. The client is constructed with `apiKey` only (`openai-provider.ts:30`), so the SDK's default base URL wins and Node's OS resolver turns it into an IP, cached by TTL. **Anchor:** the absent `baseURL` argument is the entire addressing decision.

**Q: How would you point it at a proxy or self-hosted gateway?**

Pass `baseURL` into the client constructor, or inject a pre-built client via the `options.client` escape hatch (`openai-provider.ts:28`). That's the seam where addressing would come back in-house. **Anchor:** the injection point already exists; the repo just doesn't use it.

## Validate

1. **Reconstruct:** Name the two addresses in the system and who resolves each.
2. **Explain:** Why is there no CORS in Studio? (Relative URLs → same origin → no cross-origin request — `api.ts:11,126`.)
3. **Apply:** You need all provider traffic to go through `https://gateway.internal`. What's the one-line change and where? (`baseURL` in the `new OpenAI({...})` call — `openai-provider.ts:30`.)
4. **Defend:** Why is delegating DNS the right call here? (No routing requirement; the SDK owns endpoint updates; a dev tool never hits resolver-pressure bugs.)

## See also

- `04-tls-and-trust-establishment.md` — what happens to the resolved address (TLS connect)
- `05-http-semantics-caching-and-cors.md` — why same-origin means no CORS
- `07-timeouts-retries-pooling-and-backpressure.md` — what happens when resolution/connection fails
