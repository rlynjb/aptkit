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

function App() {
  const [view, setView] = React.useState<StudioView>('home');
  const [docAnchor, setDocAnchor] = React.useState<string>();

  // Navigate, optionally carrying a doc section to scroll to (used by the
  // home package list to deep-link into the API Reference).
  const openView = (next: StudioView, anchor?: string) => {
    setDocAnchor(anchor);
    setView(next);
  };

  if (view === 'recommendation') {
    return <RecommendationWorkspace onHome={() => setView('home')} />;
  }

  if (view === 'monitoring') {
    return <MonitoringWorkspace onHome={() => setView('home')} />;
  }

  if (view === 'diagnostic') {
    return <DiagnosticWorkspace onHome={() => setView('home')} />;
  }

  if (view === 'query') {
    return <QueryWorkspace onHome={() => setView('home')} />;
  }

  if (view === 'rubric-improvement') {
    return <RubricImprovementWorkspace onHome={() => setView('home')} />;
  }

  if (view === 'rag-query') {
    return <RagQueryWorkspace onHome={() => setView('home')} />;
  }

  if (view === 'api-docs') {
    return (
      <DocPage
        title="API Reference"
        markdown={coreApiMarkdown}
        sourceHref={`${REPO_DOCS}/core-api.md`}
        onHome={() => setView('home')}
        anchor={docAnchor}
      />
    );
  }

  if (view === 'user-guide') {
    return (
      <DocPage
        title="Studio Guide — Reading & Evaluating Output"
        markdown={userGuideMarkdown}
        sourceHref={`${REPO_DOCS}/studio-guide.md`}
        onHome={() => setView('home')}
      />
    );
  }

  return <StudioHome onOpen={openView} />;
}

const rootHost = window as Window & { __aptkitStudioRoot?: ReturnType<typeof createRoot> };
rootHost.__aptkitStudioRoot ??= createRoot(document.getElementById('root')!);
rootHost.__aptkitStudioRoot.render(<App />);
