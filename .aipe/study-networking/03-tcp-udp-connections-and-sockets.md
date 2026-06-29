# TCP, UDP, Connections, and Sockets

**Industry name:** transport layer / connection lifecycle / sockets · *Industry standard*

## Zoom out, then zoom in

One layer below HTTP is the connection itself: the socket that gets opened, used, and torn down. Here's where aptkit's code opens one.

```
  Zoom out — where a socket gets opened

  ┌─ Service layer ────────────────────────────────────────────┐
  │  defaultHttpTransport → fetch(`${base}/api/chat`, ...)     │
  │                          ★ this opens a TCP connection ★    │
  └───────────────────────────┬────────────────────────────────┘
                              │ TCP handshake → request → response → close
  ┌─ Provider layer ─────────▼─────────────────────────────────┐
  │  Ollama daemon listening on TCP :11434 (loopback)          │
  └────────────────────────────────────────────────────────────┘

  ┌─ Storage layer (buffr) ────────────────────────────────────┐
  │  pg.Pool — keeps a SET of TCP connections OPEN, reuses them │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** A socket is the OS handle for one connection between two `(IP, port)` pairs. TCP gives you an ordered, reliable byte stream after a 3-way handshake; UDP gives you fire-and-forget datagrams with no ordering. Everything aptkit and buffr touch is TCP — HTTP rides on it, the pg wire protocol rides on it. The pattern to learn: **a connection has a lifecycle (open → use → close), and the big design choice is whether you pay that lifecycle cost per request or amortize it with a pool.**

## Structure pass

**Layers:** the agent loop (caller) → the transport (`fetch` / `pg.Pool`) → the OS socket → the listening daemon.

**Axis — lifecycle: "when does the connection open and close?"** Trace it across the two socket-owners in this system:

```
  Axis — connection lifecycle — across the two owners

  owner            opens when            closes when         reused?
  ──────────────────────────────────────────────────────────────────
  fetch (Gemma)    each complete() call  response done       NO (per request)
  fetch (embed)    each embed() call     response done       NO (per request)
  pg.Pool (buffr)  lazily, up to a cap   pool idle/shutdown  YES (checked out/in)
```

**Seam:** the boundary between aptkit's per-request `fetch` and buffr's pooled `pg` is where the lifecycle axis flips from "open-use-close every time" to "open once, lend out repeatedly." That flip is the entire reason connection pools exist.

## How it works

#### Move 1 — the mental model

You know a `fetch()` from the browser: you call it, a request goes out, a response comes back, you don't think about the connection underneath. Under that `fetch` is a TCP socket — a handshake (SYN / SYN-ACK / ACK), then a reliable ordered byte stream, then a teardown. The kernel of TCP is *reliability through acknowledgement*: every byte is accounted for, retransmitted if lost, delivered in order.

```
  The pattern — TCP connection lifecycle

  client                              server
    │ ── SYN ──────────────────────►   │   handshake
    │ ◄──── SYN-ACK ──────────────────│   (1 round trip
    │ ── ACK ──────────────────────►   │    before any data)
    │                                  │
    │ ── request bytes ─────────────►  │   ordered, ack'd
    │ ◄──── response bytes ───────────│   stream
    │                                  │
    │ ── FIN / close ───────────────►  │   teardown
```

The part people forget: the handshake is a full round trip *before the first byte of your request*. Pay it once and reuse the connection (a pool), or pay it every single time (per-request `fetch`). That's the load-bearing tradeoff.

#### Move 2 — walking the sockets in this repo

**aptkit opens a fresh TCP connection per Ollama call.** The `fetch` in `defaultHttpTransport` (`packages/providers/gemma/src/gemma-provider.ts:204`) has no agent, no keep-alive hint, no pool — Node's default `fetch` (undici) may keep-alive under the hood, but aptkit's code makes no attempt to manage or reuse the connection. Each `complete()` is a standalone request:

```ts
const res = await fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),     // one request, one connection's worth of work
  ...(signal ? { signal } : {}),     // the ONLY lifecycle control: abort
});
```

Because the target is loopback, the handshake cost is negligible (no network latency on `127.0.0.1`), so per-request connections are cheap here. The same code pointed at a remote host would pay a real handshake RTT per call — the cost the missing pool would then matter for (`07`).

**UDP appears nowhere.** No datagram sockets, no QUIC in aptkit's code (HTTP/3 would be QUIC-over-UDP, but the SDKs decide their own protocol). Mark it `not yet exercised` — UDP would become relevant only if the repo grew something latency-sensitive and loss-tolerant (telemetry, a metrics firehose), which it hasn't.

**buffr is where connection pooling actually lives.** `createPool` builds a `pg.Pool` (`buffr/src/db.ts:4-6`), and `PgVectorStore` uses it two ways:

```ts
// pg-vector-store.ts — a multi-statement transaction CHECKS OUT one connection
const client = await this.pool.connect();   // borrow a socket from the pool
try {
  await client.query('begin');
  for (const c of chunks) { /* upsert each */ }
  await client.query('commit');
} finally {
  client.release();                          // return the socket to the pool
}

// search() uses the pool DIRECTLY — pool picks an idle connection for one query
const { rows } = await this.pool.query(`select ... order by embedding <=> $1::vector limit $3`, ...);
```

```
  Layers-and-hops — pool checkout vs direct query

  ┌─ buffr: PgVectorStore ─────────────────────────────────────┐
  │  upsert():  pool.connect() → client → begin/commit → release│  (needs ONE
  │             ◄── borrows a single socket for the txn ──────► │   socket the
  │  search():  pool.query()  → pool lends any idle socket      │   whole txn)
  └──────────────────────────┬─────────────────────────────────┘
                  hop E: pg wire over reused TCP sockets
                             ▼
                    ┌─ Supabase Postgres ─┐
                    │ accepts pooled conns │
                    └──────────────────────┘
```

The distinction matters: `upsert` runs a multi-statement transaction, so it must hold *one* connection across `begin`/`commit` — hence `connect()`/`release()`. `search` is a single statement, so `pool.query()` lets the pool pick any idle connection. Getting this wrong (running `begin`/`commit` on the pool directly) would scatter the transaction across different sockets and break atomicity — that's the load-bearing reason for the checkout pattern.

#### Move 3 — the principle

The principle: **connection lifecycle is a cost you either pay per request or amortize with a pool, and the right choice is set by latency and concurrency, not taste.** aptkit's per-request `fetch` to loopback is correct *because* the handshake is free on `127.0.0.1`. buffr's pool is correct *because* the database is remote and queried often — paying a handshake per query would dominate latency. Same transport (TCP), opposite lifecycle decision, each justified by its distance.

## Primary diagram

```
  Connection lifecycle recap — two owners, opposite choices

  aptkit (loopback, cheap handshake)        buffr (remote, expensive handshake)
  ──────────────────────────────────        ───────────────────────────────────
  complete() → fetch → [SYN/ACK]            search() → pool.query()
             → POST /api/chat                        → reuse an OPEN socket
             → response → CLOSE              upsert() → pool.connect()
             (new socket each call)                   → begin..commit on ONE socket
                                                      → release (back to pool)
  no pool, fine because loopback            pool, required because remote+frequent
```

## Elaborate

TCP's handshake-before-data cost is the reason every serious database client pools connections and every HTTP/1.1 client tries keep-alive. The reason aptkit can skip pooling is purely that it talks to loopback; the reason buffr can't is that it talks across the internet to Supabase. This is also where `pg`'s pool gives you backpressure for free — when all connections are checked out, `connect()` queues, which is the closest thing to flow control in the whole system (`07`). For the reliability guarantees TCP provides under partial failure, see `study-distributed-systems`.

## Interview defense

**Q: "Do you pool connections? Why or why not?"**
Two-part answer: "For my Ollama calls, no — they're plain per-request `fetch` to loopback, where the TCP handshake is free, so pooling buys nothing. For the database in the companion repo, yes — a `pg.Pool`, because the DB is remote and queried per request, so reusing open sockets avoids a handshake RTT every time." Then name the subtlety: "Transactions check out a single connection with `connect()`/`release()`; single queries go through `pool.query()` so the pool picks any idle socket."

```
  sketch: the lifecycle flip

  loopback:  open→use→close  (per call, fine)
  remote:    open ONCE → lend → return  (pool, required)
              ▲ handshake paid once, not per query
```

Anchor: *the handshake is a round trip before your first byte — pool it when that round trip costs something.*

## See also

- `02-dns-routing-and-addressing.md` — resolution happens before the handshake
- `04-tls-and-trust-establishment.md` — TLS adds more round trips on top of the TCP handshake
- `07-timeouts-retries-pooling-and-backpressure.md` — the pool as backpressure; the missing timeout on the socket
