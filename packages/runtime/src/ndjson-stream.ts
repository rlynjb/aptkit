import type { CapabilityEvent } from './events.js';

export type NdjsonDecodeWarning = {
  type: 'malformed_line';
  line: number;
  raw: string;
  error: string;
};

export type NdjsonDecodeResult<T> =
  | { ok: true; line: number; value: T }
  | { ok: false; line: number; warning: NdjsonDecodeWarning };

export type NdjsonDecodeOptions<T> = {
  validate?: (value: unknown) => value is T;
  maxWarnings?: number;
};

export type NdjsonDecodeSummary<T> = {
  values: T[];
  warnings: NdjsonDecodeWarning[];
};

export type NdjsonStreamDecodeOptions<T> = NdjsonDecodeOptions<T> & {
  signal?: AbortSignal;
};

const DEFAULT_MAX_WARNINGS = 25;

/** Serializes one JSON-compatible value as an NDJSON record. */
export function encodeNdjsonRecord(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Serializes one capability trace event as an NDJSON record. */
export function encodeCapabilityEvent(event: CapabilityEvent): string {
  return encodeNdjsonRecord(event);
}

/** Runtime guard for the shared capability trace event envelope. */
export function isCapabilityEvent(value: unknown): value is CapabilityEvent {
  if (!isRecord(value)) return false;
  if (typeof value.type !== 'string') return false;
  if (typeof value.capabilityId !== 'string') return false;
  if (typeof value.timestamp !== 'string') return false;

  switch (value.type) {
    case 'step':
      return typeof value.role === 'string' && typeof value.content === 'string';
    case 'tool_call_start':
      return typeof value.toolName === 'string' && 'args' in value;
    case 'tool_call_end':
      return typeof value.toolName === 'string' && typeof value.durationMs === 'number';
    case 'model_usage':
      return typeof value.provider === 'string' && typeof value.model === 'string';
    case 'warning':
    case 'error':
      return typeof value.message === 'string';
    default:
      return false;
  }
}

/** Decodes one NDJSON line, returning a bounded warning shape instead of throwing. */
export function decodeNdjsonLine<T = unknown>(
  line: string,
  lineNumber: number,
  options: NdjsonDecodeOptions<T> = {},
): NdjsonDecodeResult<T> | null {
  const raw = line.trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (options.validate && !options.validate(parsed)) {
      return malformedLine(lineNumber, line, 'record failed validation');
    }
    return { ok: true, line: lineNumber, value: parsed as T };
  } catch (error) {
    return malformedLine(lineNumber, line, error instanceof Error ? error.message : String(error));
  }
}

/** Decodes a string containing complete NDJSON records into values and warnings. */
export function decodeNdjsonLines<T = unknown>(
  input: string,
  options: NdjsonDecodeOptions<T> = {},
): NdjsonDecodeSummary<T> {
  const values: T[] = [];
  const warnings: NdjsonDecodeWarning[] = [];
  const maxWarnings = options.maxWarnings ?? DEFAULT_MAX_WARNINGS;
  const lines = input.split(/\r?\n/);

  lines.forEach((line, index) => {
    const result = decodeNdjsonLine(line, index + 1, options);
    collectDecodeResult(result, values, warnings, maxWarnings);
  });

  return { values, warnings };
}

/** Decodes async NDJSON chunks while preserving partial lines across chunk boundaries. */
export async function* decodeNdjsonStream<T = unknown>(
  chunks: AsyncIterable<string | Uint8Array>,
  options: NdjsonStreamDecodeOptions<T> = {},
): AsyncGenerator<NdjsonDecodeResult<T>> {
  const decoder = new TextDecoder();
  let buffer = '';
  let lineNumber = 0;

  for await (const chunk of chunks) {
    options.signal?.throwIfAborted();
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });

    let newlineIndex = buffer.search(/\r?\n/);
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      const newlineLength = buffer[newlineIndex] === '\r' && buffer[newlineIndex + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(newlineIndex + newlineLength);
      lineNumber += 1;
      const result = decodeNdjsonLine(line, lineNumber, options);
      if (result) yield result;
      options.signal?.throwIfAborted();
      newlineIndex = buffer.search(/\r?\n/);
    }
  }

  const finalText = decoder.decode();
  if (finalText) buffer += finalText;
  if (buffer.trim()) {
    lineNumber += 1;
    const result = decodeNdjsonLine(buffer, lineNumber, options);
    if (result) yield result;
  }
}

/** Collects decoded async stream records into values and bounded malformed-line warnings. */
export async function collectNdjsonStream<T = unknown>(
  chunks: AsyncIterable<string | Uint8Array>,
  options: NdjsonStreamDecodeOptions<T> = {},
): Promise<NdjsonDecodeSummary<T>> {
  const values: T[] = [];
  const warnings: NdjsonDecodeWarning[] = [];
  const maxWarnings = options.maxWarnings ?? DEFAULT_MAX_WARNINGS;

  for await (const result of decodeNdjsonStream(chunks, options)) {
    collectDecodeResult(result, values, warnings, maxWarnings);
  }

  return { values, warnings };
}

/** Decodes complete capability event records from a string payload. */
export function decodeCapabilityEventLines(input: string): NdjsonDecodeSummary<CapabilityEvent> {
  return decodeNdjsonLines(input, { validate: isCapabilityEvent });
}

function collectDecodeResult<T>(
  result: NdjsonDecodeResult<T> | null,
  values: T[],
  warnings: NdjsonDecodeWarning[],
  maxWarnings: number,
): void {
  if (!result) return;
  if (result.ok) {
    values.push(result.value);
    return;
  }
  if (warnings.length < maxWarnings) warnings.push(result.warning);
}

function malformedLine(line: number, raw: string, error: string): NdjsonDecodeResult<never> {
  return {
    ok: false,
    line,
    warning: { type: 'malformed_line', line, raw, error },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
