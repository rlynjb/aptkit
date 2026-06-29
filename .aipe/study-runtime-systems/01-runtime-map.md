# Runtime Map — the process, task, and resource map as-built

**Industry name(s):** runtime model / execution model · **Type:** Project-specific (grounded in a standard Node + browser model)

## Zoom out, then zoom in

Before any single mechanism, here's the whole machine. aptkit runs in exactly two kinds of process, and they never share memory — they talk over HTTP.

```
  Zoom out — every place aptkit code executes

  ┌─ Node process ─────────────────────────────────────────────────────────┐
  │  one of: `node --test` · a script in scripts/*.mjs · the Vite dev server │
  │                                                                          │
  │  ┌─ Runtime layer (packages/runtime) ────────────────────────────────┐  │
  │  │   ★ runAgentLoop ★   generateStructured   ndjson-stream  events    │  │ ← we are here
  │  └───────────────────────────────┬────────────────────────────────────┘  │
  │  ┌─ Provider layer (packages/providers/*) ──▼─────────────────────────┐  │
  │  │   gemma  anthropic  openai  fallback  local-context-guard          │  │
  │  └───────────────────────────────┬────────────────────────────────────┘  │
  │  ┌─ Retrieval/memory layer ──────▼───────────────────────────────────┐  │
  │  │   InMemoryVectorStore  OllamaEmbeddingProvider  conversation-memory │  │
  │  └────────────────────────────────────────────────────────────────────┘  │
  └────────────────────────────────────┬───────────────────────────────────────┘
                                        │ fetch() → HTTP (localhost:11434 Ollama,
                                        │ or api.anthropic.com / api.openai.com)
                                        ▼
  ┌─ External processes (not aptkit code) ──────────────────────────────────┐
  │   Ollama daemon (Gemma + nomic-embed)   ·   cloud LLM APIs               │
  └──────────────────────────────────────────────────────────────────────────┘

  ┌─ Browser process (apps/studio) — entirely separate, own event loop ─────┐
  │   React 18 render loop · fetch + ReadableStream reader for NDJSON traces │
  └──────────────────────────────────────────────────────────────────────────┘
```

**Zoom in.** A "runtime map" is just the answer to: when this code runs, what process owns it, what thread executes it, and what resources (sockets, file handles, memory) does it hold? For aptkit the answer is unusually simple, and the simplicity is the lesson — one process, one thread, work driven by `await` on I/O. Everything downstream in this guide is a detail on this picture.

## Structure pass

Pick one axis and trace it across the layers: **control — who decides what runs next?**

```
  Axis: "who drives execution?" — traced top to bottom

  ┌─────────────────────────────────────────────┐
  │ Runtime layer: runAgentLoop                  │  → CODE decides (fixed for-loop, hard bounds)
  └───────────────────┬───────────────────────────┘
      ┌───────────────▼─────────────────────────┐
      │ inside a turn: model.complete()          │  → the LLM decides (tool call vs final text)
      └───────────────┬─────────────────────────┘
          ┌───────────▼─────────────────────────┐
          │ a tool call: tools.callTool()        │  → the TOOL runs (deterministic code)
          └───────────────────────────────────────┘
```

The seams — boundaries where the control answer flips:

- **`runAgentLoop` → `model.complete()`** (`run-agent-loop.ts:103`). Control flips from your code to the model: your loop decides *whether* there's another turn, the model decides *what's in it*. This is the load-bearing seam in the whole repo.
- **`model.complete()` → the transport** (`gemma-provider.ts:69`, `fallback-provider.ts:55`). Control flips from in-process logic to a network call — an `await` that yields the event-loop thread.
- **Node process → external daemon** (the `fetch` at `gemma-provider.ts:204`). Control flips from aptkit to Ollama/cloud, across a process boundary, over HTTP. This is the only place real parallelism happens — but it's the *server's* threads, not yours.

State ownership and failure trace the same boundaries: in-process state lives in the loop's local variables (`messages`, `toolCalls`); failure originates in the transport (`fetch` throws) and propagates back up the `await` chain as a rejected Promise.

## How it works

### Move 1 — the mental model

You already know the shape from any frontend app: a single-threaded JS runtime where `fetch()` doesn't block — it registers a callback and the event loop moves on. aptkit is exactly that, server-side. There is one execution thread; the only thing that ever "pauses" your code is an `await` on an I/O Promise.

```
  The model: one thread, work gated by I/O awaits

  time ──────────────────────────────────────────────────────►

  [agent loop turn 1] ──await fetch──┐
                                     ╎ (thread free — but nothing else queued)
                       ┌─────────────┘
  [parse response]──[cosine scan: CPU, BLOCKS]──[agent loop turn 2]──await...

  the only "parallelism" is the OS/Ollama doing the HTTP work
  while this thread waits at the await
```

The strategy: **structure all latency as awaited I/O so one thread stays responsive, and keep CPU work small enough that running it inline never matters.** That second clause is a bet — `03` and `05` examine where the bet holds and where it's thin.

### Move 2 — the resource inventory

**The process.** aptkit ships no long-running server of its own. The three ways its code runs are all short-lived single processes:

```
  How aptkit code actually gets a process

  ┌─ `node --test dist/test/*.test.js` ─┐   per-package test runner
  │   package.json scripts, every pkg    │   (no jest/vitest)
  └──────────────────────────────────────┘
  ┌─ `node scripts/*.mjs` ───────────────┐   eval-replay, promote-fixture,
  │   one-shot CLI scripts                │   pack-core-standalone
  └──────────────────────────────────────┘
  ┌─ Vite dev server (apps/studio) ──────┐   the only persistent process;
  │   serves the React app + replay API  │   port 4187 in the Playwright config
  └──────────────────────────────────────┘
```

Confirmed in the root `package.json` (`"type": "module"`, workspaces over `packages/*`, `packages/agents/*`, `packages/providers/*`, `apps/*`) and `tsconfig.base.json` (`target: ES2022`, `module`/`moduleResolution: NodeNext`). ESM, NodeNext — modern Node, no transpile-to-CommonJS step at runtime.

**The thread.** One. There is no `worker_threads`, no `cluster`, no `new Worker` anywhere in `packages/`, `apps/`, or `scripts/`. The single use of `child_process` is `spawnSync` in `scripts/pack-core-standalone.mjs:68`, shelling out to `npm pack` during the publish flow — blocking, sequential, off the hot path. So every line of aptkit's actual logic runs on one event-loop thread.

**The sockets.** Outbound HTTP only, via `fetch`. Gemma's transport opens a connection to Ollama at `gemma-provider.ts:204`; cloud providers use their vendor SDKs. No inbound server sockets in the library; the Vite dev server owns the only listening socket, and that's dev tooling.

**The file handles.** All buffered `fs.promises` calls (`readFile`/`writeFile`/`readdir`) in `scripts/*.mjs`, `apps/studio/vite.config.ts`, and `packages/evals/src/replay-runner.ts`. No streaming file descriptors held open — read whole, close, done. (`06` walks this.)

**The memory.** Heap-resident JS objects: the `messages` array growing per turn in `runAgentLoop`, the `Map<string, VectorChunk>` backing `InMemoryVectorStore` (`in-memory-vector-store.ts:12`), the NDJSON buffer in `decodeNdjsonStream`. All garbage-collected; nothing pinned, nothing off-heap. (`05` walks this.)

Here's the wiring that proves the layering — a real agent composing the layers above:

```
  packages/agents/rag-query — the layers, instantiated

  pipeline = createRetrievalPipeline({ embedder, store })   // retrieval layer
       │
  tool   = search_knowledge_base over pipeline               // tools layer
       │
  result = runAgentLoop({ model: gemmaProvider, tools, ... }) // runtime + provider
```

The agent never touches a process, thread, or socket directly — it composes contracts (`ModelProvider`, `VectorStore`, `ToolExecutor`), and the runtime resolves them to actual I/O. That indirection is *why* the runtime map stays this simple: the execution model is concentrated in `runAgentLoop` and the providers, and everything else is pure-ish logic hanging off it.

### Move 3 — the principle

A runtime map is the first thing to draw for any system, because it tells you where your real costs and risks can possibly live. For aptkit the map says: you cannot have a data race between threads (there's one thread), you cannot be killed mid-write by a missing signal handler doing harm (nothing long-running holds critical state), and your only true concurrency is the I/O the OS does while you `await`. That narrows the entire rest of this guide — most "runtime systems" failure modes are structurally impossible here, and the few that remain (event-loop blocking, unbounded growth, ungraceful cancellation) are exactly the ones the later files target.

## Primary diagram

The full map, one frame — process boundaries, the single thread, the I/O seams.

```
  aptkit runtime map — complete

  ┌─ NODE PROCESS (single thread, libuv event loop) ────────────────────────┐
  │                                                                          │
  │   runAgentLoop ─turn loop─► model.complete() ─► transport ─┐            │
  │        ▲  bounds: maxTurns, maxToolCalls, signal            │ fetch     │
  │        │                                                    │ (await)   │
  │   tools.callTool() ◄── tool_use ──┘                         │           │
  │        │                                                    │           │
  │   InMemoryVectorStore.search()  ← CPU, inline, blocks ──────┘           │
  │   heap: messages[], chunks Map, ndjson buffer                           │
  │   files: fs.promises (buffered, no streams)                             │
  └───────────────────────────────────┬──────────────────────────────────────┘
                                       │ HTTP (NDJSON for traces)
       ┌───────────────────────────────┼────────────────────────────┐
       ▼                               ▼                            ▼
  ┌─ Ollama daemon ─┐        ┌─ cloud LLM APIs ─┐        ┌─ Browser: apps/studio ─┐
  │ Gemma + nomic   │        │ Anthropic/OpenAI │        │ React loop + stream    │
  └─────────────────┘        └──────────────────┘        │ reader (own process)   │
                                                          └─────────────────────────┘
```

## Elaborate

This map is the deliberate consequence of aptkit's reason to exist: it's a *library* of provider-neutral capabilities, not a deployed service. The "body" that turns these capabilities into a long-running runtime — process supervision, the durable Postgres/pgvector store, the `agents` schema — lives in the companion **buffr** repo. So aptkit's runtime map is intentionally thin: it owns the execution *logic* (the loop, the providers, the scan) and leaves process lifecycle, persistence, and scale to whoever embeds it. When you read "single process, no shutdown handler" in `07`, that's not an oversight — it's the seam where aptkit ends and the host runtime begins.

## Interview defense

**Q: Walk me through aptkit's runtime model in one breath.**

```
  one Node process · one thread · libuv event loop
  work = sequential awaits on HTTP I/O (LLM + embeddings)
  CPU work (cosine, parse, sort) runs inline on the same thread
  no workers, no cluster, no signal handlers — it's a library, not a service
  Studio is a separate browser process reached over NDJSON/HTTP
```

Anchor: "It's a single-threaded async-I/O runtime — every cost is either an awaited network call or a small inline CPU loop, and the agent loop is the one place control flow lives."

**Q: Where could real parallelism happen?**

```
  in-process:  nowhere — one thread, no Promise.all fan-out anywhere
  cross-process: the Ollama/cloud server runs your request on ITS threads
                 while your event loop waits at the await
```

Anchor: "The only concurrency aptkit gets is free I/O concurrency from the OS and the model server — it never schedules parallel CPU work itself."

## See also

- `02-processes-threads-and-tasks.md` — why one process/one thread, and the task model on top of it
- `03-event-loop-and-async-io.md` — the await points and the one blocking CPU loop
- `study-system-design` — WHERE these components live and how requests cross the buffr/aptkit boundary
