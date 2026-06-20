/**
 * Result of a ranked-retrieval scorer (precision@k / recall@k).
 *
 * Shape mirrors the style of `DetectionScoreResult`:
 * - `ok`    — the computation is WELL-FORMED (not a quality threshold). It is
 *             `false` only when the inputs make the metric undefined (k <= 0, or a
 *             zero denominator). A perfectly valid `score` of 0 still has `ok: true`.
 * - `score` — `matched / total` (in [0, 1]); 0 when not well-formed.
 * - `matched` — number of DISTINCT relevant ids found within the top-k.
 * - `total` — the denominator used for `score` (see each scorer below).
 */
export type RetrievalScoreResult = {
  ok: boolean;
  score: number;
  matched: number;
  total: number;
};

const NOT_WELL_FORMED: RetrievalScoreResult = { ok: false, score: 0, matched: 0, total: 0 };

/**
 * Counts how many DISTINCT ids in the top-k of `retrievedIds` are in `relevantIds`.
 * Duplicate ids within the window are counted once: a relevant id that appears
 * multiple times contributes a single hit (we measure relevance coverage, not
 * frequency).
 */
function countDistinctHits(retrievedIds: readonly string[], relevantIds: ReadonlySet<string>, k: number): number {
  const topK = retrievedIds.slice(0, k);
  const seen = new Set<string>();
  for (const id of topK) {
    if (relevantIds.has(id)) seen.add(id);
  }
  return seen.size;
}

/**
 * precision@k — of the top-k retrieved ids, what fraction are relevant?
 *
 * - Only the first `k` entries of `retrievedIds` are considered.
 * - `matched` = number of distinct top-k ids present in `relevantIds`.
 * - `total` (denominator) = `min(k, retrievedIds.length)`. When fewer than `k`
 *   ids were retrieved we divide by the actual retrieved count rather than `k`,
 *   so a short result list is not unfairly penalised.
 * - Not well-formed (`ok: false`, all zeros) when `k <= 0` or nothing was
 *   retrieved (denominator would be 0).
 */
export function scorePrecisionAtK(
  retrievedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): RetrievalScoreResult {
  if (k <= 0) return { ...NOT_WELL_FORMED };
  const total = Math.min(k, retrievedIds.length);
  if (total === 0) return { ...NOT_WELL_FORMED };
  const matched = countDistinctHits(retrievedIds, relevantIds, k);
  return { ok: true, score: matched / total, matched, total };
}

/**
 * recall@k — of all relevant ids, what fraction appear in the top-k?
 *
 * - Only the first `k` entries of `retrievedIds` are considered.
 * - `matched` = number of distinct top-k ids present in `relevantIds`.
 * - `total` (denominator) = `|relevantIds|` (the full relevant set size).
 * - Not well-formed (`ok: false`, all zeros) when `k <= 0` or `relevantIds` is
 *   empty (denominator would be 0).
 */
export function scoreRecallAtK(
  retrievedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): RetrievalScoreResult {
  if (k <= 0) return { ...NOT_WELL_FORMED };
  const total = relevantIds.size;
  if (total === 0) return { ...NOT_WELL_FORMED };
  const matched = countDistinctHits(retrievedIds, relevantIds, k);
  return { ok: true, score: matched / total, matched, total };
}
