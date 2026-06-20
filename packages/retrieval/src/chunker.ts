/**
 * Chunker strategy: fixed-size character windows of CHUNK_SIZE (~512 chars) with
 * a small CHUNK_OVERLAP (64 chars) carried between windows.
 *
 * Why fixed-size-by-character (not by token or sentence): it is deterministic,
 * vendor-neutral (no tokenizer dependency), and trivially testable — the right
 * default for the from-scratch in-memory pipeline. ~512 chars keeps each chunk
 * comfortably inside nomic-embed-text's context while staying granular enough to
 * isolate a relevant passage. The overlap stops a fact that straddles a boundary
 * from being split across two chunks and lost. A smarter semantic/recursive
 * splitter is a later drop-in; the contracts above it do not change.
 */
export const CHUNK_SIZE = 512;
export const CHUNK_OVERLAP = 64;

export function chunkText(
  text: string,
  size: number = CHUNK_SIZE,
  overlap: number = CHUNK_OVERLAP,
): string[] {
  if (text.length === 0) return [];
  if (text.length <= size) return [text];

  const step = Math.max(1, size - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return chunks;
}
