import React from 'react';
import { BadgeCheck, Boxes, FileText, Gauge, ListChecks, Play, SearchCheck, Target, Timer } from 'lucide-react';
import { EvalPanel, Metric, Panel, TracePanel } from './components';
import { runRagQueryFixtureReplay } from './agent-runners';
import { ragQueryFixtures } from './rag-query-fixtures';
import type { RagQueryReplayResult } from './types';

export function RagQueryWorkspace({ onHome }: { onHome: () => void }) {
  const [selectedId, setSelectedId] = React.useState(ragQueryFixtures[0].id);
  const [result, setResult] = React.useState<RagQueryReplayResult | null>(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [runId, setRunId] = React.useState(0);

  const fixture = ragQueryFixtures.find((item) => item.id === selectedId) ?? ragQueryFixtures[0];

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const next = await runRagQueryFixtureReplay(fixture);
      setResult(next);
      setRunId((current) => current + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const precisionLabel = result ? result.precisionAt1.toFixed(2) : 'Pending';
  const recallLabel = result ? result.recallAtK.toFixed(2) : 'Pending';

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AptKit Studio</p>
          <h1>RAG Query Agent</h1>
        </div>
        <div className="topbarActions">
          <select
            className="ragFixtureSelect"
            value={selectedId}
            disabled={running}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setResult(null);
              setError(null);
            }}
          >
            {ragQueryFixtures.map((item) => (
              <option key={item.id} value={item.id}>
                {item.description}
              </option>
            ))}
          </select>
          <button className="secondaryAction topbarHome" type="button" onClick={onHome}>
            Home
          </button>
          <button className="runButton" type="button" disabled={running} onClick={run}>
            {running ? 'Running…' : 'Run fixture'}
          </button>
        </div>
      </header>

      <section className="metrics">
        <Metric
          icon={<BadgeCheck size={18} />}
          label="Eval"
          value={error ? 'Error' : result?.evalOk ? 'Passing' : running ? 'Running' : 'Pending'}
          tone={result?.evalOk ? 'good' : 'neutral'}
        />
        <Metric
          icon={<Target size={18} />}
          label="Precision@1"
          value={precisionLabel}
          tone={result && result.precisionAt1 >= 1 ? 'good' : 'neutral'}
        />
        <Metric
          icon={<ListChecks size={18} />}
          label={`Recall@${result?.recallK ?? 3}`}
          value={recallLabel}
          tone={result && result.recallAtK >= 1 ? 'good' : 'neutral'}
        />
        <Metric icon={<SearchCheck size={18} />} label="Chunks" value={`${result?.retrieved.length ?? 0}`} />
        <Metric icon={<Timer size={18} />} label="Duration" value={result ? `${result.durationMs}ms` : running ? 'Running' : '0ms'} />
        <Metric icon={<Boxes size={18} />} label="Run" value={`#${runId}`} />
      </section>

      <p className="ragQuestion">
        <strong>Q:</strong> {fixture.question}
      </p>

      {error ? <div className="errorState">{error}</div> : null}

      <section className="capabilityWorkspace">
        <div className="mainPane">
          <Panel title="Answer" icon={<FileText size={17} />}>
            {result ? (
              <p className="ragAnswer">{result.answer}</p>
            ) : (
              <div className="emptyState compact">No fixture run yet.</div>
            )}
          </Panel>
          <Panel title="Retrieved chunks" icon={<SearchCheck size={17} />}>
            {result && result.retrieved.length ? (
              <ol className="ragChunkList">
                {result.retrieved.map((chunk) => {
                  const docId = String(chunk.meta?.docId ?? chunk.id);
                  const isRelevant = result.relevant.includes(docId);
                  return (
                    <li key={chunk.id} className={isRelevant ? 'ragChunk relevant' : 'ragChunk'}>
                      <div className="ragChunkHead">
                        <span className="ragChunkId">{docId}</span>
                        <span className="ragChunkScore">{chunk.score.toFixed(3)}</span>
                      </div>
                      <p>{chunk.citation}</p>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className="emptyState compact">No chunks retrieved yet.</div>
            )}
          </Panel>
        </div>

        <div className="mainPane">
          <Panel title="Retrieval quality" icon={<Target size={17} />}>
            {result ? (
              <div className="ragQualityGrid">
                <div>
                  <span>Precision@1</span>
                  <strong>{result.precisionAt1.toFixed(2)}</strong>
                </div>
                <div>
                  <span>Recall@{result.recallK}</span>
                  <strong>{result.recallAtK.toFixed(2)}</strong>
                </div>
                <div className="wide">
                  <span>Relevant</span>
                  <strong>{result.relevant.join(', ')}</strong>
                </div>
                <div className="wide">
                  <span>Retrieved</span>
                  <strong>{result.retrievedDocIds.join(', ')}</strong>
                </div>
              </div>
            ) : (
              <div className="emptyState compact">No fixture run yet.</div>
            )}
          </Panel>
          <EvalPanel
            error={error}
            evalOk={result?.evalOk}
            issues={result?.issues ?? []}
            passedLabel="grounded + relevant retrieval"
            running={running}
          />
        </div>

        <div className="rightPane">
          <TracePanel running={running} trace={result?.trace ?? []} />
        </div>
      </section>
    </main>
  );
}
