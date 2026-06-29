# Network Map

**The on-the-wire path · the network boundary inventory** — *Project-specific*

## Zoom out — where the network lives

You've shipped a RAG app (AdvntrCue) where the browser hits a serverless function that hits Postgres and GPT-4. aptkit is the opposite shape: almost everything runs *in one process on one machine*, and the only wire that leaves that process in the default path goes to a daemon on the same box. Here's the whole system as bands, with the network boundaries marked.

```
  Zoom out — aptkit's layers, network boundaries starred

  ┌─ Caller layer ─────────────────────────────────────────────┐
  │  CLI script · agent (rag-query) · Studio React UI           │
  └───────────────────────────┬─────────────────────────────────┘
                              │  in-process function calls (no wire)
  ┌─ Runtime layer ───────────▼─────────────────────────────────┐
  │  runAgentLoop → ModelProvider.complete() (the contract)      │
  └───────────────────────────┬─────────────────────────────────┘
                              │  in-process (no wire)
  ┌─ Provider/adapter layer ──▼─────────────────────────────────┐
  │  GemmaModelProvider · OllamaEmbeddingProvider                │
  │     ★ NETWORK BOUNDARY ★  → the only wire aptkit owns        │ ← we are here
  └───────────────────────────┬─────────────────────────────────┘
                              │  HTTP POST, plain, loopback
  ┌─ External process ────────▼─────────────────────────────────┐
  │  Ollama daemon  localhost:11434  /api/chat · /api/embed      │
  └───────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

A **network map** is the inventory of every point where your code hands bytes to something it can't reach into and call directly — every socket, every origin, every protocol. Before you can reason about timeouts or TLS or retries, you need the *list*: how many wires are there, where do they go, and who owns each one? For aptkit the list is short, and that shortness is the most important fact about it.

## Structure pass — the skeleton

**Layers** (outer → inner): caller → runtime → provider adapter → *wire* → external daemon. Only one layer boundary is a network boundary; the rest are plain in-process calls.

**Axis traced — "is there a socket here?"** Hold that one question constant down the stack:

```
  One question down the stack: "is there a socket here?"

  ┌──────────────────────────────────┐
  │ caller → runtime                  │  → NO  (function call)
  └──────────────────────────────────┘
      ┌──────────────────────────────┐
      │ runtime → provider.complete() │  → NO  (function call, the contract)
      └──────────────────────────────┘
          ┌──────────────────────────┐
          │ provider → defaultHttp    │  → YES ★ the seam flips here
          │            Transport       │
          └──────────────────────────┘
              ┌──────────────────────┐
              │ Ollama daemon         │  → it's the other end of the socket
              └──────────────────────┘

  the answer flips exactly once — that boundary is the whole map
```

**Seam — `ModelProvider.complete()` vs the HTTP transport.** The contract (`model-provider.ts`) promises "give me a request, get a response" and says *nothing* about a network. The socket only appears one layer deeper, inside the adapter's default transport. That's the load-bearing boundary: above it, no network; below it, exactly one.

## How it works

### Move 1 — the mental model

Think of aptkit's network as a `fetch()` you'd write in a React component — except instead of hitting your API, it hits `localhost`, and instead of being scattered through components, it's funneled through a single injectable function. The shape:

```
  The one-wire pattern — funneled through an injectable port

         caller code
             │
             ▼
   ModelProvider.complete(request)        ← contract, no network
             │
             ▼
   this.chat(payload)                      ← the seam (GemmaChatTransport)
             │
   ┌─────────┴──────────┐
   │ default            │  test
   │ defaultHttp        │  injected mock
   │ Transport (fetch)  │  (recorded JSON)
   └─────────┬──────────┘
             │  POST http://localhost:11434/api/chat
             ▼
         Ollama daemon
```

Every wire in aptkit goes through a port like this. Swap the function, swap the network — that's why tests never open a socket.

### Move 2 — walking the boundaries

**Boundary 1 — the Gemma chat wire.** This is the primary one. The client (the Gemma provider) builds a JSON payload and the default transport `POST`s it to the chat endpoint.

```ts
// packages/providers/gemma/src/gemma-provider.ts:201-215
function defaultHttpTransport(host: string): GemmaChatTransport {
  const base = host.replace(/\/$/, '');           // normalize trailing slash
  return async ({ signal, ...payload }) => {
    const res = await fetch(`${base}/api/chat`, {  // ← the only outbound wire
      method: 'POST',                               // one verb
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),                // {model, messages, stream:false, options}
      ...(signal ? { signal } : {}),                // cancellation pass-through
    });
    if (!res.ok) {                                  // fail-loud, no retry
      throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as OllamaChatResponse;
  };
}
```

Line by line: `host` defaults to `http://localhost:11434` (`gemma-provider.ts:48`); the path is hardcoded `/api/chat`; the body is the whole request object minus `signal`; non-2xx throws with the status and body text. No timeout, no retry, no headers beyond `content-type`.

**Boundary 2 — the embeddings wire.** Same shape, different path and a body remap.

```ts
// packages/retrieval/src/ollama-embedding-provider.ts:60-75
function defaultHttpTransport(host: string): EmbedTransport {
  const base = host.replace(/\/$/, '');
  return async ({ signal, ...payload }) => {
    const res = await fetch(`${base}/api/embed`, {              // ← second wire
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: payload.model, input: payload.texts }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as OllamaEmbedResponse;
    return json.embeddings ?? [];                                // [] when absent
  };
}
```

Note the body translation: the transport takes `{texts}` but sends `{input}` — Ollama's `/api/embed` wants `input`. That remap is the only protocol-shaping these transports do.

**Boundary 3 — Studio dev server (HTTP middleware).** Not an outbound wire — an *inbound* one the React UI hits. Vite's `configureServer` registers handlers like `/api/model-status` and the NDJSON streaming routes.

```
  Layers-and-hops — Studio dev request flow

  ┌─ Browser (UI) ─┐  hop1: POST /api/stream/query/replay   ┌─ Vite dev ──┐
  │  React fetch() │ ────────────────────────────────────► │  middleware │
  └────────────────┘  hop2: x-ndjson chunks (event,event…) └──────┬──────┘
        ▲                ◄─────────────────────────────────       │ runs agent
        └──── hop3: result record ◄──────────────────────────────┘  in-process
                                                          (no further wire;
                                                           fixtures, not Ollama)
```

This wire is `127.0.0.1:4187` (`playwright.studio.config.ts:10,16`), HTTP/1.1, and it streams NDJSON via `streamReplayResponse` (`vite.config.ts:888-919`). In the *production* Pages build there's no dev server at all — the UI is static assets fetched from GitHub Pages over HTTPS, and the agents run fully in-browser against recorded fixtures.

**Boundary 4 — the cloud SDKs (not on the default path).** `AnthropicModelProvider` and `OpenAIModelProvider` wrap vendor SDKs that own their own HTTPS wire to `api.anthropic.com` / `api.openai.com`. aptkit doesn't construct those sockets; the SDK does. They're only reached if a caller wires them (e.g. through the `FallbackModelProvider`), and `/api/model-status` (`vite.config.ts:202-216`) just reports whether the keys exist — it never calls out.

**Boundary 5 — buffr's `pg` wire (different repo).** The durable store reaches Supabase Postgres over a TCP connection pool (`buffr/src/db.ts:4-6`). That's a different protocol (Postgres wire, not HTTP) in a different repo. aptkit's `VectorStore` contract is what buffr's `PgVectorStore` implements — the seam is in aptkit, the socket is in buffr.

### Move 3 — the principle

A network map's value is its *length*. aptkit has exactly two outbound HTTP wires it owns, both to `localhost`, both behind an injectable port. When the map is this short and this funneled, every network property — timeout, TLS, retry — has exactly one place to live. The risk isn't sprawl; it's that the one place is currently *empty* of timeout logic.

## Primary diagram

The complete network map: every boundary, who owns the socket, what protocol.

```
  aptkit network map — boundaries, owners, protocols

  ┌─────────────────────────────────────────────────────────────────┐
  │ BOUNDARY            OWNER              PROTOCOL        WHERE       │
  ├─────────────────────────────────────────────────────────────────┤
  │ 1 Gemma chat        aptkit (default    HTTP/1.1 POST   gemma-      │
  │   →localhost:11434  transport)         plain, no TLS   provider   │
  │                                                        .ts:201    │
  │ 2 embeddings        aptkit (default    HTTP/1.1 POST   ollama-    │
  │   →localhost:11434  transport)         plain, no TLS   embedding  │
  │                                                        .ts:60     │
  │ 3 Studio dev API    Vite middleware    HTTP/1.1 +      vite.      │
  │   127.0.0.1:4187    (inbound)          NDJSON stream   config:202 │
  │ 4 cloud SDKs        vendor SDK         HTTPS           anthropic/ │
  │   api.*.com         (not default path) (SDK-owned)     openai pkg │
  │ 5 Postgres (buffr)  buffr pg.Pool      TCP, pg wire    NOT this   │
  │   Supabase                             protocol        repo       │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

The reason the map is this short is deliberate: aptkit is the deployment-*agnostic* core. Anything that would add a real network boundary — a hosted vector DB, a managed LLM, a sync server — is pushed into the "body" repo (buffr) behind a contract. That's why `ModelProvider`, `EmbeddingProvider`, and `VectorStore` exist: each is a seam where a network adapter *could* live, but in aptkit the adapter is either local-HTTP or in-memory. The map you'd draw for buffr is bigger; the map for aptkit is intentionally one machine.

## Interview defense

**Q: Walk me through every network call your system makes.**
Two outbound HTTP wires, both to a local Ollama daemon: `POST /api/chat` and `POST /api/embed`, plain HTTP on `localhost:11434`. Both go through an injectable transport port so tests use no network. Studio's dev server adds an inbound HTTP middleware on `127.0.0.1:4187` that streams NDJSON. Cloud SDKs (Anthropic/OpenAI) own their own HTTPS but aren't on the local default path. The Postgres wire lives in the companion repo, not the core.

```
  caller → contract (no wire) → adapter → ★fetch★ → localhost Ollama
                                  └ injectable: tests swap the fetch
```
Anchor: *"two wires, one origin, one verb, fully injectable."*

**Q: Why is the network surface so small?**
Because the core is deployment-agnostic by design. Every place a real network adapter would go is a contract (`ModelProvider`/`VectorStore`); the production sockets live in buffr. aptkit ships the seam, not the socket.

## See also

- `03-tcp-udp-connections-and-sockets.md` — the socket lifecycle under that one `fetch`
- `05-http-semantics-caching-and-cors.md` — the verb, status, and header choices
- `07-timeouts-retries-pooling-and-backpressure.md` — what's missing at the boundary
- `00-overview.md` — ranked findings and `not yet exercised` list
