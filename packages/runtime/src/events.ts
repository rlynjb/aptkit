export type CapabilityEvent =
  | { type: 'step'; capabilityId: string; role: string; content: string; timestamp: string }
  | { type: 'tool_call_start'; capabilityId: string; toolName: string; args: unknown; timestamp: string }
  | {
      type: 'tool_call_end';
      capabilityId: string;
      toolName: string;
      result?: unknown;
      error?: string;
      durationMs: number;
      timestamp: string;
    }
  | {
      type: 'model_usage';
      capabilityId: string;
      provider: string;
      model: string;
      inputTokens?: number;
      outputTokens?: number;
      estimated?: boolean;
      timestamp: string;
    }
  | { type: 'warning'; capabilityId: string; message: string; timestamp: string }
  | { type: 'error'; capabilityId: string; message: string; timestamp: string };

export type CapabilityTraceSink = {
  emit(event: CapabilityEvent): void;
};

export function timestamp(): string {
  return new Date().toISOString();
}
