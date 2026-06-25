import React from 'react';
import { Activity, BookOpen, BookText, ChevronRight, CircleDollarSign, Database, Github, MessageSquareText, Package, Scale, SearchCheck } from 'lucide-react';
import GithubSlugger from 'github-slugger';
import { ECOMMERCE_ANOMALY_CATEGORIES, coverageReport, schemaCapabilities } from '@aptkit/agent-anomaly-monitoring';
import { diagnosticFixtures, fixtures, monitoringFixtures, queryFixtures, rubricImprovementFixtures } from './fixtures';
import { ragQueryFixtures } from './rag-query-fixtures';
import type { StudioView } from './types';

/** Slug a heading the same way rehype-slug does in DocPage, so deep-links land on the right section. */
const apiAnchor = (heading: string) => new GithubSlugger().slug(heading);

/**
 * The non-agent packages aptkit ships. These aren't runnable workspaces — each
 * deep-links into its section of the in-Studio API Reference.
 */
const TOOLKIT_PACKAGES: { name: string; summary: string; heading: string }[] = [
  {
    name: '@aptkit/runtime',
    summary: 'Bounded agent loop, the ModelProvider contract, structured generation, and the CapabilityEvent trace.',
    heading: '4. Runtime',
  },
  {
    name: '@aptkit/providers',
    summary: 'Local Gemma over Ollama, a context-window guard, cloud adapters, and a fallback chain — all behind one contract.',
    heading: '5. Providers',
  },
  {
    name: '@aptkit/retrieval',
    summary: 'From-scratch RAG: embed → cosine search → rank, behind swappable EmbeddingProvider / VectorStore contracts.',
    heading: '6. Retrieval (RAG)',
  },
  {
    name: '@aptkit/memory',
    summary: 'Episodic conversation memory that reuses the retrieval contracts to remember and recall past turns.',
    heading: 'Conversation memory — `packages/memory/src/conversation-memory.ts`',
  },
  {
    name: '@aptkit/tools',
    summary: 'A tool registry plus least-privilege policies that gate which tools an agent may call.',
    heading: '7. Tools & policy',
  },
  {
    name: '@aptkit/prompts + @aptkit/context',
    summary: 'Versioned prompt packages and workspace / profile context injection.',
    heading: '8. Prompts & context',
  },
  {
    name: '@aptkit/evals',
    summary: 'precision@k / recall@k retrieval scoring, an LLM rubric judge, structural diff, and detection scoring.',
    heading: '9. Evals',
  },
  {
    name: '@aptkit/workflows',
    summary: 'Compose multi-step content workflows on top of the runtime.',
    heading: 'Appendix: Workflows',
  },
];

export function StudioHome({ onOpen }: { onOpen: (view: StudioView, anchor?: string) => void }) {
  const monitoringCoverage = coverageReport(
    ECOMMERCE_ANOMALY_CATEGORIES,
    schemaCapabilities(monitoringFixtures[0].workspace),
  );
  const fullCoverage = monitoringCoverage.filter((item) => item.coverage === 'full').length;
  const limitedCoverage = monitoringCoverage.filter((item) => item.coverage === 'limited').length;

  return (
    <main className="shell shellNarrow">
      <header className="topbar">
        <p className="brandTitle">AptKit Studio</p>
        <nav className="topbarLinks">
          <button type="button" className="topbarLink" onClick={() => onOpen('api-docs')}>
            <BookOpen size={14} />
            <span>api reference</span>
          </button>
          <button type="button" className="topbarLink" onClick={() => onOpen('user-guide')}>
            <BookText size={14} />
            <span>user guide</span>
          </button>
          <a
            className="topbarLink"
            href="https://www.npmjs.com/package/@rlynjb/aptkit-core"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Package size={14} />
            <span>npm</span>
          </a>
          <a
            className="topbarLink"
            href="https://github.com/rlynjb/aptkit"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Github size={14} />
            <span>github</span>
          </a>
        </nav>
      </header>

      <section className="homeIntro">
        <p>
          A provider-neutral toolkit for building local-first LLM agents — a bounded agent loop,
          swappable model providers, and a from-scratch RAG pipeline, all behind small contracts.
          Studio replays each capability from recorded fixtures so you can read, evaluate, and
          compare the output in the browser.
        </p>
      </section>

      <section className="homeSection" aria-label="Available capabilities">
        <div className="sectionLabel">capabilities</div>
        <div className="capabilityGrid">
          <CapabilityCard
            icon={<CircleDollarSign size={18} />}
            title="Recommendation Agent"
            status="recommendation"
            summary="Replay ecommerce recommendations, compare fixture vs OpenAI, save artifacts, and promote fixtures."
            details={[`${fixtures.length} fixtures`, 'fixture/openai compare', 'replay promotion']}
            onOpen={() => onOpen('recommendation')}
          />
          <CapabilityCard
            icon={<Activity size={18} />}
            title="Anomaly Monitoring Agent"
            status="monitoring"
            summary="Scan ecommerce workspace data for seeded anomaly categories with trace and coverage review."
            details={[
              `${monitoringFixtures.length} fixture`,
              `${fullCoverage} full / ${limitedCoverage} limited`,
              'deterministic replay',
            ]}
            onOpen={() => onOpen('monitoring')}
          />
          <CapabilityCard
            icon={<SearchCheck size={18} />}
            title="Diagnostic Investigation Agent"
            status="diagnostic"
            summary="Investigate a known anomaly, test hypotheses, and return evidence-backed diagnosis output."
            details={[`${diagnosticFixtures.length} fixture`, 'hypothesis/evidence', 'deterministic replay']}
            onOpen={() => onOpen('diagnostic')}
          />
          <CapabilityCard
            icon={<MessageSquareText size={18} />}
            title="Query Agent"
            status="query"
            summary="Ask a free-form workspace question and get a grounded prose answer from allowed tools."
            details={[`${queryFixtures.length} fixture`, 'natural-language answer', 'fixture/openai replay']}
            onOpen={() => onOpen('query')}
          />
          <CapabilityCard
            icon={<Scale size={18} />}
            title="Rubric Improvement Agent"
            status="rubric"
            summary="Score a subject against a rubric, use recent judgment history, and generate one focused next action."
            details={[`${rubricImprovementFixtures.length} fixture`, 'rubric scoring', 'agentic loop']}
            onOpen={() => onOpen('rubric-improvement')}
          />
          <CapabilityCard
            icon={<Database size={18} />}
            title="RAG Query Agent"
            status="rag query"
            summary="Retrieve from an in-memory knowledge base and answer grounded, cited questions, scored with precision@k / recall@k."
            details={[`${ragQueryFixtures.length} fixtures`, 'embed → search → cite', 'in-browser rag']}
            onOpen={() => onOpen('rag-query')}
          />
        </div>
      </section>

      <section className="homeSection" aria-label="Other packages in the toolkit">
        <div className="sectionLabel">also in the toolkit</div>
        <div className="packageGrid">
          {TOOLKIT_PACKAGES.map((pkg) => (
            <button
              key={pkg.name}
              type="button"
              className="packageItem"
              onClick={() => onOpen('api-docs', apiAnchor(pkg.heading))}
            >
              <span className="packageName">
                <code>{pkg.name}</code>
                <ChevronRight size={13} aria-hidden="true" />
              </span>
              <span className="packageSummary">{pkg.summary}</span>
            </button>
          ))}
        </div>
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
        <div className="capabilityTitleBlock">
          <h2>{title}</h2>
          <span className="capabilityStatus">{status}</span>
        </div>
      </div>
      <p>{summary}</p>
      <div className="capabilityStats">
        {details.map((detail) => (
          <span key={detail}>{detail}</span>
        ))}
      </div>
    </article>
  );
}
