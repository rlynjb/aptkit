import {
  parseAgentJson,
  type ModelContentBlock,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from '@aptkit/runtime';

/** Non-streaming response shape from Ollama's POST /api/chat. */
export type OllamaChatResponse = {
  model?: string;
  message?: { role?: string; content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
};

/** Injectable transport to Ollama's /api/chat — lets tests feed recorded responses. */
export type GemmaChatTransport = (payload: {
  model: string;
  messages: { role: string; content: string }[];
  stream: false;
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<OllamaChatResponse>;

export type GemmaModelProviderOptions = {
  model?: string;
  host?: string;
  chat?: GemmaChatTransport;
  /** How many times to ask Gemma for a tool call before falling back to text. Default 2. */
  maxToolCallAttempts?: number;
};

const RETRY_NUDGE =
  'Your previous reply was not a valid tool call. Respond with ONLY a single JSON object: ' +
  '{"tool": "<tool name>", "arguments": { ...arguments... }}';

export class GemmaModelProvider implements ModelProvider {
  readonly id = 'gemma';
  readonly defaultModel: string;
  private readonly chat: GemmaChatTransport;
  private readonly maxToolCallAttempts: number;
  private toolUseCount = 0;

  constructor(options: GemmaModelProviderOptions = {}) {
    this.defaultModel = options.model ?? 'gemma2:9b';
    this.chat = options.chat ?? defaultHttpTransport(options.host ?? 'http://localhost:11434');
    this.maxToolCallAttempts = Math.max(1, options.maxToolCallAttempts ?? 2);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal?.throwIfAborted();

    const baseMessages = this.buildMessages(request);
    const wantsTool = Boolean(request.tools?.length);
    const maxAttempts = wantsTool ? this.maxToolCallAttempts : 1;

    let lastResponse: OllamaChatResponse = {};
    let raw = '';

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      request.signal?.throwIfAborted();

      // On a retry, append a corrective nudge so Gemma fixes its JSON.
      const messages =
        attempt === 0 ? baseMessages : [...baseMessages, { role: 'user', content: RETRY_NUDGE }];

      lastResponse = await this.chat({
        model: this.defaultModel,
        messages,
        stream: false,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      raw = lastResponse.message?.content ?? '';

      if (wantsTool) {
        const call = parseToolCall(raw);
        if (call) {
          return this.toResponse(
            [{ type: 'tool_use', id: this.nextToolUseId(call.name), name: call.name, input: call.input }],
            lastResponse,
          );
        }
        // Only retry if it looked like a botched tool call; plain prose is a real answer.
        if (looksLikeToolAttempt(raw)) continue;
      }
      break;
    }

    return this.toResponse([{ type: 'text', text: raw }], lastResponse);
  }

  private buildMessages(request: ModelRequest): { role: string; content: string }[] {
    const messages: { role: string; content: string }[] = [];
    const system = buildSystemText(request);
    if (system) messages.push({ role: 'system', content: system });
    for (const message of request.messages) {
      messages.push({
        role: message.role,
        content:
          typeof message.content === 'string'
            ? message.content
            : flattenContent(message.content),
      });
    }
    return messages;
  }

  private nextToolUseId(name: string): string {
    const id = `gemma-${name}-${this.toolUseCount}`;
    this.toolUseCount += 1;
    return id;
  }

  private toResponse(content: ModelContentBlock[], response: OllamaChatResponse): ModelResponse {
    return {
      content,
      ...(response.model ? { model: response.model } : {}),
      usage: {
        inputTokens: response.prompt_eval_count,
        outputTokens: response.eval_count,
        estimated: false,
      },
    };
  }
}

/**
 * Outbound half of tool-call emulation: Gemma can't take a native `tools`
 * array, so render the tools into the system text and demand a JSON tool call.
 */
function buildSystemText(request: ModelRequest): string {
  const parts: string[] = [];
  if (request.system) parts.push(request.system);

  if (request.tools?.length) {
    const rendered = request.tools
      .map((tool) =>
        JSON.stringify(
          {
            name: tool.name,
            description: tool.description ?? '',
            input_schema: tool.inputSchema,
          },
          null,
          2,
        ),
      )
      .join('\n\n');
    parts.push(
      [
        'You can call the following tools:',
        '',
        rendered,
        '',
        'When a tool is needed, respond with ONLY a single JSON object, no prose:',
        '{"tool": "<tool name>", "arguments": { ...arguments... }}',
        'Otherwise, answer the user directly in natural language.',
      ].join('\n'),
    );
  }

  return parts.join('\n\n');
}

/** messy model text -> { name, input } of a tool call, or null when it isn't one. */
function parseToolCall(text: string): { name: string; input: Record<string, unknown> } | null {
  let parsed: unknown;
  try {
    parsed = parseAgentJson(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const name = obj.tool ?? obj.name ?? obj.tool_name;
  const input = obj.arguments ?? obj.input ?? obj.args;
  if (typeof name !== 'string') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { name, input: input as Record<string, unknown> };
}

/** Did the model try (and fail) to emit a tool call? A '{' is the cheap tell. */
function looksLikeToolAttempt(text: string): boolean {
  return text.includes('{');
}

function flattenContent(content: Exclude<ModelMessage['content'], string>): string {
  return content
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'tool_use') {
        return JSON.stringify({ tool: block.name, arguments: block.input });
      }
      return block.content;
    })
    .join('\n');
}

function defaultHttpTransport(host: string): GemmaChatTransport {
  const base = host.replace(/\/$/, '');
  return async ({ signal, ...payload }) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as OllamaChatResponse;
  };
}
