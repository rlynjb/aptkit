# Study — Frontend Engineering (aptkit / Studio)

The frontend in this repo is **Studio** (`apps/studio/`) — React 18 + Vite +
TypeScript, a single-page preview/replay UI for the agent toolkit. This guide
is an *audit* of that surface: what's actually there, anchored to real files,
written for someone who already ships React/Vue every day. No on-ramp. We skip
"what's a hook" and spend the words on what's specific and interesting *here*.

The short version of "what's interesting": there is **no router library, no
data-fetching library, and no client state library** — and the app is better
for it. A 40-line hash router, `useState` everywhere, build-time-inlined
markdown and JSON fixtures, and a single generic replay shell carry the whole
thing. That's the story this folder tells.

## Reading order

1. **`00-overview.md`** — one page. Rendering mode, the state graph in one
   diagram, the network seam in one diagram, the three highest-leverage
   patterns named with file paths. Skim only this and you know the repo.
2. **`audit.md`** — the 8-lens frontend audit. Every lens walked against real
   `file:line` evidence, `not yet exercised` named honestly where it applies.
3. **Pattern files** (`01`–`06`) — one per load-bearing frontend pattern this
   repo actually exercises. Each is a full concept walk (zoom out → structure
   pass → how it works → interview defense).

## The discovered patterns

```
  01  hash-router-with-section-anchors    main.tsx — 40-line router, no lib
  02  build-time-markdown-docs            DocPage.tsx — ?raw + rehype-slug TOC
  03  deterministic-in-browser-rag        RagQueryWorkspace + agent-runners.ts
  04  generic-replay-shell                AgentReplayShell.tsx — one render-prop host
  05  fixture-as-build-input              fixtures.ts + vite.config.ts JSON imports
  06  scripted-theme-transform            scripts/*.mjs — CSS rewritten by a script
```

## Cross-links (where the seam hands off)

- **`study-system-design`** — where state and data *live* at the system level;
  the dev-server `/api/*` middleware as a service boundary; the fixture →
  replay → promote → fixture loop. Studio is the thin client over that.
- **`study-ai-engineering`** — the actual RAG pipeline, embeddings, agent loop,
  precision@k/recall@k. `03-deterministic-in-browser-rag.md` is the *frontend
  half*; the mechanism lives there.
- **`study-performance-engineering`** — bundle size, FCP/LCP as *numbers*. This
  guide names rendering shape; it doesn't measure it.
- **`study-software-design`** — the deep-module argument for `AgentReplayShell`
  and `useReplayArtifacts` (the generics, what they hide). We name it; the
  Ousterhout lens lives there.
- **`study-networking`** — NDJSON-over-fetch streaming semantics on the wire
  (`api.ts` `runReplayStream`). We name the seam; the transport lives there.
- **`study-security`** — `target="_blank" rel="noopener"`, `react-markdown`'s
  default sanitization, no `dangerouslySetInnerHTML`. Trust boundaries live
  there.
