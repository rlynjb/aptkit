# 06 — Filesystem, Streams, and Resource Lifecycle

**Industry name:** I/O streams / resource lifecycle (open → use → release) · *Industry standard*

## Zoom out, then zoom in

This concept follows the resources a run opens — file handles, stream readers, the HTTP response writer — and asks "who closes them, and when?" It spans two runtimes connected by one NDJSON stream.

```
  Zoom out — the streaming + filesystem resources

  ┌─ Browser runtime ────────────────────────────────────────────┐
  │  ReadableStream reader  ──for await──► decodeNdjsonStream      │
  │  ★ reader.releaseLock() in finally{} ★                        │ ← we are here
  └──────────────────────────┬───────────────────────────────────┘
                  HTTP NDJSON │  Network boundary
  ┌─ Node runtime ───────────▼───────────────────────────────────┐
  │  res.write(...) per event   ★ res.end() in finally{} ★        │ ← and here
  │  readFile / writeFile / mkdir / readdir (fs handles)          │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: a *resource* is anything with an open/use/close lifecycle — a file descriptor, a stream reader, a response socket. The hazard is leaking it (never closing → fd exhaustion, hung sockets). The question this file answers: "for each resource AptKit opens, where's the close, and does it run even on error?" The good news up front: the two streaming resources both close in a `finally{}`, so they survive thrown errors. The file handles use `fs/promises`, which close themselves. The gap: the *write* side of streaming has no backpressure.

## Structure pass

**Layers.** Browser stream reader → HTTP → Node response writer + filesystem handles.

**Axis — "where is this resource released, and is the release guaranteed?"**

```
  One question down the layers: "is the close guaranteed on error?"

  ┌─ browser reader ────────────┐  YES — releaseLock() in finally{}
  └──────────────┬───────────────┘
       ┌─────────▼──────────────────┐ YES — res.end() in finally{}
       │  node response writer       │ (but write() has no backpressure)
       └─────────┬──────────────────┘
           ┌─────▼────────────────────┐ YES — fs/promises auto-closes
           │  fs handles (read/write)  │ the fd; no manual close needed
           └──────────────────────────┘
```

Release is guaranteed at every layer — two via explicit `finally{}`, one via the promise-based fs API that never exposes a raw fd. The axis answer is uniformly "yes," which is the point: this code doesn't leak.

**Seams.** Two seams matter:
- **The `finally{}` block** — the contract "this resource closes no matter how the try exits." It's the load-bearing detail; remove it and an error mid-stream leaks the socket or reader.
- **The `res.write` call** — the seam where backpressure *should* live but doesn't. Its return value (a boolean meaning "buffer full, wait for drain") is ignored.

## How it works

### Move 1 — the mental model

You know the React `useEffect` cleanup pattern: you open something (a subscription, a listener) and return a cleanup function that *always* runs on unmount, even if the effect threw. `finally{}` is the same guarantee for a resource: the close runs whether the `try` succeeded or threw. Strategy: **acquire → use → release-in-finally, so release is unconditional.**

```
  The lifecycle kernel — release is unconditional

  try {
    acquire resource          ← open fd / get reader / set stream headers
    use it (may throw)        ← write events, read file, decode chunks
  } finally {
    release resource          ← runs on success AND on error
  }
       │
       └─ remove the finally and a thrown error skips the release → leak
```

### Move 2 — walking the mechanism

**The Node response writer: headers, per-event writes, guaranteed end.** `streamReplayResponse` sets NDJSON headers, then for each trace event writes one line, then writes a final `result` (or `error`) line, then `res.end()` in a `finally{}`. The `finally` is what guarantees the socket closes even if the agent run throws mid-stream — otherwise the browser's `for await` would hang forever waiting for bytes that never come.

```
  Server stream lifecycle — the finally{} is load-bearing

  setHeader(content-type: x-ndjson)          ← acquire (declare stream)
  try {
    for each event: res.write(ndjson line)   ← use (may throw in run())
    res.write(result line)
  } catch { res.write(error line) }           ← errors become a stream record
  finally { res.end() }                       ← RELEASE — always closes socket
       │
       └─ without finally, a throw inside run() leaks the socket;
          the browser reader hangs
```

**The error-as-record pattern.** Note the `catch` writes an `{type:'error'}` NDJSON record rather than letting the exception kill the connection abruptly. The client decodes it as a normal record and throws a clean error. The resource (socket) still closes in `finally`. This keeps the stream protocol intact even on failure.

**The browser reader: pull chunks, release the lock in finally.** `responseBodyChunks` wraps the `ReadableStream` reader in an async generator. It reads until `done`, then `reader.releaseLock()` in a `finally{}` — so even if decoding throws or the consumer breaks out of the `for await`, the reader lock is released and the stream can be cancelled/GC'd.

```
  Browser reader lifecycle

  const reader = body.getReader();        ← acquire
  try {
    while (true) {
      const { done, value } = await reader.read();  ← pull one chunk (use)
      if (done) return;
      if (value) yield value;             ← hand to decoder
    }
  } finally {
    reader.releaseLock();                 ← RELEASE — even on throw/break
  }
```

**Filesystem handles: `fs/promises` closes them for you.** Every file touch — `readFile`, `writeFile`, `mkdir`, `readdir` — uses the promise-based API, which opens, does the operation, and closes the fd internally. There's no `open()`/`close()` pair to leak. `readdir` errors (e.g. `ENOENT` for a missing `promoted/` dir) are caught and turned into an empty list rather than crashing.

```
  Filesystem — no raw fd to leak

  await mkdir(outDir, { recursive: true })   ← idempotent, no handle held
  await writeFile(outPath, json, 'utf8')      ← opens, writes, closes internally
  await readFile(path, 'utf8')                ← same
  try { await readdir(dir) } catch (ENOENT) { return [] } ← missing dir is not fatal
```

**The gap — no write backpressure.** `res.write()` returns `false` when the kernel send buffer is full, signalling "stop writing, wait for the `drain` event." AptKit ignores the return value and keeps writing. For a human watching an agent trace (tens of events, slow human-paced production) this never matters. Under a flood of events to a slow/stalled client, the unsent data buffers in the Node process's memory unboundedly. This is the one resource-lifecycle weakness, and it's a *throughput-under-overload* gap, not a leak.

```
  Backpressure — present on read (pull), absent on write (push)

  READ side (browser):  for await asks for next chunk  ← natural backpressure:
                        slow consumer → slow pull          decoder waits for consumer

  WRITE side (server):  res.write(line)  ← return value IGNORED
                        if client is slow, data buffers in Node memory,
                        unbounded — no wait-for-drain
```

### Move 2.5 — current state vs future state

```
  Phase A (now): fire-and-forget write     Phase B (if needed): honor drain
  ────────────────────────────────────     ──────────────────────────────────
  res.write(line)                           if (!res.write(line))
  (ignore boolean)                            await once(res, 'drain')
  • fine for human-paced traces             • bounds Node memory under slow client
  • unbounded buffer if client stalls       • or cap event rate / drop events
```

What doesn't have to change: the NDJSON record format, the `finally{ res.end() }` close, and the client decoder all stay identical. Backpressure is a write-loop change, not a protocol change.

### Move 3 — the principle

Resource safety is "release runs unconditionally," and the tool for that in JS is `finally{}` (or a self-closing API like `fs/promises`). AptKit gets the *correctness* of resource lifecycle right everywhere — nothing leaks. What it leaves on the table is the *flow control* half: pull-based streaming gives backpressure for free, but push-based `res.write` needs you to honor `drain`, and that's the one place the code doesn't. Correct close, missing backpressure — that's the honest summary.

## Primary diagram

```
  Streaming + filesystem lifecycle — full picture

  ┌─ Browser ────────────────────────────────────────────────────┐
  │  getReader() ─try─► read chunks ─► yield ─finally► releaseLock │
  │       │                                                       │
  │  decodeNdjsonStream ─► onEvent (event) | result | error       │
  └──────────────────────────┬───────────────────────────────────┘
                  HTTP NDJSON │  (pull side: natural backpressure)
  ┌─ Node ───────────────────▼───────────────────────────────────┐
  │  setHeader ─try─► res.write per event [no drain check] ─►      │
  │              catch─► res.write(error record)                  │
  │              finally─► res.end()  (socket always closed)      │
  │                                                               │
  │  fs/promises: mkdir → writeFile → (auto-close fd)             │
  │               readdir(catch ENOENT → []) → readFile           │
  └───────────────────────────────────────────────────────────────┘
       leaks: none · backpressure: read=yes, write=NO
```

## Implementation in codebase

**Use cases.** Reached for on every streaming replay (open response, write events, close), every artifact save/promote (write a JSON file), every fixture-summary listing (read a directory), and every browser-side trace consumption (read the stream).

**Code side by side.**

Server stream — write loop, error-as-record, guaranteed close:

```
  apps/studio/vite.config.ts (lines 900–918)

  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8'); ← acquire
  res.setHeader('x-accel-buffering', 'no');     ← tell proxies not to buffer
  try {
    const body = await readJsonBody(req);
    const result = await run(body, (event) => {
      res.write(encodeNdjsonRecord({ type: 'event', event })); ← per event, NO drain check
    });
    res.write(encodeNdjsonRecord({ type: 'result', result }));
  } catch (error) {
    res.write(encodeNdjsonRecord({ type: 'error', error: ... })); ← failure as a record
  } finally {
    res.end();                                  ← RELEASE — socket always closed
  }
```

Browser reader — lock released in finally:

```
  apps/studio/src/api.ts (lines 169–180)

  const reader = body.getReader();              ← acquire
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;                   ← pull-based: consumer paces this
    }
  } finally {
    reader.releaseLock();                        ← RELEASE on done, throw, or break
  }
```

Filesystem — self-closing handles, ENOENT tolerated:

```
  apps/studio/vite.config.ts (lines 938–952, 374–377)

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];     ← missing dir → empty, not crash
    throw error;
  }
  ...
  await mkdir(outDir, { recursive: true });      ← idempotent
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8'); ← auto-closes fd
```

## Elaborate

The `finally{}`-release pattern is the JS analogue of RAII (C++) or `defer`/`try-with-resources` (Go/Java) — the language guarantees cleanup on every exit path. `fs/promises` goes further by never handing you a raw fd to leak. The backpressure gap is the classic Node streaming footgun: the read side (`ReadableStream` / async iterables) gives you backpressure for free because it's pull-based, but the write side (`res.write`) is push-based and silently buffers if you don't honor `drain`. It's invisible until a slow client meets a fast producer — which AptKit's human-paced agent traces never create, so the gap is real but currently harmless. `not yet exercised`: explicit `drain` handling, `pipeline()`/`pipe` with backpressure, `highWaterMark` tuning, stream error propagation beyond the single try/catch, and `AbortSignal`-driven stream teardown on the server side.

## Interview defense

**Q: "If the agent run throws mid-stream, does the socket leak?"**

```
  try { run() throws here ─────────┐
  } catch { write error record }   │  both paths reach...
  } finally { res.end() } ◄────────┘  ...the release
```

Answer: "No — `res.end()` is in a `finally{}`, so it runs whether `run()` resolved or threw. The error even becomes a normal `{type:'error'}` NDJSON record so the client decodes it cleanly instead of seeing a truncated stream." Anchor: `vite.config.ts:904–917`. The part people forget: the *error* still closes the resource; correctness doesn't depend on the happy path.

**Q: "Is there backpressure on the stream?"** On the read side yes (pull-based async iterable). On the write side no — `res.write`'s return value is ignored, so a slow client causes unbounded buffering in Node memory. Fix is honoring `drain`. Anchor: `vite.config.ts:907`.

## Validate

1. **Reconstruct:** Write the acquire/use/release-in-finally skeleton for the server stream and the browser reader.
2. **Explain:** Why does `fs/promises` mean no fd leak? (It opens, operates, and closes internally — no raw handle exposed; `vite.config.ts:377`.)
3. **Apply:** A reviewer worries a thrown agent error hangs the browser. Walk the path that prevents it. (`finally{ res.end() }` + error record — `vite.config.ts:910,916`.)
4. **Defend:** Argue when the missing write backpressure becomes a real problem and name the minimal fix (`await once(res,'drain')` when `res.write` returns false).

## See also

- `03-event-loop-and-async-io.md` — the async generator and pull-based backpressure.
- `07-backpressure-bounded-work-and-cancellation.md` — the broader bounded-work + cancellation story.
- `05-memory-stack-heap-gc-and-lifetimes.md` — why unbounded write-buffering is a memory risk.
- `.aipe/study-system-design/` — streaming-NDJSON as an architecture seam.
