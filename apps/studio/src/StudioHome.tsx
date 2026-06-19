import React from 'react';
import { Activity, CircleDollarSign, MessageSquareText, Play, SearchCheck } from 'lucide-react';
import { ECOMMERCE_ANOMALY_CATEGORIES, coverageReport, schemaCapabilities } from '@aptkit/agent-anomaly-monitoring';
import { diagnosticFixtures, fixtures, monitoringFixtures, queryFixtures } from './fixtures';
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
  return (
    <article className="capabilityCard">
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
      <button className="primaryAction" type="button" onClick={onOpen}>
        <Play size={15} />
        <span>Open</span>
      </button>
    </article>
  );
}
