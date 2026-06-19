import React from 'react';
import {
  ArrowLeft,
  Boxes,
  CheckCircle2,
  FileJson,
  Gauge,
  GitBranch,
  Layers3,
  Play,
  Scale,
} from 'lucide-react';
import { RubricJudge, type RubricDefinition } from '@aptkit/evals';
import { FallbackModelProvider } from '@aptkit/provider-fallback';
import { ContextWindowGuardedProvider } from '@aptkit/provider-local';
import {
  generateStructured,
  type CapabilityEvent,
  type CapabilityTraceSink,
  type JsonValidation,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from '@aptkit/runtime';
import { ensureGeneratedContent, splitMarkdownSections } from '@aptkit/workflows';
import { Metric, Panel, TracePanel } from './components';

type StructuredBrief = {
  title: string;
  priority: 'low' | 'medium' | 'high';
  tags: string[];
};

type GeneratedVariant = {
  title: string;
  body: string;
};

type ExistingVariant = {
  sourceHash: string;
  variantIndex: number;
  title: string;
};

type CapabilityPreviewState = {
  runId: number;
  completedAt: string;
  durationMs: number;
  trace: CapabilityEvent[];
  structured: Awaited<ReturnType<typeof runStructuredPreview>>;
  rubric: Awaited<ReturnType<typeof runRubricPreview>>;
  workflow: Awaited<ReturnType<typeof runWorkflowPreview>>;
  fallback: Awaited<ReturnType<typeof runFallbackPreview>>;
};

const sourceMarkdown = [
  '# Launch Notes',
  '',
  '## Payment Recovery',
  'A checkout drop appears after payment failures rise for mobile shoppers.',
  '',
  '## Voucher Cleanup',
  'Expired voucher pools are still visible in lifecycle scenarios.',
  '',
  '## Support Brief',
  'Support needs one concise summary for the incident channel.',
].join('\n');

const rubric: RubricDefinition = {
  id: 'incident-brief-rubric',
  title: 'Incident Brief Quality',
  task: 'Judge whether the subject is evidence-backed and action-oriented.',
  dimensions: [
    {
      id: 'evidence',
      label: 'Evidence',
      description: 'Uses concrete observations instead of vague claims.',
      scale: [
        { score: 1, description: 'No concrete evidence' },
        { score: 2, description: 'Some evidence but thin or indirect' },
        { score: 3, description: 'Clear evidence tied to the conclusion' },
      ],
    },
    {
      id: 'actionability',
      label: 'Actionability',
      description: 'Gives a next action that an operator can execute.',
      scale: [
        { score: 1, description: 'No useful action' },
        { score: 2, description: 'Action is plausible but broad' },
        { score: 3, description: 'Action is specific and bounded' },
      ],
    },
  ],
  verdicts: [
    { verdict: 'pass', description: 'Ready to use' },
    { verdict: 'revise', description: 'Needs a focused fix' },
  ],
  checks: ['mentions_evidence', 'single_fix'],
};

export function CapabilitiesWorkspace({ onHome }: { onHome: () => void }) {
  const [state, setState] = React.useState<CapabilityPreviewState | null>(null);
  const [nextRunId, setNextRunId] = React.useState(1);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const run = React.useCallback(async () => {
    const runId = nextRunId;
    setNextRunId((current) => current + 1);
    setRunning(true);
    setError(null);
    setState(null);
    const started = performance.now();
    try {
      const trace: CapabilityEvent[] = [];
      const sink: CapabilityTraceSink = { emit: (event) => trace.push(event) };
      const [structured, rubricResult, workflow, fallback] = await Promise.all([
        runStructuredPreview(sink),
        runRubricPreview(sink),
        runWorkflowPreview(sink),
        runFallbackPreview(sink),
      ]);
      setState({
        runId,
        completedAt: new Date().toLocaleTimeString(),
        durationMs: Math.round(performance.now() - started),
        trace,
        structured,
        rubric: rubricResult,
        workflow,
        fallback,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  }, [nextRunId]);

  React.useEffect(() => {
    void run();
  }, []);

  const structuredOk = state?.structured.result.ok ?? false;
  const rubricOk = state?.rubric.result.ok ?? false;
  const generatedCount = state?.workflow.generated.length ?? 0;
  const fallbackProvider = state?.fallback.selectedProvider ?? 'pending';
  const runLabel = running ? `#${nextRunId - 1}` : state ? `#${state.runId}` : 'none';

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AptKit Studio</p>
          <h1>Runtime & Eval Utilities</h1>
        </div>
        <div className="topbarActions">
          <button className="secondaryAction topbarHome" type="button" onClick={onHome}>
            <ArrowLeft size={16} />
            <span>Home</span>
          </button>
          <button className="runButton" disabled={running} type="button" onClick={run}>
            <Play size={16} />
            <span>{running ? 'Running' : 'Run Fixtures'}</span>
          </button>
        </div>
      </header>

      <section className="metrics">
        <Metric icon={<Play size={18} />} label="Run" value={runLabel} tone={state ? 'good' : 'neutral'} />
        <Metric icon={<FileJson size={18} />} label="Structured" value={structuredOk ? 'valid' : 'pending'} tone={structuredOk ? 'good' : 'neutral'} />
        <Metric icon={<Scale size={18} />} label="Rubric" value={rubricOk ? state?.rubric.verdict ?? 'pass' : 'pending'} tone={rubricOk ? 'good' : 'neutral'} />
        <Metric icon={<Layers3 size={18} />} label="Generated" value={`${generatedCount}`} tone={generatedCount ? 'good' : 'neutral'} />
        <Metric icon={<GitBranch size={18} />} label="Provider" value={fallbackProvider} tone={fallbackProvider === 'cloud-fixture' ? 'good' : 'neutral'} />
        <Metric icon={<Gauge size={18} />} label={state ? state.completedAt : 'Elapsed'} value={state ? `${state.durationMs}ms` : '0ms'} />
      </section>

      {error ? <div className="errorState">{error}</div> : null}

      <section className="capabilityWorkspace">
        <div className="mainPane">
          <Panel title="Structured Generation" icon={<FileJson size={17} />}>
            {state ? <StructuredPreview state={state} /> : <div className="emptyState compact">No fixture run yet.</div>}
          </Panel>
          <Panel title="Rubric Judge" icon={<Scale size={17} />}>
            {state ? <RubricPreview state={state} /> : <div className="emptyState compact">No fixture run yet.</div>}
          </Panel>
        </div>
        <div className="mainPane">
          <Panel title="Content Workflow" icon={<Layers3 size={17} />}>
            {state ? <WorkflowPreview state={state} /> : <div className="emptyState compact">No fixture run yet.</div>}
          </Panel>
          <Panel title="Provider Fallback" icon={<GitBranch size={17} />}>
            {state ? <FallbackPreview state={state} /> : <div className="emptyState compact">No fixture run yet.</div>}
          </Panel>
        </div>
        <div className="rightPane">
          <Panel title="Inventory" icon={<Boxes size={17} />}>
            <div className="capabilityInventoryList">
              {[
                ['structured-generation', 'packages/runtime'],
                ['rubric-judge', 'packages/evals'],
                ['content-generation-workflow', 'packages/workflows'],
                ['provider-fallback-chain', 'packages/providers/fallback'],
                ['local-context-guard', 'packages/providers/local'],
              ].map(([id, pkg]) => (
                <div key={id}>
                  <strong>{id}</strong>
                  <code>{pkg}</code>
                </div>
              ))}
            </div>
          </Panel>
          <TracePanel running={running} trace={state?.trace ?? []} />
        </div>
      </section>
    </main>
  );
}

function StructuredPreview({ state }: { state: CapabilityPreviewState }) {
  const { result } = state.structured;
  return (
    <div className="utilityPreview">
      <div className={result.ok ? 'reviewBanner ready' : 'reviewBanner pending'}>
        <strong>{result.ok ? result.value.title : 'Validation failed'}</strong>
        <span>{result.ok ? `${result.value.priority} priority · ${result.value.tags.join(', ')}` : result.error}</span>
      </div>
      <div className="reviewGrid">
        <div>
          <span>Attempts</span>
          <strong>{result.attempts.length}</strong>
        </div>
        <div>
          <span>Retry</span>
          <strong>{result.attempts.some((attempt) => attempt.error) ? 'used' : 'not needed'}</strong>
        </div>
      </div>
      <pre className="jsonPreview">{JSON.stringify(result, null, 2)}</pre>
    </div>
  );
}

function RubricPreview({ state }: { state: CapabilityPreviewState }) {
  const { result } = state.rubric;
  if (!result.ok) return <div className="errorState compact">{result.error}</div>;
  return (
    <div className="utilityPreview">
      <div className="reviewBanner ready">
        <strong>{result.value.verdict}</strong>
        <span>{result.value.fix}</span>
      </div>
      <div className="scoreGrid">
        {Object.entries(result.value.dimensions).map(([id, score]) => (
          <div key={id}>
            <span>{id}</span>
            <strong>{score.score}/3</strong>
            <p>{score.reason}</p>
          </div>
        ))}
      </div>
      <div className="capabilityChecks">
        {Object.entries(result.value.checks ?? {}).map(([id, passed]) => (
          <span className={passed ? 'passed' : ''} key={id}>
            <CheckCircle2 size={14} />
            {id}
          </span>
        ))}
      </div>
    </div>
  );
}

function WorkflowPreview({ state }: { state: CapabilityPreviewState }) {
  const workflow = state.workflow;
  return (
    <div className="utilityPreview">
      <div className="reviewGrid">
        <div>
          <span>Sections</span>
          <strong>{workflow.sectionCount}</strong>
        </div>
        <div>
          <span>Stale</span>
          <strong>{workflow.staleExisting.length}</strong>
        </div>
        <div>
          <span>Attempted</span>
          <strong>{workflow.attempted.length}</strong>
        </div>
        <div>
          <span>Skipped</span>
          <strong>{workflow.skipped.length}</strong>
        </div>
      </div>
      <div className="variantList">
        {workflow.generated.map((variant) => (
          <div key={variant.variantIndex}>
            <strong>{variant.item.title}</strong>
            <span>{variant.section.heading ?? 'Untitled'} · {variant.angle.label}</span>
            <p>{variant.item.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function FallbackPreview({ state }: { state: CapabilityPreviewState }) {
  return (
    <div className="utilityPreview">
      <div className="reviewBanner ready">
        <strong>{state.fallback.selectedProvider}</strong>
        <span>{state.fallback.responseText}</span>
      </div>
      <pre className="jsonPreview">{JSON.stringify(state.fallback.estimate, null, 2)}</pre>
    </div>
  );
}

async function runStructuredPreview(trace: CapabilityTraceSink) {
  const model = sequenceProvider('weak-json-fixture', 'json-mini', [
    'title: Checkout payment failures',
    JSON.stringify({
      title: 'Checkout payment failures',
      priority: 'high',
      tags: ['checkout', 'payments', 'mobile'],
    }),
  ]);

  return {
    result: await generateStructured<StructuredBrief>({
      capabilityId: 'structured-generation',
      model,
      userPrompt: 'Return a JSON incident brief for payment failures.',
      validate: validateStructuredBrief,
      retry: { maxAttempts: 2 },
      trace,
    }),
  };
}

async function runRubricPreview(trace: CapabilityTraceSink) {
  const model = sequenceProvider('judge-fixture', 'rubric-mini', [
    JSON.stringify({
      dimensions: {
        evidence: { score: 3, reason: 'The subject names payment failures and mobile checkout drop.' },
        actionability: { score: 2, reason: 'The next action is useful but should name an owner.' },
      },
      checks: { mentions_evidence: true, single_fix: true },
      verdict: 'revise',
      fix: 'Assign payment-owner review and include the affected mobile segment.',
      reasoning: 'The brief is grounded but needs a tighter owner/action boundary.',
    }),
  ]);
  const judge = new RubricJudge({ model, rubric, trace });
  const result = await judge.judge({
    subject: 'Mobile checkout conversion fell after payment failures increased; retry payment health before changing campaigns.',
  });
  return { result, verdict: result.ok ? result.value.verdict : 'failed' };
}

async function runWorkflowPreview(trace: CapabilityTraceSink) {
  const sourceHash = 'launch-notes-v2';
  const result = await ensureGeneratedContent<ExistingVariant, GeneratedVariant>({
    capabilityId: 'content-generation-workflow',
    sourceMarkdown,
    sourceHash,
    existing: [
      { sourceHash, variantIndex: 0, title: 'Existing payment brief' },
      { sourceHash: 'launch-notes-v1', variantIndex: 0, title: 'Old voucher brief' },
    ],
    targetCount: 3,
    angles: [
      { id: 'operator', label: 'Operator' },
      { id: 'executive', label: 'Executive' },
    ],
    generator: async (plan) => {
      if (plan.variantIndex === 1) return null;
      return {
        title: `${plan.angle.label}: ${plan.section.heading ?? 'Source'}`,
        body: plan.section.content.slice(0, 112),
      };
    },
    trace,
  });
  return {
    ...result,
    sectionCount: splitMarkdownSections(sourceMarkdown).length,
  };
}

async function runFallbackPreview(trace: CapabilityTraceSink) {
  const local = sequenceProvider('local-fixture', 'tiny-local', ['local should not run']);
  const guardedLocal = new ContextWindowGuardedProvider(local, {
    maxTokens: 90,
    outputReserve: 32,
    capabilityId: 'local-context-guard',
    trace,
  });
  const cloud = sequenceProvider('cloud-fixture', 'cloud-small', ['Fallback provider accepted the oversized local prompt.']);
  const fallback = new FallbackModelProvider({
    providers: [guardedLocal, cloud],
    capabilityId: 'provider-fallback-chain',
    trace,
  });
  const request: ModelRequest = {
    system: 'Summarize the capability preview.',
    messages: [{ role: 'user', content: 'context '.repeat(520) }],
  };
  const response = await fallback.complete(request);
  return {
    selectedProvider: fallback.lastSelectedProvider?.providerId ?? 'unknown',
    responseText: response.content.map((block) => block.type === 'text' ? block.text : '').join(''),
    estimate: {
      model: response.model,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
    },
  };
}

function validateStructuredBrief(value: unknown): JsonValidation<StructuredBrief> {
  if (!isRecord(value)) return { ok: false, error: 'brief must be an object' };
  if (typeof value.title !== 'string' || value.title.trim().length === 0) {
    return { ok: false, error: 'brief.title must be a non-empty string' };
  }
  if (value.priority !== 'low' && value.priority !== 'medium' && value.priority !== 'high') {
    return { ok: false, error: 'brief.priority must be low, medium, or high' };
  }
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== 'string')) {
    return { ok: false, error: 'brief.tags must be an array of strings' };
  }
  return {
    ok: true,
    value: {
      title: value.title.trim(),
      priority: value.priority,
      tags: value.tags.map((tag) => tag.trim()).filter(Boolean),
    },
  };
}

function sequenceProvider(id: string, defaultModel: string, outputs: Array<string | Error>): ModelProvider {
  let index = 0;
  return {
    id,
    defaultModel,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const output = outputs[Math.min(index, outputs.length - 1)];
      index += 1;
      if (output instanceof Error) throw output;
      return {
        content: [{ type: 'text', text: output }],
        model: defaultModel,
        usage: {
          inputTokens: estimateRequestTokens(request),
          outputTokens: Math.ceil(output.length / 4),
          estimated: true,
        },
      };
    },
  };
}

function estimateRequestTokens(request: ModelRequest): number {
  const text = [
    request.system ?? '',
    ...request.messages.map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)),
  ].join('\n');
  return Math.ceil(text.length / 4);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
