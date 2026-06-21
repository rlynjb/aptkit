import type { Anomaly, Diagnosis, Recommendation } from '@aptkit/agent-recommendation';
import type { Anomaly as MonitoringAnomaly } from '@aptkit/agent-anomaly-monitoring';
import type { Anomaly as DiagnosticAnomaly, Diagnosis as DiagnosticDiagnosis } from '@aptkit/agent-diagnostic-investigation';
import type { Intent as QueryIntent } from '@aptkit/agent-query';
import type { RubricDefinition, RubricImprovementResult } from '@aptkit/agent-rubric-improvement';
import type { WorkspaceDescriptor } from '@aptkit/context';
import type { CapabilityEvent, CostEstimate, ModelResponse, TokenUsageSummary } from '@aptkit/runtime';
import type { ToolDefinition } from '@aptkit/tools';

export type FixtureTool = ToolDefinition & { result: unknown };

export type RecommendationFixture = {
  id: string;
  description: string;
  workspace: WorkspaceDescriptor;
  anomaly: Anomaly;
  diagnosis: Diagnosis;
  tools: FixtureTool[];
  modelResponses: ModelResponse[];
};

export type MonitoringFixture = {
  id: string;
  description: string;
  workspace: WorkspaceDescriptor;
  tools: FixtureTool[];
  modelResponses: ModelResponse[];
};

export type DiagnosticFixture = {
  id: string;
  description: string;
  workspace: WorkspaceDescriptor;
  anomaly: DiagnosticAnomaly;
  tools: FixtureTool[];
  modelResponses: ModelResponse[];
};

export type QueryFixture = {
  id: string;
  description: string;
  question: string;
  intent: QueryIntent;
  workspace: WorkspaceDescriptor;
  tools: FixtureTool[];
  modelResponses: ModelResponse[];
};

export type RubricImprovementFixture = {
  id: string;
  description: string;
  rubric: RubricDefinition;
  subject: string;
  context: Record<string, string>;
  tools: FixtureTool[];
  modelResponses: ModelResponse[];
};

export type ReplayState = {
  recommendations: Recommendation[];
  trace: CapabilityEvent[];
  evalOk: boolean;
  evalIssueDetails: { path: string; message: string }[];
  evalIssues: string[];
  modelTurns: number;
  durationMs: number;
  completedAt: string;
  runId: number;
  savedPath?: string;
};

export type ReplayResult = Omit<ReplayState, 'completedAt' | 'runId'>;

export type MonitoringReplayState = {
  anomalies: MonitoringAnomaly[];
  trace: CapabilityEvent[];
  evalOk: boolean;
  evalIssueDetails: { path: string; message: string }[];
  evalIssues: string[];
  modelTurns: number;
  durationMs: number;
  completedAt: string;
  runId: number;
  savedPath?: string;
};

export type MonitoringReplayResult = Omit<MonitoringReplayState, 'completedAt' | 'runId'>;

export type DiagnosticReplayState = {
  diagnosis: DiagnosticDiagnosis;
  trace: CapabilityEvent[];
  evalOk: boolean;
  evalIssueDetails: { path: string; message: string }[];
  evalIssues: string[];
  modelTurns: number;
  durationMs: number;
  completedAt: string;
  runId: number;
  savedPath?: string;
};

export type DiagnosticReplayResult = Omit<DiagnosticReplayState, 'completedAt' | 'runId'>;

export type QueryReplayState = {
  answer: string;
  trace: CapabilityEvent[];
  evalOk: boolean;
  evalIssueDetails: { path: string; message: string }[];
  evalIssues: string[];
  modelTurns: number;
  durationMs: number;
  completedAt: string;
  runId: number;
  savedPath?: string;
};

export type QueryReplayResult = Omit<QueryReplayState, 'completedAt' | 'runId'>;

export type RubricImprovementReplayState = {
  result: RubricImprovementResult;
  trace: CapabilityEvent[];
  evalOk: boolean;
  evalIssueDetails: { path: string; message: string }[];
  evalIssues: string[];
  modelTurns: number;
  durationMs: number;
  completedAt: string;
  runId: number;
};

export type RubricImprovementReplayResult = Omit<RubricImprovementReplayState, 'completedAt' | 'runId'>;

export type ReplayMode = 'fixture' | 'anthropic' | 'openai';

export type MonitoringReplayMode = 'fixture' | 'openai';

export type DiagnosticReplayMode = 'fixture' | 'openai';

export type QueryReplayMode = 'fixture' | 'openai';

export type RubricImprovementReplayMode = 'fixture' | 'openai';

export type StudioView =
  | 'home'
  | 'recommendation'
  | 'monitoring'
  | 'diagnostic'
  | 'query'
  | 'rubric-improvement'
  | 'capabilities'
  | 'api-docs'
  | 'user-guide';

export type ProviderStatus = Record<ReplayMode, { available: boolean; model: string }>;

export type { CostEstimate, TokenUsageSummary };

export type PromptPackageProvenance = {
  id: string;
  version: string;
  capabilityId: string;
  templateHash: string;
  templateChars: number;
  renderedHash: string;
  renderedChars: number;
};

export type ReplayArtifact = {
  schemaVersion: 1;
  createdAt: string;
  durationMs: number;
  provider: {
    id: ReplayMode;
    model: string;
  };
  fixture: {
    id: string;
    description: string;
    path: string;
  };
  promptPackage: PromptPackageProvenance;
  recommendations: Recommendation[];
  trace: CapabilityEvent[];
  costEstimate?: CostEstimate;
  eval: {
    name: string;
    ok: boolean;
    issues: { path: string; message: string }[];
  };
  modelTurns: number;
};

export type MonitoringReplayArtifact = {
  schemaVersion: 1;
  capabilityId: 'anomaly-monitoring-agent';
  createdAt: string;
  durationMs: number;
  provider: {
    id: MonitoringReplayMode;
    model: string;
  };
  fixture: {
    id: string;
    description: string;
    path: string;
  };
  promptPackage: PromptPackageProvenance;
  anomalies: MonitoringAnomaly[];
  trace: CapabilityEvent[];
  costEstimate?: CostEstimate;
  eval: {
    name: string;
    ok: boolean;
    issues: { path: string; message: string }[];
  };
  modelTurns: number;
};

export type DiagnosticReplayArtifact = {
  schemaVersion: 1;
  capabilityId: 'diagnostic-investigation-agent';
  createdAt: string;
  durationMs: number;
  provider: {
    id: DiagnosticReplayMode;
    model: string;
  };
  fixture: {
    id: string;
    description: string;
    path: string;
  };
  promptPackage: PromptPackageProvenance;
  diagnosis: DiagnosticDiagnosis;
  trace: CapabilityEvent[];
  costEstimate?: CostEstimate;
  eval: {
    name: string;
    ok: boolean;
    issues: { path: string; message: string }[];
  };
  modelTurns: number;
};

export type QueryReplayArtifact = {
  schemaVersion: 1;
  capabilityId: 'query-agent';
  createdAt: string;
  durationMs: number;
  provider: {
    id: QueryReplayMode;
    model: string;
  };
  fixture: {
    id: string;
    description: string;
    path: string;
  };
  promptPackage: PromptPackageProvenance;
  question: string;
  intent: QueryIntent;
  answer: string;
  trace: CapabilityEvent[];
  costEstimate?: CostEstimate;
  eval: {
    name: string;
    ok: boolean;
    issues: { path: string; message: string }[];
  };
  modelTurns: number;
};

export type SavedReplaySummary = {
  path: string;
  capabilityId?: string;
  createdAt: string;
  provider: { id: string; model: string };
  fixture: { id: string; description?: string; path?: string };
  promptPackage?: PromptPackageProvenance;
  evalOk: boolean;
  issues: { path: string; message: string }[];
  recommendations: Recommendation[];
  recommendationCount: number;
  durationMs: number;
  modelTurns: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  costEstimate?: CostEstimate;
};

export type SavedMonitoringReplaySummary = {
  path: string;
  capabilityId: 'anomaly-monitoring-agent';
  createdAt: string;
  provider: { id: string; model: string };
  fixture: { id: string; description?: string; path?: string };
  promptPackage?: PromptPackageProvenance;
  evalOk: boolean;
  issues: { path: string; message: string }[];
  anomalies: MonitoringAnomaly[];
  anomalyCount: number;
  durationMs: number;
  modelTurns: number;
  usage: TokenUsageSummary;
  costEstimate?: CostEstimate;
};

export type SavedDiagnosticReplaySummary = {
  path: string;
  capabilityId: 'diagnostic-investigation-agent';
  createdAt: string;
  provider: { id: string; model: string };
  fixture: { id: string; description?: string; path?: string };
  promptPackage?: PromptPackageProvenance;
  evalOk: boolean;
  issues: { path: string; message: string }[];
  diagnosis: DiagnosticDiagnosis;
  diagnosisPresent: boolean;
  durationMs: number;
  modelTurns: number;
  usage: TokenUsageSummary;
  costEstimate?: CostEstimate;
};

export type SavedQueryReplaySummary = {
  path: string;
  capabilityId: 'query-agent';
  createdAt: string;
  provider: { id: string; model: string };
  fixture: { id: string; description?: string; path?: string };
  promptPackage?: PromptPackageProvenance;
  evalOk: boolean;
  issues: { path: string; message: string }[];
  question?: string;
  intent?: QueryIntent;
  answer: string;
  answerPresent: boolean;
  durationMs: number;
  modelTurns: number;
  usage: TokenUsageSummary;
  costEstimate?: CostEstimate;
};

export type ComparableReplay = {
  path?: string;
  createdAt: string;
  provider: { id: string; model: string };
  fixture: { id: string; description?: string; path?: string };
  evalOk: boolean;
  issues: { path: string; message: string }[];
  recommendations: Recommendation[];
  recommendationCount: number;
  durationMs: number;
  modelTurns: number;
  usage: TokenUsageSummary;
  costEstimate?: CostEstimate;
};

export type ComparisonState = {
  fixture?: ComparableReplay;
  openai?: ComparableReplay;
  completedAt: string;
};

export type ComparableMonitoringReplay = {
  path?: string;
  createdAt: string;
  provider: { id: string; model: string };
  fixture: { id: string; description?: string; path?: string };
  evalOk: boolean;
  issues: { path: string; message: string }[];
  anomalies: MonitoringAnomaly[];
  anomalyCount: number;
  durationMs: number;
  modelTurns: number;
  usage: TokenUsageSummary;
  costEstimate?: CostEstimate;
};

export type MonitoringComparisonState = {
  fixture?: ComparableMonitoringReplay;
  openai?: ComparableMonitoringReplay;
  completedAt: string;
};

export type PromoteResult = {
  path: string;
  id: string;
  sourceArtifact: string;
  recommendationCount: number;
};

export type MonitoringPromoteResult = {
  path: string;
  id: string;
  sourceArtifact: string;
  anomalyCount: number;
};

export type DiagnosticPromoteResult = {
  path: string;
  id: string;
  sourceArtifact: string;
  diagnosisPresent: boolean;
};

export type QueryPromoteResult = {
  path: string;
  id: string;
  sourceArtifact: string;
  answerPresent: boolean;
};

export type PromotedFixtureSummary = {
  path: string;
  id: string;
  description: string;
  promotion?: {
    sourceArtifact?: string;
    sourceProvider?: { id?: string; model?: string };
    promotedAt?: string;
  };
  expectations?: {
    requiredFeatures?: string[];
    requiredText?: string[];
  };
  evalOk: boolean;
  behaviorOk: boolean;
  ok: boolean;
  issues: { path: string; message: string; source: string }[];
  recommendationCount: number;
  modelTurns: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  costEstimate?: CostEstimate;
};

export type PromotedMonitoringFixtureSummary = {
  path: string;
  id: string;
  description: string;
  promotion?: {
    sourceArtifact?: string;
    sourceProvider?: { id?: string; model?: string };
    promotedAt?: string;
  };
  expectations?: {
    minAnomalyCount?: number;
    requiredCategories?: string[];
    requiredMetrics?: string[];
    requiredScopes?: string[];
    requiredSeverities?: string[];
  };
  evalOk: boolean;
  behaviorOk: boolean;
  ok: boolean;
  issues: { path: string; message: string; source: string }[];
  anomalyCount: number;
  modelTurns: number;
  usage: TokenUsageSummary;
  costEstimate?: CostEstimate;
};

export type PromotedDiagnosticFixtureSummary = {
  path: string;
  id: string;
  description: string;
  promotion?: {
    sourceArtifact?: string;
    sourceProvider?: { id?: string; model?: string };
    promotedAt?: string;
  };
  expectations?: {
    requiredEvidenceText?: string[];
    requiredSupportedHypothesisText?: string[];
  };
  evalOk: boolean;
  behaviorOk: boolean;
  ok: boolean;
  issues: { path: string; message: string; source: string }[];
  diagnosisPresent: boolean;
  modelTurns: number;
  usage: TokenUsageSummary;
  costEstimate?: CostEstimate;
};

export type PromotedQueryFixtureSummary = {
  path: string;
  id: string;
  description: string;
  promotion?: {
    sourceArtifact?: string;
    sourceProvider?: { id?: string; model?: string };
    promotedAt?: string;
  };
  expectations?: {
    requiredAnswerText?: string[];
  };
  evalOk: boolean;
  behaviorOk: boolean;
  ok: boolean;
  issues: { path: string; message: string; source: string }[];
  answerPresent: boolean;
  modelTurns: number;
  usage: TokenUsageSummary;
  costEstimate?: CostEstimate;
};
