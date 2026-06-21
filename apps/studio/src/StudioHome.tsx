import React from 'react';
import { Activity, BookOpen, BookText, Boxes, CircleDollarSign, Database, Github, MessageSquareText, Package, Play, Scale, SearchCheck } from 'lucide-react';
import { ECOMMERCE_ANOMALY_CATEGORIES, coverageReport, schemaCapabilities } from '@aptkit/agent-anomaly-monitoring';
import { diagnosticFixtures, fixtures, monitoringFixtures, queryFixtures, rubricImprovementFixtures } from './fixtures';
import { ragQueryFixtures } from './rag-query-fixtures';
import type { StudioView } from './types';

export function StudioHome({ onOpen }: { onOpen: (view: StudioView) => void }) {
  const monitoringCoverage = coverageReport(
    ECOMMERCE_ANOMALY_CATEGORIES,
    schemaCapabilities(monitoringFixtures[0].workspace),
  );
  const fullCoverage = monitoringCoverage.filter((item) => item.coverage === 'full').length;
  const limitedCoverage = monitoringCoverage.filter((item) => item.coverage === 'limited').length;

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AptKit Studio</p>
          <h1>Capability Gallery</h1>
        </div>
        <div className="topbarLinks">
          <button type="button" className="topbarLink" onClick={() => onOpen('api-docs')}>
            <BookOpen size={15} />
            <span>API Reference</span>
          </button>
          <button type="button" className="topbarLink" onClick={() => onOpen('user-guide')}>
            <BookText size={15} />
            <span>User Guide</span>
          </button>
          <a
            className="topbarLink"
            href="https://www.npmjs.com/package/@rlynjb/aptkit-core"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Package size={15} />
            <span>npm</span>
          </a>
          <a
            className="topbarLink"
            href="https://github.com/rlynjb/aptkit"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Github size={15} />
            <span>GitHub</span>
          </a>
        </div>
      </header>

      <section className="capabilityGrid" aria-label="Available capabilities">
        <CapabilityCard
          icon={<CircleDollarSign size={20} />}
          title="Recommendation Agent"
          status="Ready"
          summary="Replay ecommerce recommendations, compare fixture vs OpenAI, save artifacts, and promote fixtures."
          details={[
            `${fixtures.length} fixtures`,
            'Fixture/OpenAI comparison',
            'Replay promotion workflow',
          ]}
          onOpen={() => onOpen('recommendation')}
        />
        <CapabilityCard
          icon={<Activity size={20} />}
          title="Anomaly Monitoring Agent"
          status="Fixture ready"
          summary="Scan ecommerce workspace data for seeded anomaly categories with trace and coverage review."
          details={[
            `${monitoringFixtures.length} fixture`,
            `${fullCoverage} full / ${limitedCoverage} limited categories`,
            'Deterministic monitoring replay',
          ]}
          onOpen={() => onOpen('monitoring')}
        />
        <CapabilityCard
          icon={<SearchCheck size={20} />}
          title="Diagnostic Investigation Agent"
          status="Fixture ready"
          summary="Investigate a known anomaly, test hypotheses, and return evidence-backed diagnosis output."
          details={[
            `${diagnosticFixtures.length} fixture`,
            'Hypothesis/evidence output',
            'Deterministic diagnostic replay',
          ]}
          onOpen={() => onOpen('diagnostic')}
        />
        <CapabilityCard
          icon={<MessageSquareText size={20} />}
          title="Query Agent"
          status="Fixture ready"
          summary="Ask a free-form workspace question and get a grounded prose answer from allowed tools."
          details={[
            `${queryFixtures.length} fixture`,
            'Natural-language answer',
            'Fixture/OpenAI replay',
          ]}
          onOpen={() => onOpen('query')}
        />
        <CapabilityCard
          icon={<Scale size={20} />}
          title="Rubric Improvement Agent"
          status="Fixture ready"
          summary="Score a subject against a rubric, use recent judgment history, and generate one focused next action."
          details={[
            `${rubricImprovementFixtures.length} fixture`,
            'Rubric scoring output',
            'Agentic improvement loop',
          ]}
          onOpen={() => onOpen('rubric-improvement')}
        />
        <CapabilityCard
          icon={<Database size={20} />}
          title="RAG Query Agent"
          status="Fixture ready"
          summary="Retrieve from an in-memory knowledge base and answer grounded, cited questions, scored with precision@k / recall@k."
          details={[
            `${ragQueryFixtures.length} fixtures`,
            'Embed → cosine search → cite',
            'Deterministic in-browser RAG',
          ]}
          onOpen={() => onOpen('rag-query')}
        />
        <CapabilityCard
          icon={<Boxes size={20} />}
          title="Runtime & Eval Utilities"
          status="Preview ready"
          summary="Exercise structured generation, rubric judging, content workflows, provider fallback, and local context guards."
          details={[
            '4 utility previews',
            'Fixture providers',
            'Trace and retry review',
          ]}
          onOpen={() => onOpen('capabilities')}
        />
      </section>
    </main>
  );
}

export function CapabilityCard({
  icon,
  title,
  status,
  summary,
  details,
  onOpen,
}: {
  icon: React.ReactNode;
  title: string;
  status: string;
  summary: string;
  details: string[];
  onOpen: () => void;
}) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen();
    }
  };

  return (
    <article
      className="capabilityCard"
      onClick={onOpen}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
    >
      <div className="capabilityCardHeader">
        <div className="capabilityIcon">{icon}</div>
        <span>{status}</span>
      </div>
      <h2>{title}</h2>
      <p>{summary}</p>
      <div className="capabilityStats">
        {details.map((detail) => (
          <strong key={detail}>{detail}</strong>
        ))}
      </div>
      <div className="primaryAction capabilityCardAction" aria-hidden="true">
        <Play size={15} />
        <span>Open</span>
      </div>
    </article>
  );
}
