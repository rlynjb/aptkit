# Study — Frontend Engineering (AptKit Studio)

The frontend in this repo is **Studio** — `apps/studio/`, a React 18 + Vite + TypeScript
single-page app that replays the toolkit's agent capabilities from recorded fixtures so you
can read, evaluate, and compare output in the browser. It is the one place in an
otherwise headless TypeScript toolkit where there are pixels.

This is your home turf — 7+ years of Vue/React. So this guide skips the on-ramp. No
explanation of what a hook is, what reconciliation does, or why a key matters. Instead it
names what is *specific* to this codebase: the choices Studio made and the seams those
choices live behind.

## Reading order

1. **`00-overview.md`** — one page. The rendering mode in a sentence, the state graph in
   one diagram, the network seam in one diagram, the three highest-leverage patterns named
   with file paths. Skim only this and you know what Studio is.
2. **`audit.md`** — Pass 1. The 8-lens frontend audit, one `##` per lens, grounded in
   `file:line`, with `not yet exercised` named honestly where a lens finds nothing.
3. **`01-`…`06-`** — Pass 2. One file per frontend pattern Studio actually exercises:

   - `01-hash-routing-with-section-anchors.md` — the client-side router
   - `02-build-time-markdown-docs.md` — docs inlined at build via `?raw`
   - `03-deterministic-in-browser-rag.md` — a real RAG pipeline, no network
   - `04-generic-trace-replay-shell.md` — one shell, five agent pages
   - `05-fixture-as-build-input.md` — fixtures embedded into the static bundle
   - `06-scripted-theme-transform.md` — the theme as a one-shot CSS codemod

## Cross-links — where the seam hands off

Frontend-engineering owns the framework-and-platform layer only. Mechanism-level teaching
belongs to neighboring guides:

- **`study-system-design`** — where state and data live at the system level; the
  provider/retrieval contracts; the replay-centric evaluation backbone. Studio's
  fixture-replay is the browser-side face of that backbone.
- **`study-ai-engineering`** — the RAG pipeline mechanics (embed → search → rank),
  precision@k / recall@k as eval metrics, agentic retrieval. `03-deterministic-in-browser-rag`
  is the UI face; the algorithm is theirs.
- **`study-software-design`** — module/interface depth, deep-vs-shallow modules. The
  `AgentReplayShell` generic and the `EmbeddingProvider`/`VectorStore` contracts are
  design-quality findings there.
- **`study-performance-engineering`** — FCP/LCP/TTI/bundle-size as *numbers*. This guide
  names *where* render and bundle pressure lives; measurement is theirs.
- **`study-runtime-systems`** — the event loop, `requestAnimationFrame` scheduling, the
  `hashchange` listener as an event source.
- **`study-networking`** — NDJSON-over-`fetch` streaming wire semantics, the
  `ReadableStream` reader. Studio's `api.ts` is the client; the protocol is theirs.
- **`study-security`** — `target="_blank" rel="noopener noreferrer"`, the
  `react-markdown` XSS posture, the `resolveReplayPath` path-traversal guard.
