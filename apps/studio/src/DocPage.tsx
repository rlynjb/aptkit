import React from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Renders a markdown document as an in-Studio page. */
export function DocPage({
  title,
  markdown,
  sourceHref,
  onHome,
}: {
  title: string;
  markdown: string;
  sourceHref: string;
  onHome: () => void;
}) {
  return (
    <main className="shell">
      <header className="topbar">
        <div className="docTitleRow">
          <button type="button" className="topbarLink" onClick={onHome}>
            <ArrowLeft size={15} />
            <span>Studio</span>
          </button>
          <div>
            <p className="eyebrow">AptKit Studio</p>
            <h1>{title}</h1>
          </div>
        </div>
        <div className="topbarLinks">
          <a className="topbarLink" href={sourceHref} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={15} />
            <span>View source</span>
          </a>
        </div>
      </header>

      <article className="docPage">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </article>
    </main>
  );
}
