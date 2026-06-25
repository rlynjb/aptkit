import React from 'react';
import { createRoot } from 'react-dom/client';
import { RecommendationWorkspace } from './RecommendationWorkspace';
import { MonitoringWorkspace } from './MonitoringWorkspace';
import { DiagnosticWorkspace } from './DiagnosticWorkspace';
import { QueryWorkspace } from './QueryWorkspace';
import { RubricImprovementWorkspace } from './RubricImprovementWorkspace';
import { RagQueryWorkspace } from './RagQueryWorkspace';
import { StudioHome } from './StudioHome';
import { DocPage } from './DocPage';
import type { StudioView } from './types';
import coreApiMarkdown from '../../../docs/core-api.md?raw';
import userGuideMarkdown from '../../../docs/studio-guide.md?raw';
import './styles.css';

const REPO_DOCS = 'https://github.com/rlynjb/aptkit/blob/main/docs';

// Hash routing: every view has a URL (#api-docs, #user-guide, #rag-query, …) so
// pages are linkable, bookmarkable, and survive a refresh. Hash-based because the
// GitHub Pages deploy is static (no SPA/404 fallback) and served under /aptkit/.
// Doc sections live after a slash (#api-docs/conversation-memory) so the existing
// slug anchors keep working without colliding with the route.
const VIEW_TOKENS: StudioView[] = [
  'recommendation',
  'monitoring',
  'diagnostic',
  'query',
  'rubric-improvement',
  'rag-query',
  'api-docs',
  'user-guide',
];

function parseHash(): { view: StudioView; anchor?: string } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw) return { view: 'home' };
  const slash = raw.indexOf('/');
  const token = slash === -1 ? raw : raw.slice(0, slash);
  const anchor = slash === -1 ? undefined : raw.slice(slash + 1) || undefined;
  const view = (VIEW_TOKENS as string[]).includes(token) ? (token as StudioView) : 'home';
  return { view, anchor: view === 'home' ? undefined : anchor };
}

function App() {
  const [route, setRoute] = React.useState(parseHash);

  React.useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = (next: StudioView, anchor?: string) => {
    const hash = next === 'home' ? '' : anchor ? `${next}/${anchor}` : next;
    if (window.location.hash.replace(/^#\/?/, '') === hash) {
      setRoute(parseHash()); // already on this hash; sync state without a hashchange
      return;
    }
    window.location.hash = hash; // fires hashchange -> setRoute
  };

  const { view, anchor } = route;
  const home = () => navigate('home');

  if (view === 'recommendation') {
    return <RecommendationWorkspace onHome={home} />;
  }

  if (view === 'monitoring') {
    return <MonitoringWorkspace onHome={home} />;
  }

  if (view === 'diagnostic') {
    return <DiagnosticWorkspace onHome={home} />;
  }

  if (view === 'query') {
    return <QueryWorkspace onHome={home} />;
  }

  if (view === 'rubric-improvement') {
    return <RubricImprovementWorkspace onHome={home} />;
  }

  if (view === 'rag-query') {
    return <RagQueryWorkspace onHome={home} />;
  }

  if (view === 'api-docs') {
    return (
      <DocPage
        title="API Reference"
        markdown={coreApiMarkdown}
        sourceHref={`${REPO_DOCS}/core-api.md`}
        onHome={home}
        routeToken="api-docs"
        anchor={anchor}
      />
    );
  }

  if (view === 'user-guide') {
    return (
      <DocPage
        title="Studio Guide — Reading & Evaluating Output"
        markdown={userGuideMarkdown}
        sourceHref={`${REPO_DOCS}/studio-guide.md`}
        onHome={home}
        routeToken="user-guide"
        anchor={anchor}
      />
    );
  }

  return <StudioHome onOpen={navigate} />;
}

const rootHost = window as Window & { __aptkitStudioRoot?: ReturnType<typeof createRoot> };
rootHost.__aptkitStudioRoot ??= createRoot(document.getElementById('root')!);
rootHost.__aptkitStudioRoot.render(<App />);
