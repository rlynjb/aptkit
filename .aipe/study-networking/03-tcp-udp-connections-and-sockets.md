# 03 — TCP/UDP, connections, and sockets

**Industry name(s):** transport connections / sockets / connection lifecycle. **Type:** Industry standard.

## Zoom out — where this concept lives

Sockets are the layer directly under HTTP — the actual byte pipe. Here's where the two connections in AptKit sit.

```
  Zoom out — two TCP connections, both below HTTP

  ┌─ UI (browser) ────────────────────────────────────────────┐
  │  fetch() ── opens/reuses TCP to dev server                 │
  └───────────────────────────┬────────────────────────────────┘
                              │  ★ CONNECTION 1: TCP, browser↔Node ★
                              │  long-lived (held open for the whole stream)
  ┌─ Service (Node/Vite) ─────▼────────────────────────────────┐
  │  SDK ── opens/reuses TCP to provider                        │
  └───────────────────────────┬────────────────────────────────┘
                              │  ★ CONNECTION 2: TCP, Node↔provider ★
                              │  one per turn (SDK pools/reuses)
  ┌─ Provider (external) ─────▼────────────────────────────────┐
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — narrow to the concept

A socket is the OS object both sides hold for one connection. The question this file answers: *who opens each socket, how long is it held open, and who closes it?* AptKit has up to three TCP connections and the interesting one is still connection 1 — it's held open far longer than a normal request because the server streams into it. There's no UDP anywhere; everything is TCP because everything is HTTP. The repo never touches a *raw* socket — but the socket-ownership story now splits: connection 1 is opened by the browser/Node HTTP server, connection 2 by the SDK's HTTP agent, and connection 3 (Node↔local Ollama, new) by Node's global `fetch`/undici pool because the repo's transport calls `fetch` directly. Connection 3 is an ordinary short request/response — the contrast with conn 1 (long-held) still holds; the new wrinkle is just that the repo, not an SDK, is the code making the `fetch`.

## The structure pass

**Layers.** Connection 1 (browser↔Node, managed by the browser fetch stack on one side and Node's HTTP server on the other). Connection 2 (Node↔provider, managed entirely by the SDK's HTTP agent).

**Axis — lifecycle (when is the socket open vs idle vs closed?).**

```
  One axis (socket lifetime) across the two connections

  connection 1 (browser↔Node):
    open ──── held open for ENTIRE agent run ──── close on res.end()
              (streaming records the whole time)

  connection 2 (Node↔provider):
    open ── one request/response ── kept alive in SDK pool ── reused
              (short-lived per turn, socket recycled)
```

The lifetime answer flips hard across the two: connection 1 is one long-held socket per run; connection 2 is a series of short request/response exchanges over pooled sockets. That contrast is the lesson — same transport (TCP), opposite lifecycle.

**Seams.** The load-bearing seam is `res.end()` in the streaming middleware (`vite.config.ts:916`): it's the single line that decides connection 1's death. Hold it open forever (forget to call it) and the browser's `await reader.read()` never returns `done` — the panel hangs. Connection 2's seam is entirely inside the SDK's agent; the repo can't observe or tune it.

## How it works

### Move 1 — the mental model

You know how a normal `fetch` opens a connection, gets the whole response, and the connection goes back to the pool in milliseconds? Connection 1 here breaks that assumption: the socket stays open for *seconds* because the server keeps writing. Think of it as a fetch where the response body is a faucet that drips for the whole agent run, and the socket can't close until the faucet does.

```
  The long-held-socket shape

  normal fetch:   [open] ─req─ ─resp─ [close]      (milliseconds)

  AptKit conn 1:  [open] ─req─ ─chunk─chunk─chunk…─resp_end─ [close]
                          │                                    │
                     stays open the whole agent run    res.end() closes it
```

### Move 2 — walking each connection

**Connection 1 opens when the browser fetches.** The browser fetch stack opens a TCP connection to the dev server (or reuses a keep-alive one). The Node HTTP server accepts it and hands the middleware a `req`/`res` pair. The socket is now bound to this one logical request. Boundary condition: as long as the middleware hasn't called `res.end()`, the OS keeps this socket in the established state, consuming a file descriptor.

```
  Connection 1 open — TCP established, bound to one req/res

  ┌─ browser ─┐  SYN/SYN-ACK/ACK   ┌─ Node ────┐
  │ fetch     │ ══════════════════►│ accept    │
  │           │  (or reuse pooled) │ → req,res  │
  └───────────┘                    └───────────┘
        socket now ESTABLISHED, held by both sides
```

**Connection 1 stays open while the server streams.** Every `res.write(ndjson)` pushes bytes down this established socket without closing it. The browser's reader pulls them as they arrive. This is the whole point of the design — file `06` covers the protocol, but the *socket* fact is: one connection, many writes, no close between them.

**Connection 1 closes on `res.end()`.** When the agent loop finishes and the final result record is written, the middleware calls `res.end()`. That sends the terminating chunk, the server closes its half, the browser's reader gets `done: true`, and the socket tears down. If the middleware threw before `res.end()` in the `finally`, the connection would leak — which is exactly why `streamReplayResponse` puts `res.end()` in a `finally` block.

```
  Connection 1 close — res.end() tears it down

  ┌─ Node ────┐  res.end() → FIN     ┌─ browser ─┐
  │ finally{} │ ═══════════════════► │ reader    │
  │           │                       │ done:true │
  └───────────┘                       └───────────┘
        socket → TIME_WAIT → closed
```

**Connection 2 is opened, pooled, and reused by the SDK.** Each `client.chat.completions.create` either opens a new TLS-over-TCP socket to the provider or reuses an idle one from the SDK's HTTP agent pool. After the response, the socket goes back to the pool (keep-alive) rather than closing, so the next model turn reuses it. The repo has zero visibility into this — no `maxSockets`, no `keepAlive` setting anywhere. This is `not yet exercised` at the repo level (delegated).

```
  Connection 2 — SDK pools the socket across turns

  turn 1: create() ─► [open socket] ─resp─ ► back to pool (idle)
  turn 2: create() ─► [reuse same socket] ─resp─ ► back to pool
  turn 3: create() ─► [reuse] …
              (all inside the SDK's HTTP agent; repo can't see it)
```

### Move 3 — the principle

The principle is *socket lifetime follows the data shape, not the request count*. Connection 1 is one socket because there's one logical stream, even though dozens of records flow over it. Connection 2 is many short exchanges because each model turn is an independent request/response, even though they reuse one pooled socket. When you reason about sockets, ask "how long does the *data* need the pipe?" — not "how many messages are there?"

## Primary diagram

Both connections, their full lifecycle, who owns each.

```
  AptKit sockets — two TCP connections, opposite lifecycles

  ┌─ UI (browser) ─────────────────────────────────────────────┐
  │  fetch stack opens conn 1                                   │
  │     │  TCP established ───────────────────────── held open  │
  └─────┼───────────────────────────────────────────────────────┘
        │ CONNECTION 1 (browser↔Node): ONE long-held socket
        │ open: fetch  │  data: many res.write  │ close: res.end()
  ┌─────▼───────────────────────────────────────────────────────┐
  │  Node HTTP server (req/res) + SDK HTTP agent                │
  │     │  SDK opens/reuses conn 2                               │
  └─────┼───────────────────────────────────────────────────────┘
        │ CONNECTION 2 (Node↔provider): MANY short pooled sockets
        │ open/reuse per turn │ keep-alive in SDK pool
  ┌─────▼───────────────────────────────────────────────────────┐
  │  Provider                                                   │
  └──────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Connection 1's lifetime is controlled on every streaming replay. Connection 2's lifetime is controlled by no repo code at all — it's the SDK's pool.

**`res.end()` in a `finally` is what guarantees connection 1 closes.** `apps/studio/vite.config.ts:904-917`:

```
  apps/studio/vite.config.ts  (streamReplayResponse, lines 904–917)

  try {
    const body = await readJsonBody(req);
    const result = await run(body, (event) => {
      res.write(encodeNdjsonRecord({ type: 'event', event }));  ← writes, never closes
    });
    res.write(encodeNdjsonRecord({ type: 'result', result }));  ← final write
  } catch (error) {
    res.write(encodeNdjsonRecord({ type: 'error', error: ... })); ← error still over the open socket
  } finally {
    res.end();                                                   ← THE close — always runs
  }
       │
       └─ res.end() in finally is load-bearing: if it only lived in the try and
          run() threw after a partial write, the socket would leak and the
          browser's reader would hang forever waiting for done
```

**The browser side reads until the socket signals done.** `apps/studio/src/api.ts:169-180`:

```
  apps/studio/src/api.ts  (responseBodyChunks, lines 169–180)

  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();  ← pulls bytes off conn 1
    if (done) return;                             ← done = server called res.end()
    if (value) yield value;
  }
       │
       └─ done becomes true only when the server closes its half of the socket;
          this loop is the browser end of connection 1's lifecycle
```

**Connection 2 has no repo-side socket config — by design.** The SDK clients (`openai-provider.ts:30`, `anthropic-provider.ts:25`) are constructed with `apiKey` only. No `httpAgent`, no `maxSockets`, no `keepAlive`. The pool exists; the repo doesn't tune it.

**Connection 3 rides Node's global `fetch` pool — also untuned, but now repo-initiated.** The Gemma/embedding transports call the global `fetch` (`gemma-provider.ts:204`, `ollama-embedding-provider.ts:63`), which uses Node's built-in undici connection pool against `localhost:11434`. Like connection 2 it's a short request/response with keep-alive reuse handled below the repo — but unlike connection 2, the *call* is repo code, so this is the one delegated pool the repo could most easily reach into (pass a custom `dispatcher` to `fetch`). It doesn't, so socket tuning here is `not yet exercised` too. The socket-lifetime lesson is unchanged: conn 3 is "many short exchanges over a reused socket," the same shape as conn 2, just hand-initiated.

## Elaborate

The long-held socket of connection 1 is the same shape you've hit in your streaming work — AdvntrCue streams GPT-4 responses back to the browser over a connection held open the whole generation, and contrl's hot path deliberately holds *no* network socket at all (on-device ML, no cloud in the frame loop). AptKit's connection 1 is the AdvntrCue pattern; its connection 2 is the ordinary request/response your `fetch`-based code does daily. The thing to carry forward: a streaming endpoint changes your socket math — one open socket per concurrent run, not per request. At a single-user dev tool that's one or two sockets; at scale it's the number that decides how many concurrent runs your server can hold.

## Interview defense

**Q: How long is each connection held open, and what closes it?**

```
  conn1: open whole run → res.end()      conn2: short, pooled by SDK
```

Connection 1 (browser↔Node) is held open for the entire agent run because the server streams into it; it closes only when the middleware calls `res.end()` in its `finally` (`vite.config.ts:916`). Connection 2 (Node↔provider) is a short request/response per model turn, with the socket kept alive and reused from the SDK's pool. **Anchor:** `res.end()` in `finally` is the one line that prevents a socket leak.

**Q: Why is there no UDP?**

Everything is HTTP, and HTTP rides on TCP. There's no use case here for an unreliable datagram transport — no media streaming, no DNS-over-UDP in repo code (the OS resolver handles that below). **Anchor:** TCP-only because HTTP-only.

## Validate

1. **Reconstruct:** Draw connection 1's lifecycle: open, data, close — name the trigger for each.
2. **Explain:** Why is `res.end()` in a `finally` and not just after the result write? (Socket-leak / hang prevention on the error path — `vite.config.ts:910,916`.)
3. **Apply:** The panel hangs forever with no error. Which socket, which missing call? (Connection 1; a missing/never-reached `res.end()`.)
4. **Defend:** Why does the repo not tune connection 2's pool? (Single-user tool, no concurrency pressure; SDK defaults are correct — `not yet exercised`.)

## See also

- `04-tls-and-trust-establishment.md` — connection 2 is TLS-over-TCP; what the handshake adds
- `06-websockets-sse-streaming-and-realtime.md` — what flows over connection 1's long-held socket
- `07-timeouts-retries-pooling-and-backpressure.md` — the SDK pool and what AptKit doesn't tune
- study-runtime-systems — the event loop that keeps connection 1's socket serviced without blocking
