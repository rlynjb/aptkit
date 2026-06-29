# DNS, Routing, and Addressing

**Industry name:** name resolution / addressing / origin routing · *Industry standard*

## Zoom out, then zoom in

Before a byte can travel, the code has to answer "to which address?" Here's where that question gets asked in this system — and the surprise is how often the answer is "no lookup needed."

```
  Zoom out — where addressing happens

  ┌─ Service layer ────────────────────────────────────────────┐
  │  GemmaModelProvider                                        │
  │    host = 'http://localhost:11434'   ← ★ literal address ★ │
  │  OllamaEmbeddingProvider                                   │
  │    host = 'http://localhost:11434'   ← ★ literal address ★ │
  └───────────────────────────┬────────────────────────────────┘
                              │ resolves to 127.0.0.1 — loopback,
                              │ no DNS query leaves the machine
  ┌─ Provider layer ─────────▼─────────────────────────────────┐
  │  Anthropic/OpenAI SDK  →  api.anthropic.com / api.openai.com│
  │    DNS happens HERE, inside the SDK (not aptkit's code)     │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** DNS is the phonebook step: turn a human name (`api.openai.com`) into an IP the OS can route to. Routing and proxies decide the path those packets take. In aptkit, the foreground answer is `localhost` — a name the OS resolves to `127.0.0.1` without any network query — so the interesting DNS lives entirely inside dependencies. The pattern to learn: **the address is configuration, and where the address is a literal loopback, the whole resolution+routing+proxy stack collapses to nothing.**

## Structure pass

**Layers:** the address is decided in the Service layer (the provider constructors), used at the wire in the transport, and — for cloud — re-decided inside the Provider SDK.

**Axis — "who resolves the name, and does a query leave the box?"** Trace it:

```
  Axis — name resolution — across the addressing surfaces

  surface                     name              who resolves       query leaves box?
  ─────────────────────────────────────────────────────────────────────────────────
  Gemma / Ollama embed        localhost:11434   OS, instantly      NO (loopback)
  Anthropic SDK               api.anthropic.com SDK → OS → resolver YES (DNS over UDP/53)
  OpenAI SDK                  api.openai.com    SDK → OS → resolver YES
  buffr → Supabase            host in DATABASE_URL  pg → OS         YES
  Studio (Pages, prod)        <user>.github.io  browser → OS       YES (user side)
```

**Seam:** the boundary between "loopback literal" and "real hostname" is where DNS becomes real. aptkit's own code sits entirely on the loopback side; cross into a dependency and a resolver gets involved.

## How it works

#### Move 1 — the mental model

You've typed `localhost:3000` into a browser a thousand times and never thought about DNS — because there isn't any. `localhost` is a name the OS maps to `127.0.0.1` from a local file (`/etc/hosts`), instantly, with no packet sent. aptkit's two real sockets both target exactly that.

```
  The pattern — resolution as a fork

  name string
      │
      ├─ is it loopback/literal? ──► OS-local map ──► 127.0.0.1  (no query)
      │
      └─ is it a real hostname? ──► resolver ──► A/AAAA record ──► routable IP
                                    (UDP :53, cached, can fail/be slow)
```

The kernel of DNS: a name goes to a resolver, which returns an IP (an A record for IPv4, AAAA for IPv6), usually cached with a TTL. Strip the resolver and a real hostname can't be reached at all. Strip it for `localhost` and nothing changes — because that branch never runs.

#### Move 2 — walking the addressing in this repo

**Both Ollama clients hardcode the loopback host as a default.** The address is a constructor default you can override, but in practice it's `localhost:11434` (`packages/providers/gemma/src/gemma-provider.ts:48`, `packages/retrieval/src/ollama-embedding-provider.ts:47`):

```ts
// gemma-provider.ts:48
this.chat = options.chat ?? defaultHttpTransport(options.host ?? 'http://localhost:11434');
//                                                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
// ollama-embedding-provider.ts:47
options.embed ?? defaultHttpTransport(options.host ?? 'http://localhost:11434');
```

The `host` is a string, parsed by `fetch`'s URL handling. Because it's loopback, the OS short-circuits resolution — no DNS query, no resolver dependency, no routing across a network. That's why these calls have no DNS-failure mode: the only way `localhost` fails to resolve is a broken `/etc/hosts`.

**Cloud addressing is the SDK's secret.** `AnthropicModelProvider` and `OpenAIModelProvider` never name a host — they construct the vendor client and let it own the base URL, DNS, and routing (`packages/providers/anthropic/src/...:25`, `packages/providers/openai/src/openai-provider.ts:30`). So aptkit's code has *no* line where `api.anthropic.com` appears; the resolution is real but invisible to this repo.

```
  Layers-and-hops — addressing crosses into the SDK

  ┌─ aptkit ──────────────────┐  hop: complete()  ┌─ vendor SDK ───────────┐
  │  new Anthropic({ apiKey })│ ─────────────────►│ baseURL → DNS → TLS →  │
  │  (no host named)          │                   │ api.anthropic.com      │
  └───────────────────────────┘                   └────────────────────────┘
        addressing decided here is NONE; it's all on the SDK side
```

**buffr's address is a connection string.** `createPool(databaseUrl)` (`buffr/src/db.ts:4`) takes a full `DATABASE_URL` — host, port, db, credentials packed into one URI. The `pg` driver parses it and resolves the host. aptkit never sees this; it's buffr's boundary.

**Studio in production routes through GitHub Pages.** The deploy workflow (`.github/workflows/deploy-studio-pages.yml`) builds with `base: '/aptkit/'` (`apps/studio/vite.config.ts:196`) and ships the static bundle via `actions/deploy-pages@v4`. The origin routing — GitHub's CDN, the `<user>.github.io/aptkit/` path — is GitHub infrastructure configured by the workflow, not code aptkit executes. There's no reverse proxy, no load balancer, no edge logic the repo owns.

#### Move 3 — the principle

The principle: **the address is just configuration, and loopback is the address that needs no resolution.** A system that talks only to `localhost` has no DNS-failure surface, no split-horizon DNS to misconfigure, no resolver timeout to tune. The cost is that you've pushed every real-hostname concern (DNS caching, failover, geo-routing) into dependencies — which is fine until one of them resolves slowly and your missing timeout (file `07`) turns that into a hang.

## Primary diagram

```
  Addressing recap — loopback vs real-hostname fork

  aptkit code          │  loopback side (no DNS)
  ─────────────────────┼──────────────────────────────────────────
  Gemma/embed host ────┼──► localhost:11434 → 127.0.0.1  (OS map)
                       │
  dependency side      │  real-hostname side (DNS over :53)
  ─────────────────────┼──────────────────────────────────────────
  Anthropic/OpenAI SDK ┼──► api.*.com        (SDK resolves)
  buffr pg.Pool ───────┼──► DATABASE_URL host (pg resolves)
  Studio Pages (prod) ─┼──► <user>.github.io  (browser resolves)
```

## Elaborate

DNS is the oldest distributed database on the internet, and its failure modes (stale cache, slow resolver, split horizon) cause outages out of all proportion to how little code touches it. aptkit dodges all of that for its own sockets by using loopback. When this repo grows a remote inference endpoint — swapping the Ollama `host` for a real hostname — DNS resolution, its caching, and its failure modes all become live, and the missing timeout in `07` becomes a much sharper problem because a slow resolver now sits in front of every call. See `study-distributed-systems` for how name-resolution failure propagates through the fallback chain.

## Interview defense

**Q: "How does your system handle DNS resolution and failover?"**
Be honest and precise: "My own code talks only to `localhost`, so there's no DNS in aptkit's sockets — loopback resolves from the OS map with no query. DNS for the cloud providers is owned by their SDKs; the database host resolution is owned by the `pg` driver in the companion repo. I haven't had to tune resolver timeouts because I never resolve a real hostname myself." Then name the upgrade: "The moment I point the Ollama `host` at a remote box, DNS becomes real and I'd want a connect timeout in front of it."

```
  sketch: the fork — most of my arrows go left (loopback)

  name ──► [loopback?] ──yes──► 127.0.0.1   (where I live)
                    └───no────► resolver     (where deps live)
```

Anchor: *loopback is the address that needs no phonebook.*

## See also

- `01-network-map.md` — the five hops these addresses sit on
- `03-tcp-udp-connections-and-sockets.md` — what happens after the address resolves
- `04-tls-and-trust-establishment.md` — why the loopback hop skips TLS too
