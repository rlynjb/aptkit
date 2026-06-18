import { parseAgentJson, type ModelProvider } from '@aptkit/runtime';
import { syntheticEcommerceWorkspace } from './fixture-data-source.js';
import type {
  AnomalyContextArgs,
  AnomalyContextResult,
  MetricTimeseriesArgs,
  MetricTimeseriesResult,
  ProjectOverview,
  SyntheticEcommerceDataSource,
} from './types.js';
import type { WorkspaceDescriptor } from '@aptkit/context';

export type OpenAISyntheticEcommerceDataSourceOptions = {
  model: ModelProvider;
  scenarioId?: string;
  workspace?: WorkspaceDescriptor;
  systemPrompt?: string;
};

/** Model-backed synthetic data source. Use with OpenAIModelProvider or any ModelProvider adapter. */
export class OpenAISyntheticEcommerceDataSource implements SyntheticEcommerceDataSource {
  readonly mode = 'openai' as const;
  readonly scenarioId: string;
  readonly workspace: WorkspaceDescriptor;
  private readonly model: ModelProvider;
  private readonly systemPrompt: string;

  constructor(options: OpenAISyntheticEcommerceDataSourceOptions) {
    this.model = options.model;
    this.scenarioId = options.scenarioId ?? 'sp-revenue-drop';
    this.workspace = options.workspace ?? syntheticEcommerceWorkspace;
    this.systemPrompt = options.systemPrompt ?? [
      'You generate synthetic ecommerce analytics tool results for AptKit.',
      'Return only JSON. Do not include prose or markdown fences.',
      'Keep outputs internally consistent for the requested scenario and workspace.',
      'Always include provider metadata: {"id":"synthetic-ecommerce","mode":"openai","scenarioId": string}.',
    ].join('\n');
  }

  async getProjectOverview(): Promise<ProjectOverview> {
    const value = await this.completeJson('get_project_overview', {});
    return assertProjectOverview(value, this.scenarioId);
  }

  async getMetricTimeseries(args: MetricTimeseriesArgs = {}): Promise<MetricTimeseriesResult> {
    const value = await this.completeJson('get_metric_timeseries', args);
    return assertMetricTimeseries(value, this.scenarioId);
  }

  async getAnomalyContext(args: AnomalyContextArgs = {}): Promise<AnomalyContextResult> {
    const value = await this.completeJson('get_anomaly_context', args);
    return assertAnomalyContext(value, this.scenarioId);
  }

  private async completeJson(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await this.model.complete({
      system: this.systemPrompt,
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            toolName,
            scenarioId: this.scenarioId,
            workspace: this.workspace,
            args,
          }),
        },
      ],
      maxTokens: 1400,
      temperature: 0.2,
    });
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    return parseAgentJson(text);
  }
}

function assertProjectOverview(value: unknown, scenarioId: string): ProjectOverview {
  const object = assertObject(value, 'project overview');
  if (!isObject(object.workspace)) throw new Error('project overview workspace is missing');
  return {
    provider: providerMetadata(object.provider, scenarioId, 'openai'),
    workspace: object.workspace as unknown as WorkspaceDescriptor,
    highlights: stringArray(object.highlights, 'highlights'),
  };
}

function assertMetricTimeseries(value: unknown, scenarioId: string): MetricTimeseriesResult {
  const object = assertObject(value, 'metric timeseries');
  const comparison = assertObject(object.periodComparison, 'periodComparison');
  return {
    provider: providerMetadata(object.provider, scenarioId, 'openai'),
    periodComparison: {
      metric: stringValue(comparison.metric, 'periodComparison.metric'),
      dimension: stringValue(comparison.dimension, 'periodComparison.dimension'),
      segment: stringValue(comparison.segment, 'periodComparison.segment'),
      recentWindow: timeRange(comparison.recentWindow, 'periodComparison.recentWindow'),
      baselineWindow: timeRange(comparison.baselineWindow, 'periodComparison.baselineWindow'),
      recentValue: numberValue(comparison.recentValue, 'periodComparison.recentValue'),
      baselineAverage: numberValue(comparison.baselineAverage, 'periodComparison.baselineAverage'),
      pctChange: numberValue(comparison.pctChange, 'periodComparison.pctChange'),
      relatedSegments: relatedSegments(comparison.relatedSegments),
    },
    points: metricPoints(object.points),
    totalCount: numberValue(object.totalCount, 'totalCount'),
  };
}

function assertAnomalyContext(value: unknown, scenarioId: string): AnomalyContextResult {
  const object = assertObject(value, 'anomaly context');
  const summary = assertObject(object.anomaly_summary, 'anomaly_summary');
  return {
    provider: providerMetadata(object.provider, scenarioId, 'openai'),
    anomaly_summary: {
      metric: stringValue(summary.metric, 'anomaly_summary.metric'),
      segment: stringValue(summary.segment, 'anomaly_summary.segment'),
      anomaly_value: numberValue(summary.anomaly_value, 'anomaly_summary.anomaly_value'),
      baseline_avg: numberValue(summary.baseline_avg, 'anomaly_summary.baseline_avg'),
      pct_change: numberValue(summary.pct_change, 'anomaly_summary.pct_change'),
    },
    related_segments: relatedSegments(object.related_segments).map((segment) => ({
      name: segment.name,
      pct_change: segment.pctChange,
    })),
    drivers: arrayValue(object.drivers, 'drivers').map((driver, index) => {
      const objectDriver = assertObject(driver, `drivers.${index}`);
      return {
        name: stringValue(objectDriver.name, `drivers.${index}.name`),
        contribution: numberValue(objectDriver.contribution, `drivers.${index}.contribution`),
        detail: stringValue(objectDriver.detail, `drivers.${index}.detail`),
      };
    }),
    sample_orders: arrayValue(object.sample_orders, 'sample_orders').map((order, index) => {
      const objectOrder = assertObject(order, `sample_orders.${index}`);
      return {
        order_id: stringValue(objectOrder.order_id, `sample_orders.${index}.order_id`),
        purchase_ts: stringValue(objectOrder.purchase_ts, `sample_orders.${index}.purchase_ts`),
        status: stringValue(objectOrder.status, `sample_orders.${index}.status`),
        price_brl: numberValue(objectOrder.price_brl, `sample_orders.${index}.price_brl`),
      };
    }),
  };
}

function providerMetadata(value: unknown, scenarioId: string, mode: 'openai') {
  const provider = isObject(value) ? value : {};
  return {
    id: 'synthetic-ecommerce' as const,
    mode,
    scenarioId: typeof provider.scenarioId === 'string' ? provider.scenarioId : scenarioId,
  };
}

function relatedSegments(value: unknown): { name: string; pctChange: number }[] {
  return arrayValue(value, 'relatedSegments').map((segment, index) => {
    const object = assertObject(segment, `relatedSegments.${index}`);
    return {
      name: stringValue(object.name, `relatedSegments.${index}.name`),
      pctChange: numberValue(object.pctChange ?? object.pct_change, `relatedSegments.${index}.pctChange`),
    };
  });
}

function metricPoints(value: unknown) {
  return arrayValue(value, 'points').map((point, index) => {
    const object = assertObject(point, `points.${index}`);
    return {
      ts: stringValue(object.ts, `points.${index}.ts`),
      segment: stringValue(object.segment, `points.${index}.segment`),
      value: numberValue(object.value, `points.${index}.value`),
    };
  });
}

function timeRange(value: unknown, path: string) {
  const object = assertObject(value, path);
  return {
    from: stringValue(object.from, `${path}.from`),
    to: stringValue(object.to, `${path}.to`),
  };
}

function assertObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${path} must be an object`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  return arrayValue(value, path).map((item, index) => stringValue(item, `${path}.${index}`));
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  return value;
}

function numberValue(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be a number`);
  return value;
}
