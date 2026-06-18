import type { WorkspaceDescriptor } from '@aptkit/context';

export type SyntheticProviderMode = 'fixture' | 'openai';

export type TimeRange = {
  from?: string;
  to?: string;
};

export type ProjectOverview = {
  provider: {
    id: 'synthetic-ecommerce';
    mode: SyntheticProviderMode;
    scenarioId: string;
  };
  workspace: WorkspaceDescriptor;
  highlights: string[];
};

export type MetricTimeseriesArgs = {
  metric?: string;
  dimension?: string;
  segment?: string;
  time_range?: TimeRange;
  granularity?: 'day' | 'week' | 'month' | string;
};

export type MetricPoint = {
  ts: string;
  segment: string;
  value: number;
};

export type MetricTimeseriesResult = {
  provider: {
    id: 'synthetic-ecommerce';
    mode: SyntheticProviderMode;
    scenarioId: string;
  };
  periodComparison: {
    metric: string;
    dimension: string;
    segment: string;
    recentWindow: Required<TimeRange>;
    baselineWindow: Required<TimeRange>;
    recentValue: number;
    baselineAverage: number;
    pctChange: number;
    relatedSegments: { name: string; pctChange: number }[];
  };
  points: MetricPoint[];
  totalCount: number;
};

export type AnomalyContextArgs = {
  metric?: string;
  dimension?: string;
  segment?: string;
  anomaly_window?: TimeRange;
  baseline_window?: TimeRange;
};

export type AnomalyContextResult = {
  provider: {
    id: 'synthetic-ecommerce';
    mode: SyntheticProviderMode;
    scenarioId: string;
  };
  anomaly_summary: {
    metric: string;
    segment: string;
    anomaly_value: number;
    baseline_avg: number;
    pct_change: number;
  };
  related_segments: { name: string; pct_change: number }[];
  drivers: { name: string; contribution: number; detail: string }[];
  sample_orders: { order_id: string; purchase_ts: string; status: string; price_brl: number }[];
};

export type SyntheticEcommerceDataSource = {
  readonly mode: SyntheticProviderMode;
  readonly scenarioId: string;
  readonly workspace: WorkspaceDescriptor;
  getProjectOverview(): Promise<ProjectOverview> | ProjectOverview;
  getMetricTimeseries(args?: MetricTimeseriesArgs): Promise<MetricTimeseriesResult> | MetricTimeseriesResult;
  getAnomalyContext(args?: AnomalyContextArgs): Promise<AnomalyContextResult> | AnomalyContextResult;
};
