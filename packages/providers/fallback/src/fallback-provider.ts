import { timestamp, type CapabilityTraceSink, type ModelProvider, type ModelRequest, type ModelResponse } from '@aptkit/runtime';

export type FallbackAttempt = {
  providerId: string;
  model?: string;
  error: string;
};

export type FallbackModelProviderOptions = {
  providers: readonly ModelProvider[];
  capabilityId?: string;
  trace?: CapabilityTraceSink;
  shouldFallback?: (error: unknown, provider: ModelProvider) => boolean;
};

export class ProviderFallbackError extends Error {
  readonly attempts: readonly FallbackAttempt[];

  constructor(attempts: readonly FallbackAttempt[]) {
    super(`all model providers failed: ${attempts.map((attempt) => `${attempt.providerId}: ${attempt.error}`).join('; ')}`);
    this.name = 'ProviderFallbackError';
    this.attempts = attempts;
  }
}

/** ModelProvider that tries provider adapters in order and records failed attempts. */
export class FallbackModelProvider implements ModelProvider {
  readonly id = 'fallback';
  readonly defaultModel?: string;
  lastSelectedProvider?: { providerId: string; model?: string };
  private readonly providers: readonly ModelProvider[];
  private readonly capabilityId: string;
  private readonly trace?: CapabilityTraceSink;
  private readonly shouldFallback: (error: unknown, provider: ModelProvider) => boolean;

  constructor(options: FallbackModelProviderOptions) {
    if (options.providers.length === 0) {
      throw new Error('FallbackModelProvider requires at least one provider');
    }
    this.providers = options.providers;
    this.defaultModel = options.providers[0]?.defaultModel;
    this.capabilityId = options.capabilityId ?? 'provider-fallback-chain';
    this.trace = options.trace;
    this.shouldFallback = options.shouldFallback ?? (() => true);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const attempts: FallbackAttempt[] = [];

    for (let index = 0; index < this.providers.length; index += 1) {
      const provider = this.providers[index];
      request.signal?.throwIfAborted();

      try {
        const response = await provider.complete(request);
        this.lastSelectedProvider = {
          providerId: provider.id,
          model: response.model ?? provider.defaultModel,
        };
        return {
          ...response,
          model: response.model ?? provider.defaultModel,
        };
      } catch (error) {
        if (isAbortError(error) || request.signal?.aborted) throw error;
        const attempt = {
          providerId: provider.id,
          model: provider.defaultModel,
          error: error instanceof Error ? error.message : String(error),
        };
        attempts.push(attempt);

        if (!this.shouldFallback(error, provider)) {
          throw error;
        }

        if (index < this.providers.length - 1) {
          this.trace?.emit({
            type: 'warning',
            capabilityId: this.capabilityId,
            message: `Provider ${provider.id} failed (${attempt.error}); trying fallback provider.`,
            timestamp: timestamp(),
          });
        }
      }
    }

    throw new ProviderFallbackError(attempts);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError';
}
