export type QueryAnswerValidationResult =
  | { ok: true }
  | { ok: false; error: string };

export function validateQueryAnswer(answer: unknown): QueryAnswerValidationResult {
  if (typeof answer !== 'string') return { ok: false, error: 'answer must be a string' };
  if (answer.trim().length === 0) return { ok: false, error: 'answer must not be empty' };
  if (answer.trim().length < 20) return { ok: false, error: 'answer is too short to be useful' };
  return { ok: true };
}
