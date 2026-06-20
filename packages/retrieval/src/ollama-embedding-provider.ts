import type { EmbeddingProvider } from './contracts.js';

/** Non-streaming response shape from Ollama's POST /api/embed. */
export type OllamaEmbedResponse = {
  model?: string;
  embeddings?: number[][];
};

/** Per-call controls passed into a transport. */
export type EmbedCallOptions = {
  signal?: AbortSignal;
};

/**
 * Injectable transport to Ollama's /api/embed — lets tests feed deterministic
 * vectors so unit tests need NO live Ollama. Mirrors `GemmaChatTransport`.
 */
export type EmbedTransport = (payload: {
  model: string;
  texts: string[];
  signal?: AbortSignal;
}) => Promise<number[][]>;

export type OllamaEmbeddingProviderOptions = {
  model?: string;
  host?: string;
  embed?: EmbedTransport;
};

/**
 * `EmbeddingProvider` for `nomic-embed-text` served locally via Ollama.
 *
 * Transport-injectable: pass `embed` to feed recorded/deterministic vectors in
 * tests; the default uses `fetch` against `host` (http://localhost:11434). The
 * 768-dim is fixed by nomic — a corpus indexed here can only be queried by a
 * 768-dim provider (the dimension one-way door).
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'nomic-embed-text';
  readonly dimension = 768;
  private readonly model: string;
  private readonly embedTransport: EmbedTransport;

  constructor(options: OllamaEmbeddingProviderOptions = {}) {
    this.model = options.model ?? 'nomic-embed-text';
    this.embedTransport =
      options.embed ?? defaultHttpTransport(options.host ?? 'http://localhost:11434');
  }

  async embed(texts: string[], options?: EmbedCallOptions): Promise<number[][]> {
    options?.signal?.throwIfAborted();
    return this.embedTransport({
      model: this.model,
      texts,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }
}

function defaultHttpTransport(host: string): EmbedTransport {
  const base = host.replace(/\/$/, '');
  return async ({ signal, ...payload }) => {
    const res = await fetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: payload.model, input: payload.texts }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as OllamaEmbedResponse;
    return json.embeddings ?? [];
  };
}
