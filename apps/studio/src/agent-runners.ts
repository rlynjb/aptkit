import { AnomalyMonitoringAgent, FixtureModelProvider as MonitoringFixtureModelProvider, validateAnomalies } from '@aptkit/agent-anomaly-monitoring';
import { DiagnosticInvestigationAgent, FixtureModelProvider as DiagnosticFixtureModelProvider, validateDiagnosis } from '@aptkit/agent-diagnostic-investigation';
import { FixtureModelProvider as QueryFixtureModelProvider, QueryAgent, validateQueryAnswer } from '@aptkit/agent-query';
import { RecommendationAgent, FixtureModelProvider } from '@aptkit/agent-recommendation';
import { FixtureModelProvider as RubricImprovementFixtureModelProvider, RubricImprovementAgent, validateRubricImprovementResult } from '@aptkit/agent-rubric-improvement';
import { RagQueryAgent } from '@aptkit/agent-rag-query';
import { assertRecommendationShape, scorePrecisionAtK, scoreRecallAtK } from '@aptkit/evals';
import { createRetrievalPipeline, createSearchKnowledgeBaseTool, InMemoryVectorStore, type EmbeddingProvider } from '@aptkit/retrieval';
import type { CapabilityEvent } from '@aptkit/runtime';
import { InMemoryToolRegistry, type ToolHandler } from '@aptkit/tools';
import type { DiagnosticFixture, DiagnosticReplayResult, MonitoringFixture, MonitoringReplayResult, QueryFixture, QueryReplayResult, RagQueryFixture, RagQueryReplayResult, RagRetrievedChunk, RecommendationFixture, ReplayResult, RubricImprovementFixture, RubricImprovementReplayResult } from './types';

export function runFixtureReplay(fixture: RecommendationFixture): Promise<ReplayResult> {
  const startedAt = performance.now();
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const model = new FixtureModelProvider(fixture.modelResponses);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const trace: CapabilityEvent[] = [];
  const idGenerator = (() => {
    let index = 0;
    return () => `${fixture.id}-studio-${++index}`;
  })();

  const agent = new RecommendationAgent({
    model,
    tools,
    workspace: fixture.workspace,
    idGenerator,
    trace: { emit: (event) => trace.push(event) },
  });

  return agent.propose(fixture.anomaly, fixture.diagnosis).then((recommendations) => {
    const evalResult = assertRecommendationShape(recommendations);
    return {
      recommendations,
      trace,
      evalOk: evalResult.ok,
      evalIssueDetails: evalResult.issues,
      evalIssues: evalResult.issues.map((issue) => `${issue.path}: ${issue.message}`),
      modelTurns: model.requests.length,
      durationMs: Math.round(performance.now() - startedAt),
    };
  });
}

export function runMonitoringFixtureReplay(fixture: MonitoringFixture): Promise<MonitoringReplayResult> {
  const startedAt = performance.now();
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const model = new MonitoringFixtureModelProvider(fixture.modelResponses);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const trace: CapabilityEvent[] = [];
  const agent = new AnomalyMonitoringAgent({
    model,
    tools,
    workspace: fixture.workspace,
    trace: { emit: (event) => trace.push(event) },
  });

  return agent.scan().then((anomalies) => {
    const evalResult = validateAnomalies(anomalies);
    const issues = evalResult.ok ? [] : [{ path: 'anomalies', message: evalResult.error }];
    return {
      anomalies,
      trace,
      evalOk: evalResult.ok,
      evalIssueDetails: issues,
      evalIssues: issues.map((issue) => `${issue.path}: ${issue.message}`),
      modelTurns: model.requests.length,
      durationMs: Math.round(performance.now() - startedAt),
    };
  });
}

export function runDiagnosticFixtureReplay(fixture: DiagnosticFixture): Promise<DiagnosticReplayResult> {
  const startedAt = performance.now();
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const model = new DiagnosticFixtureModelProvider(fixture.modelResponses);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const trace: CapabilityEvent[] = [];
  const agent = new DiagnosticInvestigationAgent({
    model,
    tools,
    workspace: fixture.workspace,
    trace: { emit: (event) => trace.push(event) },
  });

  return agent.investigate(fixture.anomaly).then((diagnosis) => {
    const evalResult = validateDiagnosis(diagnosis);
    const issues = evalResult.ok ? [] : [{ path: 'diagnosis', message: evalResult.error }];
    return {
      diagnosis,
      trace,
      evalOk: evalResult.ok,
      evalIssueDetails: issues,
      evalIssues: issues.map((issue) => `${issue.path}: ${issue.message}`),
      modelTurns: model.requests.length,
      durationMs: Math.round(performance.now() - startedAt),
    };
  });
}

export function runQueryFixtureReplay(fixture: QueryFixture): Promise<QueryReplayResult> {
  const startedAt = performance.now();
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const model = new QueryFixtureModelProvider(fixture.modelResponses);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const trace: CapabilityEvent[] = [];
  const agent = new QueryAgent({
    model,
    tools,
    workspace: fixture.workspace,
    trace: { emit: (event) => trace.push(event) },
  });

  return agent.answer(fixture.question, { intent: fixture.intent }).then((answer) => {
    const evalResult = validateQueryAnswer(answer);
    const issues = evalResult.ok ? [] : [{ path: 'answer', message: evalResult.error }];
    return {
      answer,
      trace,
      evalOk: evalResult.ok,
      evalIssueDetails: issues,
      evalIssues: issues.map((issue) => `${issue.path}: ${issue.message}`),
      modelTurns: model.requests.length,
      durationMs: Math.round(performance.now() - startedAt),
    };
  });
}

const RAG_EMBED_DIM = 64;

/** Deterministic in-browser embedder (keyword-hash) — no Ollama needed for fixture replay. */
function makeFixtureEmbedder(): EmbeddingProvider {
  return {
    id: 'fixture-embed',
    dimension: RAG_EMBED_DIM,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const vector = new Array<number>(RAG_EMBED_DIM).fill(0);
        for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
          let hash = 0;
          for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
          vector[hash % RAG_EMBED_DIM] += 1;
        }
        return vector;
      });
    },
  };
}

export async function runRagQueryFixtureReplay(fixture: RagQueryFixture): Promise<RagQueryReplayResult> {
  const startedAt = performance.now();

  // Real retrieval pipeline, deterministic in the browser: fake embedder + in-memory store.
  const embedder = makeFixtureEmbedder();
  const store = new InMemoryVectorStore(RAG_EMBED_DIM);
  const pipeline = createRetrievalPipeline({ embedder, store });
  for (const doc of fixture.corpus) {
    await pipeline.index({ id: doc.id, text: doc.text });
  }
  const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 3 });
  const tools = new InMemoryToolRegistry([tool.definition], { [tool.definition.name]: tool.handler });

  // Recorded Gemma responses (tool_use, then the grounded answer) replay the loop.
  const model = new QueryFixtureModelProvider(fixture.modelResponses);
  const trace: CapabilityEvent[] = [];
  const agent = new RagQueryAgent({
    model,
    tools,
    profile: fixture.profile,
    trace: { emit: (event) => trace.push(event) },
  });

  const answer = await agent.answer(fixture.question);

  // The chunks the agent actually retrieved, read back from the search tool_call_end.
  const toolEnd = trace.find(
    (event): event is Extract<CapabilityEvent, { type: 'tool_call_end' }> => event.type === 'tool_call_end',
  );
  const rawResult = toolEnd?.result;
  const retrieved: RagRetrievedChunk[] =
    rawResult && typeof rawResult === 'object' && Array.isArray((rawResult as { results?: unknown }).results)
      ? (rawResult as { results: RagRetrievedChunk[] }).results
      : [];

  const retrievedDocIds = [...new Set(retrieved.map((hit) => String(hit.meta?.docId ?? hit.id)))];
  const relevant = new Set(fixture.relevant);
  const recallK = Math.max(retrievedDocIds.length, fixture.relevant.length || 1);
  const precisionAt1 = scorePrecisionAtK(retrievedDocIds, relevant, 1).score;
  const recallAtK = scoreRecallAtK(retrievedDocIds, relevant, recallK).score;

  const issues: string[] = [];
  if (!answer.trim()) issues.push('answer: agent produced no answer');
  if (precisionAt1 < 1) issues.push('retrieval: top chunk is not in the relevant set');
  if (recallAtK < 1) issues.push('retrieval: not all relevant docs were retrieved');

  return {
    question: fixture.question,
    answer,
    retrieved,
    retrievedDocIds,
    precisionAt1,
    recallAtK,
    recallK,
    relevant: fixture.relevant,
    trace,
    modelTurns: model.requests.length,
    durationMs: Math.round(performance.now() - startedAt),
    evalOk: issues.length === 0,
    issues,
  };
}

export function runRubricImprovementFixtureReplay(
  fixture: RubricImprovementFixture,
): Promise<RubricImprovementReplayResult> {
  const startedAt = performance.now();
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const model = new RubricImprovementFixtureModelProvider(fixture.modelResponses);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const trace: CapabilityEvent[] = [];
  const agent = new RubricImprovementAgent({
    model,
    tools,
    rubric: fixture.rubric,
    trace: { emit: (event) => trace.push(event) },
  });

  return agent.improve({ subject: fixture.subject, context: fixture.context }).then((result) => {
    const evalResult = validateRubricImprovementResult(fixture.rubric)(result);
    const issues = evalResult.ok ? [] : [{ path: 'result', message: evalResult.error }];
    return {
      result,
      trace,
      evalOk: evalResult.ok,
      evalIssueDetails: issues,
      evalIssues: issues.map((issue) => `${issue.path}: ${issue.message}`),
      modelTurns: model.requests.length,
      durationMs: Math.round(performance.now() - startedAt),
    };
  });
}
