# Filesystem, Streams, and Resource Lifecycle — handles, cleanup, and the one real stream

**Industry name(s):** file descriptors / resource lifecycle · streaming vs buffered I/O · `try/finally` cleanup · **Type:** Industry standard

## Zoom out, then zoom in

aptkit touches the filesystem in exactly one mode — buffered, whole-file reads and writes via `fs.promises` — and it has exactly one true stream: the NDJSON trace pipe between the Studio dev server and the browser. This file separates those two: the "read it all into memory" pattern (everywhere) and the "process it as it arrives" pattern (NDJSON only).

```
  Zoom out — aptkit's I/O resources and who holds them

  ┌─ Build/eval scripts (Node) ───────────────────────────────────────┐
  │   fs.promises.readFile/writeFile/readdir — buffered, fd auto-closed │
  │   scripts/*.mjs · packages/evals/replay-runner.ts                  │
  └──────────────────────────────────┬─────────────────────────────────┘
  ┌─ Studio dev server (Node, Vite) ──▼─────────────────────────────────┐
  │   reads fixtures (buffered) → runs replay → ★ NDJSON STREAM ★ ──────┐│ ← we are here
  │   res.write(encodeNdjsonRecord(event)) per trace event              ││
  └──────────────────────────────────┬──────────────────────────────────┘
                                      │ HTTP, application/x-ndjson
  ┌─ Browser (apps/studio) ───────────▼─────────────────────────────────┐
  │   fetch → response.body.getReader() → decodeNdjsonStream (async gen) │
  └──────────────────────────────────────────────────────────────────────┘
```

**Zoom in.** Resource lifecycle is about acquiring a handle (a file descriptor, a stream reader, a socket), using it, and releasing it — ideally even when something throws. aptkit's filesystem story is the easy version: `fs.promises` opens, reads/writes, and closes the descriptor for you in one call, so there's nothing to leak. The genuinely interesting resource is the stream reader on the browser side, which *does* hold a lock that must be released — and the code does it correctly in a `finally`. That's the lifecycle worth studying.

## Structure pass

Trace the **state/ownership** axis on resources — who holds the handle, and when is it released?

```
  Axis: "who holds this handle, and when is it freed?" — per resource

  ┌──────────────────────────────────────────────────────────┐
  │ fs.promises.readFile(path)                                 │  → fd opened + closed
  │   (scripts/*.mjs, replay-runner.ts)                        │     inside the one call
  └───────────────────┬────────────────────────────────────────┘
      ┌───────────────▼────────────────────────────────────────┐
      │ server NDJSON response (vite.config.ts)                  │  → res held open across
      │   res.write per event, res.end at the finish             │     many writes, ended once
      └───────────────┬────────────────────────────────────────┘
          ┌───────────▼────────────────────────────────────────┐
          │ browser ReadableStream reader (api.ts:170)           │  → lock held across reads,
          │   reader.read() loop, reader.releaseLock() in finally │     released in finally
          └────────────────────────────────────────────────────┘
```

The seam: **the boundary between a handle that lives inside one call and one that lives across many operations.** `readFile` is the first kind — acquire-use-release is atomic, no leak surface. The HTTP response and the stream reader are the second kind — held open across a loop, which means cleanup has to be explicit and exception-safe. The reader's `try/finally` (`api.ts:171-179`) is the one place aptkit does manual resource cleanup, and it's the pattern to point at.

## How it works

### Move 1 — the mental model

You know the `fetch` loading-state lifecycle: start, in-flight, done (or error) — and in every branch you stop the spinner. Resource lifecycle is the same discipline applied to handles: acquire, use, release — and *release on the error path too*. The leak shape is forgetting the error path: a handle acquired, an exception thrown mid-use, and the release line skipped.

```
  Resource lifecycle — release must cover the throw

  acquire handle ──► use it ──► release   ← happy path: fine
                       │
                       └─ throws here ──► release SKIPPED ──► LEAK
                                          unless release is in a finally

  the fix: try { use } finally { release }   ← release runs either way
```

The strategy: **prefer APIs that bundle acquire-use-release into one call (`fs.promises.readFile`) so there's no handle to leak, and where a handle must be held across a loop, put the release in a `finally`.**

### Move 2 — the two I/O patterns

**Buffered file I/O — the whole-file pattern, everywhere.** Every filesystem touch in the repo is `fs.promises`, reading or writing the entire file in one call. Examples: `scripts/pack-core-standalone.mjs:1` (`cp, mkdir, mkdtemp, readFile, writeFile`), `scripts/replay-model-recommendation.mjs:1`, `packages/evals/src/replay-runner.ts:1` (`readdir, readFile`), and `apps/studio/vite.config.ts:1`. The shape:

```ts
// conceptually, everywhere:
const text = await fs.readFile(path, 'utf8');   // opens fd, reads all, closes fd
const data = JSON.parse(text);                  // parse the whole thing
```

There are **no** `fs.createReadStream` or `fs.createWriteStream` calls anywhere. Is that a problem? No — and naming why matters. These files are replay artifacts and fixtures, JSON documents of a few KB. JSON parsing needs the whole document in memory regardless, so streaming the read would buy nothing — you'd reassemble it to parse it anyway. And `fs.promises.readFile` opens *and closes* the descriptor inside the one call, so there's no handle held open, no leak surface, no cleanup to get wrong. Buffered whole-file I/O is the correct call for small JSON; it would be the *wrong* call for a multi-gigabyte log, which aptkit doesn't have.

```
  Why buffered beats streaming here

  small JSON fixture (KBs):
    readFile (buffered) → parse        ← simple, fd auto-closed, no leak
    createReadStream → reassemble → parse  ← more code, same memory, no win

  the crossover where streaming wins: files too big to hold in memory
  → aptkit has none of those (it's a library over small artifacts)
```

**The NDJSON stream — the one real streaming pipe.** This is the exception, and it's a proper stream end to end. The server side (in `apps/studio/vite.config.ts`'s `streamReplayResponse`) sets `content-type: application/x-ndjson` plus `x-accel-buffering: no` (to disable proxy buffering so events flush immediately), then writes one NDJSON record per trace event as the agent run produces it — using `encodeNdjsonRecord` from `@aptkit/runtime` (`ndjson-stream.ts:31`). Events flow to the browser *as they happen*, not after the run completes.

The browser side consumes it as a true stream, `api.ts:138`:

```ts
for await (const record of decodeNdjsonStream(responseBodyChunks(response.body))) {
  // ... handle each record as it arrives: event | result | error
}
```

And the resource-lifecycle heart — adapting the browser `ReadableStream` to an async iterable, with correct cleanup (`api.ts:169`):

```ts
async function* responseBodyChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();          // ← acquire: locks the stream
  try {
    while (true) {
      const { done, value } = await reader.read();   // ← use: pull chunks
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();                    // ← release: ALWAYS, even on throw/early-return
  }
}
```

This is the textbook lifecycle. `getReader()` locks the stream (only one reader allowed). The `while` loop pulls chunks. The `finally` releases the lock — so if the consumer throws, or the generator is abandoned early (a `break` upstream), the lock is still released and the stream isn't left locked. That `finally` is the single most important resource-cleanup line in the repo.

```
  The NDJSON stream — server to browser, chunk by chunk

  ┌─ Studio server (Node) ──────────────┐  HTTP, application/x-ndjson
  │  per trace event:                    │  ┌────────────────────────┐
  │    res.write(encodeNdjsonRecord(ev))  │ ─►│ chunk: {"type":"event"}│
  │  at end: res.write({result}); res.end │  │ chunk: {"type":"event"}│
  └───────────────────────────────────────┘  │ chunk: {"type":"result"}│
                                              └───────────┬─────────────┘
  ┌─ Browser (apps/studio) ──────────────────────────────▼─────────────┐
  │  reader = body.getReader()        ← acquire (lock)                  │
  │  while: reader.read() → yield chunk → decodeNdjsonStream buffers,    │
  │         yields one complete line at a time → onEvent(event)         │
  │  finally: reader.releaseLock()    ← release (always)                │
  └──────────────────────────────────────────────────────────────────────┘
```

Note the partial-line handling lives in `decodeNdjsonStream` (`ndjson-stream.ts:108`, walked in `05`): a chunk can split a JSON line in half, so the decoder buffers the tail until the newline arrives. The reader doesn't care about line boundaries; the decoder does. Clean separation of concerns — the reader owns the *handle* lifecycle, the decoder owns the *line* lifecycle.

**Sockets and the dev server.** The only listening socket is the Vite dev server's, owned by Vite, not aptkit code. Outbound HTTP (`fetch` to Ollama/cloud) uses connections managed by the runtime's `fetch` implementation — aptkit holds no socket handles directly, opens no servers in the library. No connection pool to manage, no descriptors to leak. (`study-networking` covers the transport side.)

### Move 3 — the principle

Resource lifecycle is the discipline of guaranteeing release on every exit path, and the cleanest way to honor it is to never hold a raw handle longer than one call — let the API acquire and release atomically. aptkit does that everywhere it can (`fs.promises.readFile` is acquire-use-release in one line) and reaches for explicit `try/finally` only at the one place a handle genuinely spans a loop (the stream reader). The lesson: buffered whole-file I/O isn't a shortcut to apologize for — it's the right tool when files are small, because it eliminates the leak surface entirely. Streaming earns its complexity only when the data doesn't fit in memory or needs to flow incrementally — which in aptkit is exactly one pipe, the live trace, and there the lifecycle is handled correctly.

## Primary diagram

The complete I/O picture: buffered whole-file reads with no held handles, one streaming pipe with explicit reader cleanup.

```
  aptkit filesystem + stream resources — complete

  ┌─ BUFFERED FILE I/O (everywhere) ─────────────────────────────────────┐
  │  fs.promises.readFile/writeFile/readdir                               │
  │  acquire fd ─ read/write whole ─ close fd  ← all in one call, no leak │
  │  correct because: small JSON artifacts, parse needs whole doc anyway  │
  │  ✗ no createReadStream / createWriteStream anywhere                    │
  └────────────────────────────────────────────────────────────────────────┘
  ┌─ THE ONE STREAM: NDJSON trace pipe (Studio only) ─────────────────────┐
  │  server: res.write(encodeNdjsonRecord(event)) per event, x-accel: no  │
  │     │ HTTP application/x-ndjson, flushed as events happen              │
  │  browser: reader = body.getReader()      ← acquire (lock)             │
  │           loop reader.read() → decodeNdjsonStream → onEvent           │
  │           finally reader.releaseLock()    ← release on every exit     │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The "always read the whole file" instinct gets a bad name from systems that apply it to huge data and run out of memory — but for configuration, fixtures, and small documents it's simply correct, and it sidesteps the entire descriptor-leak problem that streaming APIs introduce (a `createReadStream` you forget to close, or that errors before `'end'`, leaks an fd). The `ReadableStream` + `getReader` + `releaseLock` pattern aptkit uses on the browser side is the Web Streams API, the same primitive that powers `fetch` body consumption and `TransformStream`s; the `try/finally` around `releaseLock` is the canonical way to make a locked stream exception-safe. If aptkit ever needed to stream large files (say, indexing a huge corpus from disk), the move would be `fs.createReadStream` piped through a line splitter into the same `decodeNdjsonStream` — the decoder already accepts any `AsyncIterable<string | Uint8Array>`, so it'd drop in. See `05` for the memory side of buffering, and `study-networking` for the HTTP transport the NDJSON rides on.

## Interview defense

**Q: aptkit reads every file fully into memory — isn't that a problem?**

```
  files are small JSON (fixtures, replay artifacts) — KBs
  JSON.parse needs the whole doc anyway → streaming the read buys nothing
  fs.promises.readFile opens AND closes the fd in one call → no leak surface
  buffered is correct here; streaming earns its keep only for data too big
  to hold in memory, which the repo doesn't have
```

Anchor: "Buffered whole-file reads are the right call for small JSON — they eliminate the descriptor-leak surface entirely; streaming would be more code for the same memory and no win."

**Q: Show me where aptkit manages a resource that must be released even on error.**

```
  api.ts:169 responseBodyChunks — the browser NDJSON stream reader
    reader = body.getReader()   ← acquire (locks the stream)
    try { loop read() → yield } finally { reader.releaseLock() }
  the finally guarantees the lock is freed on throw OR early break,
  so the stream is never left locked
```

Anchor: "The one held-across-a-loop handle is the stream reader, and its `releaseLock` is in a `finally` — released on every exit path."

## See also

- `05-memory-stack-heap-gc-and-lifetimes.md` — the memory side of buffered reads and the streaming NDJSON buffer
- `03-event-loop-and-async-io.md` — the async-generator stream decode and its await points
- `study-networking` — the HTTP transport the NDJSON stream rides on
