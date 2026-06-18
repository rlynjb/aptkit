export type JsonValidation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type JsonValidator<T> = (value: unknown) => JsonValidation<T>;

export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : text).trim();

  try {
    return JSON.parse(candidate);
  } catch {
    // Fall through to a bounded substring scan.
  }

  const objectStart = candidate.indexOf('{');
  const arrayStart = candidate.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));

  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));
  }

  throw new Error('no parseable json in model output');
}

export function parseValidatedJson<T>(
  text: string,
  validate: JsonValidator<T>,
): JsonValidation<T> {
  let parsed: unknown;
  try {
    parsed = parseAgentJson(text);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return validate(parsed);
}
