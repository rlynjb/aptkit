import type { WorkspaceDescriptor } from '@aptkit/context';
import type {
  AnomalyContextArgs,
  AnomalyContextResult,
  MetricTimeseriesArgs,
  MetricTimeseriesResult,
  ProjectOverview,
  SyntheticEcommerceDataSource,
} from './types.js';

const DEFAULT_RECENT_WINDOW = { from: '2026-05-04', to: '2026-06-01' };
const DEFAULT_BASELINE_WINDOW = { from: '2026-02-09', to: '2026-05-04' };

export const syntheticEcommerceWorkspace: WorkspaceDescriptor = {
  projectId: 'synthetic-ecommerce',
  projectName: 'Synthetic ecommerce analytics workspace',
  events: [
    { name: 'purchase', properties: ['state', 'category', 'payment_type', 'total_price'], eventCount: 50000 },
    { name: 'session_start', properties: ['utm_source', 'device'], eventCount: 80000 },
    { name: 'checkout', properties: ['state', 'payment_type'], eventCount: 35000 },
    { name: 'view_item', properties: ['category'], eventCount: 120000 },
  ],
  customerProperties: ['state', 'city', 'loyalty_tier'],
  catalogs: [{ id: 'products', name: 'Products' }],
  totalCustomers: 125000,
  totalEvents: 285000,
  oldestTimestamp: Date.UTC(2025, 11, 1),
  dataHorizon: { from: '2025-12-01', to: '2026-06-01', durationDays: 182 },
};

export type FixtureSyntheticEcommerceDataSourceOptions = {
  scenarioId?: string;
  workspace?: WorkspaceDescriptor;
};

/** Deterministic synthetic ecommerce data source for Studio, tests, and repeatable demos. */
export class FixtureSyntheticEcommerceDataSource implements SyntheticEcommerceDataSource {
  readonly mode = 'fixture' as const;
  readonly scenarioId: string;
  readonly workspace: WorkspaceDescriptor;

  constructor(options: FixtureSyntheticEcommerceDataSourceOptions = {}) {
    this.scenarioId = options.scenarioId ?? 'sp-revenue-drop';
    this.workspace = options.workspace ?? syntheticEcommerceWorkspace;
  }

  getProjectOverview(): ProjectOverview {
    return {
      provider: this.providerMetadata(),
      workspace: this.workspace,
      highlights: [
        'SP revenue is down 30.0245% over the recent four-week window.',
        'RJ and MG remain approximately flat, making the movement region-specific.',
        'The fixture is deterministic and safe for replay promotion.',
      ],
    };
  }

  getMetricTimeseries(args: MetricTimeseriesArgs = {}): MetricTimeseriesResult {
    const metric = args.metric ?? 'revenue';
    const dimension = args.dimension ?? 'state';
    const segment = args.segment ?? 'SP';
    const recentWindow = requiredRange(args.time_range, DEFAULT_RECENT_WINDOW);

    return {
      provider: this.providerMetadata(),
      periodComparison: {
        metric,
        dimension,
        segment,
        recentWindow,
        baselineWindow: DEFAULT_BASELINE_WINDOW,
        recentValue: 28550000,
        baselineAverage: 40800000,
        pctChange: -0.300245,
        relatedSegments: [
          { name: 'RJ', pctChange: -0.02 },
          { name: 'MG', pctChange: 0.01 },
        ],
      },
      points: [
        { ts: '2026-05-04', segment: 'SP', value: 7400000 },
        { ts: '2026-05-11', segment: 'SP', value: 7200000 },
        { ts: '2026-05-18', segment: 'SP', value: 7050000 },
        { ts: '2026-05-25', segment: 'SP', value: 6900000 },
        { ts: '2026-05-04', segment: 'RJ', value: 4300000 },
        { ts: '2026-05-11', segment: 'RJ', value: 4350000 },
        { ts: '2026-05-04', segment: 'MG', value: 3900000 },
        { ts: '2026-05-11', segment: 'MG', value: 3940000 },
      ],
      totalCount: 4200,
    };
  }

  getAnomalyContext(args: AnomalyContextArgs = {}): AnomalyContextResult {
    const metric = args.metric ?? 'revenue';
    const segment = args.segment ?? 'SP';

    return {
      provider: this.providerMetadata(),
      anomaly_summary: {
        metric,
        segment,
        anomaly_value: 28550000,
        baseline_avg: 40800000,
        pct_change: -0.300245,
      },
      related_segments: [
        { name: 'RJ', pct_change: -0.02 },
        { name: 'MG', pct_change: 0.01 },
      ],
      drivers: [
        {
          name: 'electronics',
          contribution: -0.62,
          detail: 'Electronics orders in SP account for most of the recent revenue loss.',
        },
        {
          name: 'paid_search',
          contribution: -0.21,
          detail: 'Paid search sessions declined during the same window.',
        },
      ],
      sample_orders: [
        { order_id: 'syn-sp-101', purchase_ts: '2026-05-10', status: 'delivered', price_brl: 42000 },
        { order_id: 'syn-sp-102', purchase_ts: '2026-05-23', status: 'delivered', price_brl: 31000 },
      ],
    };
  }

  private providerMetadata() {
    return {
      id: 'synthetic-ecommerce' as const,
      mode: this.mode,
      scenarioId: this.scenarioId,
    };
  }
}

function requiredRange(input: { from?: string; to?: string } | undefined, fallback: { from: string; to: string }) {
  return {
    from: input?.from ?? fallback.from,
    to: input?.to ?? fallback.to,
  };
}
