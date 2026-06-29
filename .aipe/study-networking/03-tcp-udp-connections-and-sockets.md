# TCP/UDP, Connections, and Sockets

**Transport-layer connections · socket lifecycle · the fetch under the hood** — *Industry standard*

## Zoom out — where the socket lives

A `fetch` looks like one line, but under it is a whole connection lifecycle: open a TCP socket, three-way handshake, write the request, read the response, close or keep-alive. aptkit never touches that layer directly — it delegates entirely to Node's `fetch` (undici). Here's where the socket sits relative to your code.

```
  Zoom out — the socket under the transport

  ┌─ aptkit code ─────────────────────────────────────────────┐
  │  defaultHttpTransport: await fetch(url, {method, body})    │
  └──────────────────────────┬─────────────────────────────────┘
                             │  fetch delegates to undici
  ┌─ Node HTTP stack (undici) ▼────────────────────────────────┐
  │  connection pool · keep-alive · the actual Socket           │ ← we are here
  └──────────────────────────┬─────────────────────────────────┘
                             │  TCP three-way handshake
  ┌─ OS TCP stack ────────────▼────────────────────────────────┐
  │  loopback socket → Ollama listening on :11434               │
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

A **connection** is a live, ordered byte channel between two sockets; **TCP** is the protocol that makes it reliable and ordered; a **socket** is the endpoint your code holds. The question this topic answers: when aptkit calls `fetch`, what connection actually opens, who owns it, and when does it close? The short version — aptkit owns *none* of it; undici does — but you still need to know the lifecycle to reason about hangs and reuse.

## Structure pass — the skeleton

**Layers:** aptkit transport → undici (Node's HTTP client) → OS TCP → loopback. aptkit lives only at the top; everything socket-shaped is delegated downward.

**Axis traced — "who owns the socket?"**

```
  One question down the stack: "who owns the socket?"

  ┌────────────────────────────────────┐
  │ aptkit defaultHttpTransport         │  → owns NOTHING (just a URL + body)
  └────────────────────────────────────┘
      ┌────────────────────────────────┐
      │ undici (global fetch)            │  → owns the pool, keep-alive, the socket
      └────────────────────────────────┘
          ┌────────────────────────────┐
          │ OS TCP stack                 │  → owns the handshake, buffers, FIN
          └────────────────────────────┘
              ┌────────────────────────┐
              │ Ollama daemon            │  → owns the listening socket on :11434
              └────────────────────────┘

  the socket is owned two layers below aptkit — that's why there's nothing to tune here
```

**Seam — `fetch` itself.** The boundary between "aptkit's concern" and "the transport's concern" is the `fetch` call. Above it: request shape. Below it: the entire connection lifecycle, untouched and undocumented in aptkit.

## How it works

### Move 1 — the mental model

You know how when you call `fetch()` in the browser you never think about the TCP handshake — the platform handles open/reuse/close? Identical here, just Node's undici instead of the browser. aptkit hands undici a URL and a body; undici decides whether to open a new socket or reuse a pooled one.

```
  The delegated-socket pattern — fetch owns the lifecycle

   aptkit: fetch(url, {method:'POST', body, signal})
              │
              ▼
   undici:  [ pool ] ── reuse idle socket? ──► yes → write request
              │                              └► no  → open new TCP socket
              │                                       (SYN → SYN/ACK → ACK)
              ▼
   socket:  write headers+body → read status+body → keep-alive (back to pool)
              │
              └─ signal.abort() → undici destroys the socket
```

### Move 2 — walking the lifecycle

**aptkit opens nothing explicitly — `fetch` does.** There is no `net.Socket`, no `http.Agent`, no `keepAlive` config anywhere in the transports. The single line that triggers a connection:

```ts
// packages/providers/gemma/src/gemma-provider.ts:204-209
const res = await fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
  ...(signal ? { signal } : {}),
});
```

When this runs, undici either reuses a pooled keep-alive socket to `localhost:11434` or opens a fresh TCP connection (SYN/SYN-ACK/ACK). On loopback that handshake is microseconds — no network latency — but it's still TCP, still ordered, still reliable delivery. The embedding transport (`ollama-embedding-provider.ts:63`) does the same.

**The transport always uses TCP — never UDP.** HTTP rides on TCP, so every aptkit wire is a connection-oriented, ordered, retransmitting stream. There's no UDP anywhere (no QUIC config, no datagram protocol). That matters because it means *ordering and delivery are free* — aptkit never has to handle out-of-order or dropped application messages. The cost: a connection must be established before the first byte, and a half-open connection (Ollama accepted but stalled) looks identical to a slow one to the caller.

**`stream:false` makes the response one buffered read.** The payload sets `stream:false` (`gemma-provider.ts:71`), so Ollama writes the *entire* JSON response before aptkit reads it. The socket carries one request, then one complete response body — no chunked streaming of model tokens. `await res.json()` reads to EOF and parses.

```
  Socket exchange — one request, one full response (stream:false)

  aptkit ──► [SYN]──────────────────────► Ollama   (handshake, if no pooled socket)
         ◄── [SYN/ACK] ◄──────────────────
         ──► [ACK] ─────────────────────►
         ──► POST /api/chat + JSON body ─►          (one write)
         ◄── 200 + FULL JSON body ◄───────          (one buffered read, stream:false)
         (socket returns to undici keep-alive pool)
```

**Cancellation destroys the socket — but nothing triggers cancellation on a deadline.** If a caller's `AbortSignal` fires, undici tears the socket down and `fetch` rejects with an abort error. The signal threads all the way from `run-agent-loop.ts:91` → `provider.complete(request)` → the transport's `...(signal ? {signal} : {})`. But — and this is the gap repeated across this guide — *nothing fires that signal on a timeout*. So the socket lifecycle has a clean cancel path that's only used if an *outer* caller aborts; a wedged Ollama with a live-but-silent socket will hold the connection open indefinitely. → `07`.

**Connection reuse is undici's default, untuned.** undici keeps sockets alive and pools them per origin. Since aptkit talks to one origin (`localhost:11434`), repeated calls likely reuse one warm socket — but aptkit neither configures nor relies on this. There's no `Agent` with `keepAlive`/`maxSockets`, so the behavior is whatever the Node version's undici defaults are. That's fine for a single-user local tool; it's `not yet exercised` as a tuned concern.

### Move 3 — the principle

Delegating the socket to `fetch` is the right call — you don't reimplement TCP. But delegation hides the lifecycle, and the one part of the lifecycle aptkit *must* own anyway is the deadline. TCP will happily hold a connection open forever; the application has to decide "this is taking too long, kill the socket." aptkit wired the *mechanism* for that (the `AbortSignal` plumbing) but not the *policy* (a timer that fires it). The lesson: when you delegate the socket, you still own the timeout.

## Primary diagram

The full connection lifecycle, with the abort path and the missing trigger marked.

```
  aptkit socket lifecycle — owned by undici, aborted only by an outer caller

  ┌─ aptkit transport ─────────────────────────────────────────┐
  │  await fetch(url, {method, body, signal?})                  │
  └──────────────────────────┬─────────────────────────────────┘
                             │
  ┌─ undici ──────────────────▼─────────────────────────────────┐
  │  pool → reuse keep-alive socket OR open new TCP (handshake) │
  │  write request → read FULL response (stream:false)          │
  │  signal.abort() ──► destroy socket, reject fetch            │
  │       ▲                                                     │
  │       │  fired by: outer caller abort  ✓                    │
  │       │  fired by: a timeout            ✗  ← MISSING        │
  └──────────────────────────┬─────────────────────────────────┘
                             │  TCP, loopback
  ┌─ Ollama :11434 ───────────▼─────────────────────────────────┐
  │  accepts → (may stall here with socket still open) → responds│
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

TCP vs UDP, connection pooling, and keep-alive are the bread and butter of high-throughput services — at scale you tune `maxSockets`, you reuse connections to amortize handshakes, you sometimes reach for UDP/QUIC to dodge head-of-line blocking. aptkit needs none of that because it's one client to one local origin: handshake cost is negligible on loopback, and there's no throughput pressure from a single user. The interesting part isn't the tuning aptkit skipped — it's the one socket-level concern (the deadline) it can't delegate away and currently hasn't filled.

## Interview defense

**Q: When you call `fetch`, what happens at the connection level?**
undici either reuses a pooled keep-alive socket to `localhost:11434` or opens a fresh TCP connection — handshake, then it writes the POST and reads the full response, because I use `stream:false`. It's all TCP, so ordering and delivery are free. I don't tune the pool; one local origin doesn't need it.

```
  fetch → undici pool → (reuse | new TCP handshake) → write → read full body
                                              abort signal → destroy socket
```
Anchor: *"undici owns the socket; I own the request shape and the deadline — and the deadline is the gap."*

**Q: Could a socket leak or hang?**
A hang, yes. The abort plumbing is there end-to-end, but nothing fires it on a timeout. If Ollama accepts the connection and then stalls, the socket stays open and `await fetch` never resolves. The fix is an `AbortController` with a timer at the transport. Leak — no, undici manages socket close/reuse.

## See also

- `04-tls-and-trust-establishment.md` — the (absent) TLS layer above this socket
- `05-http-semantics-caching-and-cors.md` — what travels over the connection
- `07-timeouts-retries-pooling-and-backpressure.md` — the missing deadline, in depth
- `02-dns-routing-and-addressing.md` — what the socket connects *to*
