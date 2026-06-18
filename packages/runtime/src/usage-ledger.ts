import type { CapabilityEvent } from './events.js';

export type TokenUsageSummary = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelName?: string;
  turns: number;
  estimated: boolean;
};

export type CostEstimate = {
  currency: 'USD';
  inputCost: number;
  outputCost: number;
  totalCost: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  estimated: true;
};

export type UsagePricing = Pick<CostEstimate, 'inputUsdPerMillion' | 'outputUsdPerMillion'>;

/** Sums model usage trace events into one provider-neutral usage ledger row. */
export function summarizeUsage(trace: readonly CapabilityEvent[]): TokenUsageSummary {
  return trace.reduce<TokenUsageSummary>(
    (summary, event) => {
      if (event.type !== 'model_usage') return summary;
      const inputTokens = event.inputTokens ?? 0;
      const outputTokens = event.outputTokens ?? 0;
      return {
        inputTokens: summary.inputTokens + inputTokens,
        outputTokens: summary.outputTokens + outputTokens,
        totalTokens: summary.totalTokens + inputTokens + outputTokens,
        modelName: event.model || summary.modelName,
        turns: summary.turns + 1,
        estimated: summary.estimated || event.estimated === true,
      };
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelName: '', turns: 0, estimated: false },
  );
}

/** Counts model turns from a trace without requiring token fields to be present. */
export function modelTurnCount(trace: readonly CapabilityEvent[]): number {
  return trace.filter((event) => event.type === 'model_usage').length;
}

/** Estimates USD cost from usage and known provider/model pricing. */
export function estimateCost(
  provider: string,
  usage: Pick<TokenUsageSummary, 'inputTokens' | 'outputTokens'>,
  modelName: string,
): CostEstimate | undefined {
  const pricing = pricingForModel(provider, modelName);
  if (!pricing) return undefined;
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputUsdPerMillion;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
  return {
    currency: 'USD',
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    inputUsdPerMillion: pricing.inputUsdPerMillion,
    outputUsdPerMillion: pricing.outputUsdPerMillion,
    estimated: true,
  };
}

/** Returns the currently configured per-million-token pricing for known model families. */
export function pricingForModel(provider: string, modelName: string): UsagePricing | undefined {
  if (provider !== 'openai') return undefined;
  const normalized = modelName.toLowerCase();
  if (normalized.startsWith('gpt-4.1-nano')) return { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 };
  if (normalized.startsWith('gpt-4.1-mini')) return { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 };
  if (normalized.startsWith('gpt-4.1')) return { inputUsdPerMillion: 2, outputUsdPerMillion: 8 };
  return undefined;
}

/** Formats estimated costs for compact Studio and replay-summary displays. */
export function formatCost(costEstimate: CostEstimate | undefined): string {
  if (!costEstimate) return 'n/a';
  if (costEstimate.totalCost === 0) return '$0.00';
  if (costEstimate.totalCost < 0.01) return `$${costEstimate.totalCost.toFixed(4)}`;
  return `$${costEstimate.totalCost.toFixed(2)}`;
}
