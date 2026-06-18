import { InMemoryToolRegistry, type ToolDefinition, type ToolHandler } from '@aptkit/tools';
import type { ModelResponse } from '@aptkit/runtime';
import { AnomalyMonitoringAgent, FixtureModelProvider } from '../src/index.js';
import fixture from '../fixtures/sp-revenue-monitoring.json' with { type: 'json' };

const handlers: Record<string, ToolHandler> = {};
for (const tool of fixture.tools) {
  handlers[tool.name] = () => tool.result;
}

const tools = new InMemoryToolRegistry(
  fixture.tools.map(({ result: _result, ...definition }) => definition) as ToolDefinition[],
  handlers,
);
const model = new FixtureModelProvider(fixture.modelResponses as ModelResponse[]);
const trace: unknown[] = [];
const agent = new AnomalyMonitoringAgent({
  model,
  tools,
  workspace: fixture.workspace,
  trace: { emit: (event) => trace.push(event) },
});

const anomalies = await agent.scan();
console.log(JSON.stringify({
  fixture: fixture.id,
  ok: anomalies.length > 0,
  anomalies,
  modelTurns: model.requests.length,
  trace,
}, null, 2));
