import React from 'react';
import { createRoot } from 'react-dom/client';
import { RecommendationWorkspace } from './RecommendationWorkspace';
import { MonitoringWorkspace } from './MonitoringWorkspace';
import { DiagnosticWorkspace } from './DiagnosticWorkspace';
import { QueryWorkspace } from './QueryWorkspace';
import { CapabilitiesWorkspace } from './CapabilitiesWorkspace';
import { StudioHome } from './StudioHome';
import type { StudioView } from './types';
import './styles.css';

function App() {
  const [view, setView] = React.useState<StudioView>('home');

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

  if (view === 'capabilities') {
    return <CapabilitiesWorkspace onHome={() => setView('home')} />;
  }

  return <StudioHome onOpen={setView} />;
}

const rootHost = window as Window & { __aptkitStudioRoot?: ReturnType<typeof createRoot> };
rootHost.__aptkitStudioRoot ??= createRoot(document.getElementById('root')!);
rootHost.__aptkitStudioRoot.render(<App />);
