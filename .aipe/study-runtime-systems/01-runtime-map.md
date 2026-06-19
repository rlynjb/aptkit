# 01 — Runtime Map

**Industry name:** runtime topology / process-and-task map · *Language-agnostic*

## Zoom out, then zoom in

Before any single mechanism, here's the whole territory: which runtimes exist, what process each piece runs in, and where work actually executes.

```
  Zoom out — the runtimes AptKit runs in

  ┌─ Browser runtime ───────────────────────────────────────────┐
  │  ★ Studio React UI ★   (1 event loop, 1 thread)              │
  │     state, render, fetch, stream-decode                      │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  HTTP (NDJSON response stream)
  ┌─ Node runtime ─────────────────▼──────────────────────────────┐
  │  ★ Vite dev server ★   (1 event loop, 1 thread)               │
  │     middleware → agents → runAgentLoop → providers            │
  │                                                               │
  │  ★ scripts/*.mjs ★     (1 event loop, 1 short-lived process)  │
  │     eval / promote / replay → exit code                       │
  │                                                               │
  │  ★ node --test ★       (1 event loop per package test run)    │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  HTTPS (SDK calls)
  ┌─ Provider boundary ────────────▼──────────────────────────────┐
  │  Anthropic / OpenAI model API   (someone else's machine)      │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: a *runtime map* answers one question — "if I drop a breakpoint anywhere in this repo, which process is it in, which thread, and what's the loop doing while it waits?" For AptKit the answer is short because the topology is small: a handful of single-threaded event loops, each owning its own work, connected only by HTTP/NDJSON and by the filesystem. There is no shared process memory between them, no thread pool inside them.

## Structure pass

**Layers.** Three nested altitudes, outer to inner:
- **Process** — a running `node` (dev server, script, test) or the browser tab.
- **Event loop** — the one scheduler inside each process that pulls ready tasks.
- **Task** — a single awaited Promise continuation (a model call resolving, a tool result, a stream chunk).

**Axis — "where does control live at this altitude?"** Hold that one question constant as you descend:

```
  One question down the layers: "who decides what runs next?"

  ┌─ Process ───────────────────────────┐   the OS scheduler decides
  │  node / browser tab                 │   (preemptive, across processes)
  └──────────────────┬───────────────────┘
      ┌──────────────▼────────────────────┐  the event loop decides
      │  one loop, cooperative scheduling  │  (run-to-completion per task)
      └──────────────┬────────────────────┘
          ┌──────────▼──────────────────────┐ YOUR code decides
          │  await points in runAgentLoop    │ (control yields only at await)
          └──────────────────────────────────┘
```

The control answer flips at each altitude: the OS preempts processes whenever it likes; the event loop never preempts a task mid-run (run-to-completion); and *your* code chooses where to yield by where it writes `await`. That last flip is the whole game in single-threaded JS — between two `await`s, nothing else runs, so you never have a data race, but a synchronous loop with no `await` freezes everything.

**Seams.** The load-bearing boundaries — the ones where the control answer changes:
- **Browser ⇄ Node** — HTTP. Control and memory are fully separate; the only thing crossing is bytes (NDJSON). A bug on one side can't corrupt the other's state.
- **Node ⇄ Provider API** — HTTPS via SDK. This is where the loop *yields* the longest (a model call is hundreds of ms to seconds of awaited I/O). The `AbortSignal` is the one control signal that crosses this seam.
- **`runAgentLoop` ⇄ `ToolExecutor`** — an in-process `await` seam. Same thread, same loop, but the loop yields here too.

## How it works

### Move 1 — the mental model

You already know this shape from any frontend you've shipped: a single-threaded UI thread that stays responsive by *awaiting* `fetch()` instead of blocking on it. AptKit's Node side is the same primitive, one level out — one loop, work expressed as awaited Promises, control yielded only at `await`.

```
  The map kernel — one loop, three task sources, no second thread

         ┌──────────────── one event loop ────────────────┐
         │                                                 │
   timers ──►│   microtask queue (Promise .then / await)   │──► your code
   I/O    ──►│   macrotask queue (timers, I/O callbacks)   │     runs to
   network──►│                                             │     completion
         │   pulls next ready task, runs it to the end,    │     then yields
         │   then pulls the next                           │
         └─────────────────────────────────────────────────┘
```

The kernel: **one loop + one ready-task queue + run-to-completion**. Strip any part and it stops being this model — two loops would need synchronization (the thing JS avoids); a preemptive scheduler would reintroduce races.

### Move 2 — walking the map

**The process is the outermost container.** Each `node scripts/eval-replay-artifacts.mjs` is its own OS process with its own V8 heap, its own event loop, its own exit code. Scripts are short-lived: spin up, do sequential work, set `process.exitCode`, drain, exit. The dev server is long-lived: one process serving many requests on the same loop. Nothing is shared between two script invocations except files on disk.

```
  Process boundary — separate heaps, shared only by disk

  ┌─ node (script A) ─┐      ┌─ node (script B) ─┐
  │  V8 heap A        │      │  V8 heap B        │
  │  event loop A     │      │  event loop B     │
  └─────────┬─────────┘      └─────────┬─────────┘
            │ writes JSON              │ reads JSON
            ▼                          ▼
        ┌────────────────────────────────────┐
        │  artifacts/replays/*.json (disk)    │ ← the only shared state
        └────────────────────────────────────┘
```

**The event loop is the single scheduler inside a process.** It does not run two of your tasks at once. It runs one to completion, then the next. A model call resolving and a stream chunk arriving are two separate tasks that interleave *between* awaits, never *during* a synchronous run of your code.

**A task is one awaited continuation.** `await model.complete()` parks the current function, lets the loop run other ready work, and resumes when the Promise settles. In AptKit the tasks are: a model API call resolving, a tool handler returning, a stream chunk decoding, a file read finishing. That's the whole vocabulary.

### Move 3 — the principle

A runtime map is the first thing to draw for any system, because every later question (races, memory, cancellation) is answered relative to *which loop owns this work*. For AptKit the map is small and clean: a few single-threaded loops, isolated by process/HTTP boundaries, connected by streams and files. The cleanliness is the point — it's why files 04 (races) and 05 (memory) are short.

## Primary diagram

The full topology, every layer and hop labelled.

```
  AptKit runtime topology

  ┌─ Browser (1 loop) ──────────────────────────────────────────┐
  │  Studio UI  ──fetch POST──►                                  │
  │  ◄──for await decodeNdjsonStream── (NDJSON, one event/line)  │
  └───────────────────────────────┬──────────────────────────────┘
                          HTTP     │  Network boundary
  ┌─ Node: Vite dev server (1 loop, long-lived) ──▼──────────────┐
  │  middleware ─► runReplay ─► Agent ─► runAgentLoop            │
  │                                  │  await model + await tools│
  │                                  ▼                           │
  │              traceSink.emit ─► res.write(ndjson)             │
  └───────────────────────────────┬──────────────────────────────┘
                          HTTPS    │  Provider boundary (SDK + signal)
  ┌─ Anthropic / OpenAI API (remote) ──────────────▼─────────────┐
  │  model inference                                             │
  └───────────────────────────────────────────────────────────────┘

  ┌─ Node: scripts/*.mjs (1 loop, short-lived) ──────────────────┐
  │  read fixtures ─► sequential for-await replay ─► exitCode    │
  └───────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** You reach for the runtime map whenever you ask "where is this running?" — debugging a hung Studio replay (is it the browser loop or the Node loop?), reasoning about whether two script runs can corrupt each other (they can't, except via disk), or deciding whether a slow tool blocks anything else (it doesn't block other requests, because each request's loop yields at `await`).

**Code side by side.**

The Node server loop — one handler, awaited work, live writes:

```
  apps/studio/vite.config.ts (lines 887–918)  — streamReplayResponse

  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8'); ← stream, not buffered
  const body = await readJsonBody(req);          ← yields the loop while reading the request
  const result = await run(body, (event) => {    ← yields again during the whole agent run
    res.write(encodeNdjsonRecord({ type: 'event', event })); ← each emit → one line, written now
  });
  res.write(encodeNdjsonRecord({ type: 'result', result }));
       │
       └─ between these awaits the SAME loop serves other requests;
          nothing here spawns a thread — it's one loop interleaving tasks
```

The short-lived script process — sequential, then an exit code:

```
  scripts/replay-promoted-fixtures.mjs (lines 28–47)

  for (const fixturePath of fixturePaths) {        ← strictly sequential
    const result = await runFixtureReplay(fixturePath); ← one at a time, awaited
    results.push({ ... });
  }
  if (failed.length > 0) process.exitCode = 1;     ← the process's only output channel
       │
       └─ no Promise.all, no worker pool: this is one loop draining a list in order
```

## Elaborate

The single-loop model is Node's defining design choice, inherited from the browser. It trades the throughput of true parallelism for the *absence* of an entire class of bugs (data races, deadlocks, torn reads) and the simplicity of never needing a lock. For I/O-bound work — which an LLM agent overwhelmingly is — this is the right trade: the CPU sits idle during network round-trips anyway, so a thread would mostly wait. The map you've just drawn is the substrate every other file in this guide annotates: `03` zooms into the loop's queues, `02` confirms there's no second thread, `06` follows the stream across the browser⇄Node seam.

## Interview defense

**Q: "Walk me through what runs where when a Studio replay streams."**

```
  Browser loop          Node loop                 Provider
  ───────────           ─────────                 ────────
  fetch POST ──────────► handler awaits run
                         runAgentLoop awaits ─────► model.complete
                         (loop free for others)
                         ◄──────────────────────── response
                         emit → res.write ──┐
  decodeNdjsonStream ◄───────────────────────┘ (one line)
  onEvent → setState
  (repeat per event)
```

Answer: "Two single-threaded event loops connected by an NDJSON HTTP stream. The browser loop fetches and decodes; the Node loop runs the agent and writes one line per trace event. While the Node loop awaits the provider, it's free to serve other requests — that's the cooperative scheduling, not parallelism." Anchor: `vite.config.ts:887–918`.

**Q: "Can two replays corrupt each other's state?"** No — each request's run owns its own `messages`/`toolCalls` on its own async call tree; the only shared state is `artifacts/replays/*.json` on disk. Anchor: `run-agent-loop.ts:94–95`.

## Validate

1. **Reconstruct:** Draw the AptKit topology from memory — name the loops, the seams, and the one shared resource (disk). Check against the Primary diagram.
2. **Explain:** Why can the Node loop serve another request *during* a model call? (It yields at `await model.complete()` — `run-agent-loop.ts:103`.)
3. **Apply:** A script `scripts/eval-replay-artifacts.mjs` is slow. Does it slow the dev server? (No — separate process, separate loop. `eval-replay-artifacts.mjs:25`.)
4. **Defend:** Argue why one loop is the right choice for this workload, and name the one case where it isn't (CPU-bound work, e.g. the on-device ML in `contrl` — different repo, needs Worklets/threads).

## See also

- `02-processes-threads-and-tasks.md` — the "no second thread" claim, in depth.
- `03-event-loop-and-async-io.md` — inside the loop: microtasks and awaited I/O.
- `.aipe/study-system-design/` — the same topology as an architecture (boundaries, request flow).
