export type Severity = 'critical' | 'warning' | 'info' | 'positive';

export type WorkspaceDescriptor = {
  projectId: string;
  projectName: string;
  events: { name: string; properties: string[]; eventCount: number }[];
  customerProperties: string[];
  catalogs: { id: string; name: string }[];
  totalCustomers: number;
  totalEvents: number;
  oldestTimestamp: number | null;
  dataHorizon?: { from: string; to: string; durationDays: number };
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

export type Diagnosis = {
  conclusion: string;
  evidence: string[];
  hypothesesConsidered: { hypothesis: string; supported: boolean; reasoning: string }[];
  affectedCustomers?: { count: number; segmentDescription: string };
  confidence?: 'high' | 'medium' | 'low';
  timeSeries?: { day: string; value: number }[];
};

export type ActionFeature = 'scenario' | 'segment' | 'campaign' | 'voucher' | 'experiment';

export type EstimatedImpact =
  | string
  | { range: string; rangeUsd?: { low: number; high: number }; assumption: string };

export type Recommendation = {
  id: string;
  title: string;
  rationale: string;
  bloomreachFeature: ActionFeature;
  steps: string[];
  estimatedImpact: EstimatedImpact;
  confidence: 'high' | 'medium' | 'low';
  effort?: 'low' | 'medium' | 'high';
  timeToSetUpMinutes?: number;
  readResultInDays?: number;
  prerequisites?: { label: string; satisfied: boolean }[];
  successMetric?: string;
};

export type IdlessRecommendation = Omit<Recommendation, 'id'>;

export type ActionTaxonomy = {
  features: readonly ActionFeature[];
};

export const DEFAULT_ACTION_TAXONOMY: ActionTaxonomy = {
  features: ['scenario', 'segment', 'campaign', 'voucher', 'experiment'],
};
