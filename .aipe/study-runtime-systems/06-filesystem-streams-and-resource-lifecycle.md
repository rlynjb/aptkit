# Filesystem, Streams, and Resource Lifecycle

**Subtitle:** file descriptors / streaming I/O / resource cleanup (the `finally` close) — *the resource lifecycle* (Industry standard).

## Zoom out, then zoom in

The core packages of aptkit touch **no filesystem and no OS handles at all** — they're pure async functions over in-memory data and a `fetch`. Files, streams, and descriptors show up in exactly one place: the **Studio dev server** (`apps/studio/vite.config.ts`), which reads replay artifacts off disk and streams NDJSON traces back over HTTP. So this file is really about Studio's resource handling — and it's the one place in the repo that demonstrates streaming output and `finally`-guarded cleanup.

```
  Zoom out — where resources are held in the runtime

  ┌─ Core packages (runtime, retrieval, providers…) ─┐
  │  NO fs, NO descriptors, NO streams — pure async   │
  │  the only OS resource: a fetch socket per call    │
  └───────────────────────┬───────────────────────────┘
  ┌─ Studio dev server (apps/studio/vite.config.ts) ─▼┐
  │  ★ reads artifacts/replays/*.json (file handles) ★ │ ← THIS CONCEPT
  │  ★ streams NDJSON out (res.write / res.end) ★      │   lives here
  └────────────────────────────────────────────────────┘
```

**Zoom in.** Two resource stories. The *input* side: Studio reads replay artifact and fixture files with `node:fs/promises` — `readdir` to list, `readFile` to load, whole-file reads that open and auto-close a descriptor per call. The *output* side: Studio streams trace events to the client as NDJSON, writing chunk-by-chunk with `res.write` and closing the response in a `finally`. The lifecycle question — *who opens the handle, who's responsible for closing it, and what happens on error* — has a clean answer here, and it's worth seeing because it's the repo's only example of explicit resource cleanup.

## The structure pass

Trace the axis **"who owns this resource and who closes it?"** across the two I/O directions.

```
  One axis — "who closes it?" — by resource

  ┌─ fetch socket (core, every model/embed call) ─┐  owner: fetch/libuv
  │  gemma-provider, ollama-embedding-provider     │  → auto-closed after body read
  └──────────────┬──────────────────────────────────┘
  ┌─ file descriptor (Studio, readFile/readdir) ──┐  owner: fs.promises
  │  vite.config.ts                                │  → auto-closed (whole-file read)
  └──────────────┬──────────────────────────────────┘
  ┌─ HTTP response stream (Studio, res.write) ────┐  owner: the HANDLER
  │  streamReplayResponse                          │  → MUST close in finally
  └───────────────────────────────────────────────┘
```

The seam is between the **auto-closed** resources (sockets, file reads — the runtime manages them) and the **manually-closed** one (the HTTP response stream, which the handler must `res.end()` itself). The axis-answer flips from "the platform closes it for you" to "you must close it, including on error." That flip is exactly where resource leaks live in real systems — a stream you forgot to close on an error path — and Studio handles it correctly with a `finally`. → that `finally` is the load-bearing line of this whole file.

## How it works

### Move 1 — the mental model

You know this from any `fetch` you've written: you don't manually close the socket — the browser/runtime does it once you've read the body. But you also know the other shape: a `WritableStream` or a Node response where *you* decide when it's done by calling `.end()`. The rule that ties them together: **every acquired resource needs a guaranteed release, and "guaranteed" means it runs even when the body throws.** That's what `try/finally` is for.

```
  The resource-lifecycle kernel — acquire, use, ALWAYS release

  acquire ──► use ──┬─► success ──► release ─┐
                    │                         ├─► resource freed
                    └─► error  ──► release ───┘   (finally guarantees this)

  drop the "release on error" branch → leaked handle on every failure
```

Named by what breaks if removed:
- **The release step** — skip it and the descriptor/stream stays open; do it in a loop and you exhaust the fd table or leave a client hanging on a never-closed response.
- **The "release on error too" guarantee (`finally`)** — without it, the happy path frees the resource but any thrown error leaks it. This is the single most common resource bug, and the one `finally` exists to kill.

### Move 2 — the two directions, walked

**Input: whole-file reads, auto-closed.** Studio lists and loads replay artifacts and fixtures from disk:

```ts
// apps/studio/vite.config.ts:1 (import) and :943, :953
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
// ...
entries = await readdir(dir, { withFileTypes: true });   // list the directory
// ...
const artifact = JSON.parse(await readFile(path, 'utf8')); // read one file whole
```

`fs.promises.readFile` opens a descriptor, reads the *entire* file into a string, and closes the descriptor — all in one call. You never hold a long-lived fd; there's nothing to leak because the read is atomic from your side. The tradeoff is the same as the HTTP full-buffer reads in `05`: the whole file lands in memory at once. For replay artifacts (JSON in the KB range) that's fine. `createReadStream` (incremental, descriptor held open across reads, manual close) is `not yet exercised` — and unnecessary at these file sizes. The `readdir`/`readFile` pattern repeats for every fixture loader (`vite.config.ts:991, 1037, 1083, 1129`).

**Output: NDJSON streamed chunk-by-chunk, closed in `finally`.** This is the interesting one. Studio streams trace events to the browser as they happen, rather than buffering the whole run and sending it at the end:

```ts
// apps/studio/vite.config.ts:888-919  (streamReplayResponse)
res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
res.setHeader('cache-control', 'no-cache');
res.setHeader('x-accel-buffering', 'no');          // tell proxies: don't buffer
try {
  const body = await readJsonBody(req);
  const result = await run(body, (event) => {
    res.write(encodeNdjsonRecord({ type: 'event', event }));   // one line per event
  });
  res.write(encodeNdjsonRecord({ type: 'result', result }));   // final result line
} catch (error) {
  res.write(encodeNdjsonRecord({ type: 'error', error: ... })); // error as a line
} finally {
  res.end();                                                    // ← ALWAYS close
}
```

Walk the lifecycle one move at a time:

```
  Layers-and-hops — the NDJSON stream's lifecycle

  ┌─ Studio handler (server) ─┐   hop 1: set headers, open response
  │  streamReplayResponse      │ ─────────────────────────────────►┐
  │                            │   hop 2: per trace event,          │
  │  run(body, onEvent) ───────┼── res.write(one NDJSON line) ─────►│ ┌─ Browser ─┐
  │   (the agent loop emits)   │   hop 3: result line               │ │ client    │
  │                            │ ─────────────────────────────────►│ │ reads      │
  │  finally: res.end() ───────┼── hop 4: close the stream ────────►│ │ line by   │
  └────────────────────────────┘                                   └─┤ line      │
        ▲ closes even if run() throws (error written as a line first)│ └───────────┘
```

- **Acquire** — the response is "opened" by setting headers; the client now expects a stream.
- **Use** — the agent run is passed an `onEvent` callback; each `CapabilityEvent` it emits (`run-agent-loop.ts:112-179` emits `step`, `tool_call_start`, etc.) is encoded with `encodeNdjsonRecord` (`ndjson-stream.ts:31-33`) and written as one line. The encoding lives in the runtime; the *transport* (the `res.write`) lives in Studio — a clean split noted right in the code comment (`vite.config.ts:900`).
- **Release on error** — a thrown error is caught and written as an `{ type: 'error' }` line, so the client learns *why* the stream ended instead of seeing a truncated connection.
- **Release always** — `res.end()` in the `finally` closes the stream on *every* path: success, error, or anything else. This is the line that prevents a leaked, half-open response — a client hanging forever on a request that errored.

**The request body read — a hand-rolled stream consumer.** The incoming request is itself a stream, consumed manually:

```ts
// apps/studio/vite.config.ts:921-937  (readJsonBody)
req.setEncoding('utf8');
req.on('data', (chunk) => { raw += chunk; });   // accumulate chunks
req.on('end', () => { ... resolve(JSON.parse(raw)); });
req.on('error', reject);                         // ← stream error path wired
```

This is the classic Node readable-stream pattern: accumulate `data` chunks, resolve on `end`, reject on `error`. The `error` listener is the resource-hygiene detail — without it, a stream error would go unhandled. It buffers the whole body (consistent with the whole-file/whole-response philosophy), which is right for small JSON request bodies.

### Move 3 — the principle

Resource safety is "acquire, use, *always* release" — and "always" is carried by `finally`, not by the happy path. aptkit's core dodges the problem entirely by holding no handles (sockets auto-close, no files), which is the cleanest possible answer for a library. Studio, which *does* hold a streaming response open, gets the lifecycle right: it writes errors as data instead of dropping the connection, and it closes in a `finally` so no failure path leaks the stream. The transferable lesson: the moment you hold a resource the runtime won't auto-release — a stream, a long-lived fd, a DB connection — the `finally` that releases it is mandatory, and it's where leaks hide when it's missing.

## Primary diagram

```
  Filesystem, streams, and resource lifecycle in aptkit — complete

  ┌─ Core packages ──────────────────────────────────────────────┐
  │  NO files, NO descriptors. Only fetch sockets (auto-closed     │
  │  after res.json/res.text). Nothing to leak.                    │
  └────────────────────────────────────────────────────────────────┘

  ┌─ Studio dev server (apps/studio/vite.config.ts) ──────────────┐
  │                                                                │
  │  INPUT (auto-closed)                                           │
  │   readdir → list artifacts/replays                             │
  │   readFile(path, 'utf8') → whole file, fd opened+closed        │
  │                                                                │
  │  OUTPUT (handler-owned — MUST close)                           │
  │   set NDJSON headers ──► res.write(event line) ─┐              │
  │                          res.write(result line) ├─► to browser │
  │                          catch → write error line│             │
  │                          finally → res.end() ◄───┘ ALWAYS      │
  │                                                                │
  │  REQUEST (manual stream consume)                               │
  │   req.on('data') accumulate · on('end') parse · on('error')    │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The `finally`-guarded `res.end()` is the runtime-systems version of a lesson every backend engineer learns the hard way: open file descriptors and half-open connections don't clean themselves up, and the error path is where you forget to release them. Streaming NDJSON (newline-delimited JSON, one object per line) is the pragmatic choice for trace output because the client can parse incrementally — it doesn't wait for the whole run to finish, which matters when an agent loop takes several seconds. aptkit's runtime even ships the decoder for it (`decodeNdjsonStream`, `ndjson-stream.ts:103-135`) with partial-line buffering across chunk boundaries, so a record split across two network chunks still parses. The core deliberately holds no other resources, which is why a library is so much easier to reason about than a service: no connection pools to drain, no file handles to track, no descriptors to exhaust. Those concerns move to buffr, the process owner. → `07-backpressure-bounded-work-and-cancellation.md` for shutdown, where releasing in-flight resources cleanly would matter.

## Interview defense

**Q: aptkit streams trace events to the browser — how does it avoid leaking the response stream?**
The handler closes the response in a `finally` (`vite.config.ts:917`), so `res.end()` runs on every path — success, error, anything. Errors are written *as an NDJSON line* before the close, so the client learns why the stream ended instead of seeing a dropped connection. That `finally` is the load-bearing line; without it, any thrown error mid-stream leaks a half-open response.

```
  acquire (headers) → write events → catch (error as a line) → finally res.end()
```
*Anchor: "always release" means release on the error path too — that's what `finally` guarantees.*

**Q: Does aptkit's core hold any file handles or descriptors?**
No. The core packages are pure async functions over in-memory data plus a `fetch`; the socket auto-closes after the body read. Files only appear in the Studio dev server, read whole with `fs.promises.readFile` (open + read + close in one call). There's nothing long-lived to leak. Incremental `createReadStream` reads are `not yet exercised` — unnecessary at these file sizes.

## See also

- `05-memory-stack-heap-gc-and-lifetimes.md` — the whole-file/whole-body read tradeoff
- `03-event-loop-and-async-io.md` — the stream writes happen on the event loop
- `07-backpressure-bounded-work-and-cancellation.md` — releasing resources on shutdown
- `study-networking` — the NDJSON transport and HTTP streaming semantics
