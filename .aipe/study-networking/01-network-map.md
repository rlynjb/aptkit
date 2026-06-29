# Network Map

**Industry name:** network boundary map / trust-and-transport topology · *Project-specific*

## Zoom out, then zoom in

Before any single protocol, here's the whole thing in one picture: every place a byte leaves a process in this system, and what carries it.

```
  Zoom out — every network boundary in aptkit + buffr

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  Studio React app (browser)                                │
  │    fetch('/api/...')  ·  reads NDJSON ReadableStream       │
  └───────────────────────────┬────────────────────────────────┘
                              │  hop A: HTTP (same-origin, dev)
                              │         or static files (Pages, prod)
  ┌─ Service layer ──────────▼─────────────────────────────────┐
  │  Studio vite middleware (dev only)                         │
  │    runReplay() → agent loop → ModelProvider.complete()     │
  └───────────────────────────┬────────────────────────────────┘
                              │  hop B: ModelProvider.complete() — a CONTRACT,
                              │         not always a network call
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  ┌─ FixtureProvider ─┐ ┌─ GemmaProvider ──┐ ┌─ Anthropic/OpenAI ─┐
  │  in-memory        │ │ ★ fetch POST ★   │ │  vendor SDK         │
  │  NO wire          │ │ localhost:11434  │ │  owns the wire      │
  └───────────────────┘ └────────┬─────────┘ └─────────┬──────────┘
                                 │ hop C: HTTP          │ hop D: HTTPS
                                 ▼ (loopback, no TLS)   ▼ (TLS, not our code)
                          ┌─ Ollama daemon ─┐    ┌─ api.anthropic.com ─┐
                          │ Gemma + nomic   │    │ api.openai.com      │
                          └─────────────────┘    └─────────────────────┘

  ┌─ Storage layer (buffr, companion repo) ────────────────────┐
  │  PgVectorStore → pg.Pool ── hop E: pg wire / TCP ──► Supabase Postgres
  └────────────────────────────────────────────────────────────┘
```

The box marked ★ is the only socket aptkit's own code opens. Everything else is either a pure in-process call (FixtureProvider), a contract that a dependency turns into bytes (the SDKs, `pg`), or static file serving (Pages).

**Zoom in.** A network map is just the inventory of *boundaries* — the lines in that diagram where data leaves one address space for another — plus, for each line, the protocol and who owns it. You build it once so that every later file ("is there TLS here?", "is there a timeout here?") has a place to point. The pattern this file teaches: **find every boundary, then ask one question across all of them.**

## Structure pass

Five hops, three layers. Here's the skeleton before we trace anything.

**Layers:** UI (browser) → Service (Studio middleware / agent loop) → Provider (Ollama / cloud SDK) and, separately, Storage (buffr → Postgres).

**Axis — trust: "who can see or tamper with the bytes on this hop?"** Trace it across the five hops and the boundaries pop:

```
  One axis — trust — traced across every hop

  hop A  browser → Studio middleware   same machine, dev     → trusted (localhost)
  hop B  middleware → ModelProvider     in-process function   → no wire at all
  hop C  Gemma → Ollama                 loopback, plain HTTP  → trusted (localhost), NO TLS
  hop D  SDK → cloud API                public internet       → TLS, key auth (SDK owns)
  hop E  pg.Pool → Supabase             public internet       → TLS expected (pg/PaaS owns)
```

**Seams (where the trust answer flips):**
- **hop B is the big one** — `ModelProvider.complete()` is a seam where control flips from "guaranteed in-process" to "maybe a socket." That's why it's the contract the whole repo depends on (`packages/runtime`).
- **hop C → hop D** — trust flips from "loopback, no encryption needed" to "public internet, must encrypt." Same `ModelProvider` contract on the near side; completely different wire on the far side.

## How it works

#### Move 1 — the mental model

You already build network maps without naming them: when you draw a frontend talking to an API talking to a DB, you're drawing boundaries. A network map is that drawing made exhaustive — *every* boundary, labelled with its protocol and its trust level. The shape is a list of hops, each one a `from → [protocol] → to`.

```
  The pattern — a hop is from · protocol · to · trust

  ┌────────┐   protocol    ┌────────┐
  │ source │ ───────────►  │  dest  │
  └────────┘   + trust     └────────┘
       │                        │
       └─── different address ──┘
            spaces = a boundary
```

The kernel: a boundary exists wherever data crosses an address-space line. In-process function calls (hop B when the provider is a fixture) are *not* boundaries — no bytes serialize, nothing can be intercepted mid-flight. That distinction is the whole point of the injectable-transport design.

#### Move 2 — walking the real hops

**The provider contract is the seam that may or may not be a wire.** Every agent in the repo calls `model.complete(request)`. That call is defined in `packages/runtime` as a pure interface. Whether it touches the network depends entirely on which implementation got injected.

```
  Layers-and-hops — the ModelProvider seam

  ┌─ Service: agent loop ──────────────────────────────┐
  │  runAgentLoop → model.complete(request)            │
  └──────────────────────────┬─────────────────────────┘
                  hop B: complete() — same call, three fates
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   in-process            fetch to loopback      SDK to internet
   (no bytes)            (HTTP, hop C)          (HTTPS, hop D)
```

The Gemma default transport is the concrete wire (`packages/providers/gemma/src/gemma-provider.ts:201-215`):

```ts
function defaultHttpTransport(host: string): GemmaChatTransport {
  const base = host.replace(/\/$/, '');           // strip trailing slash
  return async ({ signal, ...payload }) => {
    const res = await fetch(`${base}/api/chat`, {  // ← hop C, the only socket aptkit opens
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),               // non-streaming JSON body
      ...(signal ? { signal } : {}),               // caller's AbortSignal, if any
    });
    if (!res.ok) {
      throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`); // throw on non-2xx
    }
    return (await res.json()) as OllamaChatResponse;
  };
}
```

Line by line: `base` normalizes `http://localhost:11434`; `fetch` opens the connection; the body is one JSON object (`stream: false` is set by the caller in `complete`); there's no timeout; a non-OK status throws with the body text appended.

**hop D — the cloud SDKs — is a boundary aptkit doesn't manage.** `AnthropicModelProvider` constructs `new Anthropic({ apiKey })` (`packages/providers/anthropic/src/...:25`) and `OpenAIModelProvider` constructs `new OpenAI({ apiKey })` (`packages/providers/openai/src/openai-provider.ts:30`). From there the SDK does DNS, TLS, retries, pooling. aptkit's map records the boundary but the protocol details belong to the dependency.

**hop A / Studio — same-origin HTTP in dev, static files in prod.** The browser calls `fetch('/api/model-status')` and friends (`apps/studio/src/api.ts:11`, `:126`). In dev these hit vite middleware (`apps/studio/vite.config.ts:201-526`). In the GitHub Pages build there is no server — the static bundle ships with recorded fixtures (the RAG page uses an in-browser fake embedder), so hop A degenerates to fetching static assets.

**hop E — buffr's database wire.** `createPool(databaseUrl)` builds a `pg.Pool` (`buffr/src/db.ts:4`); `PgVectorStore.search` runs a cosine query over it (`buffr/src/pg-vector-store.ts:67-86`). This is the pg binary wire protocol over TCP, and it's the only long-lived connection in the whole system.

#### Move 3 — the principle

A network map is worth drawing because **most bugs and most attacks live on the boundaries, not inside the layers.** Once you can name all five hops and the trust level of each, every other networking question has a place to land. The deeper principle here: aptkit deliberately keeps its *own* boundary count to one (hop C), pushing the rest onto dependencies or out to buffr — fewer boundaries you own means fewer places to get TLS, retries, and timeouts wrong.

## Primary diagram

The full map, recapped with protocol and trust on every hop.

```
  aptkit + buffr — complete network map

  Browser ──A: HTTP/static──► Studio middleware ──B: complete() in-proc──► provider
                                                                              │
                            ┌─────────────────────────────────────────────────┤
                            │ C: HTTP loopback (no TLS)     D: HTTPS (SDK)      │
                            ▼                               ▼                   │
                      Ollama :11434                   cloud API                 │
                      Gemma + nomic                   Anthropic/OpenAI          │
                                                                                │
  buffr: PgVectorStore ──E: pg wire over TCP (TLS expected)──► Supabase Postgres
```

## Elaborate

Network maps come from threat-modeling and SRE practice — you can't reason about failure or security without first enumerating the boundaries. The discipline of marking in-process calls as *non*-boundaries is what makes the injectable-transport pattern legible: the same `complete()` call is a boundary or not depending on injection, and the map makes that explicit. Read `01` of `study-system-design` for where these boundaries sit architecturally; read `08` here for the ranked risks on each hop.

## Interview defense

**Q: "Walk me through every network call your system makes."**
Answer with the map. "One socket I own: a plain HTTP POST to a local Ollama daemon. Two boundaries I delegate to vendor SDKs: Anthropic and OpenAI over HTTPS. One static-file boundary: Studio on GitHub Pages. And one database connection in the companion repo: a pg pool to Supabase Postgres." The signal is that you can enumerate them *and* distinguish the one you own from the ones you delegate.

```
  sketch while you talk: 5 hops, mark the one you own

  A browser   B in-proc   C ★OLLAMA★   D cloud-SDK   E pg-pool
                          (only socket
                           I write code for)
```

Anchor: *the in-process call is not a boundary — that's the whole point of the injectable transport.*

## See also

- `02-dns-routing-and-addressing.md` — why every endpoint here skips DNS
- `03-tcp-udp-connections-and-sockets.md` — the connection lifecycle of hop C
- `08-networking-red-flags-audit.md` — ranked risks per hop
