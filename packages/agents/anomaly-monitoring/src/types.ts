export type { WorkspaceDescriptor } from '@aptkit/context';
export type {
  CoverageLevel as CategoryCoverage,
  CoverageReportItem as CategoryCoverageItem,
  CoverageRequirement,
} from '@aptkit/tools';

export type Severity = 'critical' | 'warning' | 'info' | 'positive';

export type AnomalyCategory = {
  id: string;
  label: string;
  requires: readonly string[];
  enriches?: readonly string[];
  whyItMatters: string;
  queryRecipe: string;
  thresholds: { critical: number; warning: number };
};

export type Anomaly = {
  metric: string;
  scope: string[];
  change: { value: number; direction: 'up' | 'down'; baseline: string };
  severity: Severity;
  evidence: { tool: string; result: unknown }[];
  impact?: string;
  history?: number[];
  category?: string;
};
