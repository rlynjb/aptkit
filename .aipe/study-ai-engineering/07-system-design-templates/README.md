# 07 — System design templates (interview reframes)

> Anchor: codebases reframed as interview templates. Curriculum: Phase 5.

Different from every other sub-section. These files don't explain a pattern
aptkit uses — they explain an *interview prompt* aptkit exemplifies (or
could be refactored to exemplify). Same code, interview framing.

Each file uses the fixed nine-bullet template shape (prompt → architecture
→ data model → key components → scale → eval → failure modes → applies to
this codebase → how to make it apply). No Zoom-out / How-it-works blocks.

## Files

- `01-search-ranking.md` — "Design a search ranking system." Applies `partially` (aptkit has the retrieval layer, no learned ranker/click logs).
- `02-tech-support-chatbot.md` — "Design a tech support chatbot." Applies `partially` (the RAG-over-KB + intent + escalation shape maps onto the analytics agents).
