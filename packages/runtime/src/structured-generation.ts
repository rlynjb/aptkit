import { timestamp, type CapabilityTraceSink } from './events.js';
import { parseValidatedJson, type JsonValidator } from './json-output.js';
import type { ModelMessage, ModelProvider, ModelResponse } from './model-provider.js';

export type StructuredGenerationAttempt = {
  attempt: number;
  rawText?: string;
  error?: string;
};

export type StructuredGenerationSuccess<T> = {
  ok: true;
  value: T;
  rawText: string;
  attempts: StructuredGenerationAttempt[];
};

export type StructuredGenerationFailure = {
  ok: false;
  error: string;
  attempts: StructuredGenerationAttempt[];
};

export type StructuredGenerationResult<T> =
  | StructuredGenerationSuccess<T>
  | StructuredGenerationFailure;

export type StructuredGenerationRetryOptions = {
  maxAttempts?: number;
  strictSuffix?: string;
};

export type GenerateStructuredOptions<T> = {
  capabilityId: string;
  model: ModelProvider;
  validate: JsonValidator<T>;
  system?: string;
  messages?: ModelMessage[];
  userPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  retry?: StructuredGenerationRetryOptions;
  trace?: CapabilityTraceSink;
  signal?: AbortSignal;
};

const DEFAULT_STRICT_SUFFIX = '\n\nReturn ONLY valid JSON - no prose, no markdown fences.';

/**
 * Runs a JSON-producing model prompt with bounded parse/validation retries.
 * This is the provider-neutral version of Dryrun's on-device JSON pipeline:
 * generate, extract JSON, validate, retry once with a strict JSON-only nudge.
 */
export async function generateStructured<T>(
  options: GenerateStructuredOptions<T>,
): Promise<StructuredGenerationResult<T>> {
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 2);
  const strictSuffix = options.retry?.strictSuffix ?? DEFAULT_STRICT_SUFFIX;
  const baseMessages = normalizeMessages(options);
  const attempts: StructuredGenerationAttempt[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    const messages = attempt === 1 ? baseMessages : appendStrictSuffix(baseMessages, strictSuffix);

    let response: ModelResponse;
    try {
      response = await options.model.complete({
        system: options.system,
        messages,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        signal: options.signal,
      });
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ attempt, error: message });
      emitWarning(options, `structured generation model call failed on attempt ${attempt}: ${message}`);
      return { ok: false, error: message, attempts };
    }

    emitUsage(options, response);
    const rawText = textFromResponse(response);
    const parsed = parseValidatedJson(rawText, options.validate);

    if (parsed.ok) {
      attempts.push({ attempt, rawText });
      return { ok: true, value: parsed.value, rawText, attempts };
    }

    attempts.push({ attempt, rawText, error: parsed.error });
    if (attempt < maxAttempts) {
      emitWarning(options, `structured generation validation failed on attempt ${attempt}: ${parsed.error}`);
    }
  }

  const error = attempts[attempts.length - 1]?.error ?? 'structured generation failed';
  emitError(options, `structured generation failed after ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'}: ${error}`);
  return { ok: false, error, attempts };
}

function normalizeMessages<T>(options: GenerateStructuredOptions<T>): ModelMessage[] {
  if (options.messages?.length) return [...options.messages];
  if (options.userPrompt !== undefined) return [{ role: 'user', content: options.userPrompt }];
  throw new Error('generateStructured requires messages or userPrompt');
}

function appendStrictSuffix(messages: ModelMessage[], strictSuffix: string): ModelMessage[] {
  const next = [...messages];

  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index];
    if (message.role === 'user' && typeof message.content === 'string') {
      next[index] = { ...message, content: `${message.content}${strictSuffix}` };
      return next;
    }
  }

  next.push({ role: 'user', content: strictSuffix.trim() });
  return next;
}

function textFromResponse(response: ModelResponse): string {
  return response.content
    .filter((block): block is Extract<ModelResponse['content'][number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function emitUsage<T>(options: GenerateStructuredOptions<T>, response: ModelResponse): void {
  if (!response.usage) return;
  options.trace?.emit({
    type: 'model_usage',
    capabilityId: options.capabilityId,
    provider: options.model.id,
    model: response.model ?? options.model.defaultModel ?? 'unknown',
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    estimated: response.usage.estimated,
    timestamp: timestamp(),
  });
}

function emitWarning<T>(options: GenerateStructuredOptions<T>, message: string): void {
  options.trace?.emit({
    type: 'warning',
    capabilityId: options.capabilityId,
    message,
    timestamp: timestamp(),
  });
}

function emitError<T>(options: GenerateStructuredOptions<T>, message: string): void {
  options.trace?.emit({
    type: 'error',
    capabilityId: options.capabilityId,
    message,
    timestamp: timestamp(),
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError';
}
