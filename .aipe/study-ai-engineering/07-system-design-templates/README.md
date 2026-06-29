# 07 — System-design templates

> Anchor: LLM application engineering. · Curriculum: Phase 3 (no curriculum file
> in this repo; exercises cite real aptkit/buffr paths instead).

Interview reframes, not new code. These templates take systems you'd whiteboard
in a 45-minute design loop and hold them against the same aptkit codebase the
concept files cover. Same code, different framing: the concept files ask "how
does this work"; these ask "could you defend this as a search-ranking system, a
support chatbot."

The shape here is deliberately different from the concept files. No
zoom-out, no how-it-works walkthrough. Each file is a prompt, a standard
architecture, the data model, the components, where it breaks at scale, how you'd
eval it, the failure modes — then an honest verdict on whether aptkit already is
this system and the concrete refactor that would let you claim it does.

Read the "Applies to this codebase" bullet as the load-bearing one. Most of
these are `partially`: aptkit has the retrieval layer but not the learned ranker,
the RAG spine but not the escalation path. Knowing exactly what's missing is the
defensible answer in the room.

## Files (self-contained per template)

1. `01-search-ranking.md` — embed + cosine top-k as the retrieval layer; the learned reranker aptkit doesn't have
2. `02-tech-support-chatbot.md` — the rag-query agent as the RAG-over-KB + grounded-answer spine; the escalation gate it's missing
