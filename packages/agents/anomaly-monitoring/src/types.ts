export type Severity = 'critical' | 'warning' | 'info' | 'positive';

export type CategoryCoverage = 'full' | 'limited' | 'unavailable';

export type WorkspaceDescriptor = {
  projectId: string;
  projectName: string;
  events: { name: string; properties: string[]; eventCount: number }[];
  customerProperties: string[];
  catalogs: { id?: string; name: string }[];
  totalCustomers: number;
  totalEvents: number;
  oldestTimestamp: number | null;
  dataHorizon?: { from: string; to: string; durationDays: number };
};

export type AnomalyCategory = {
  id: string;
  label: string;
  requires: string[];
  enriches?: string[];
  whyItMatters: string;
  queryRecipe: string;
  thresholds: { critical: number; warning: number };
};

export type CategoryCoverageItem = {
  category: string;
  label: string;
  coverage: CategoryCoverage;
  missing?: string[];
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
