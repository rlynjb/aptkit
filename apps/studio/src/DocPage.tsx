import React from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import GithubSlugger from 'github-slugger';

type TocEntry = { depth: number; text: string; slug: string };

/** Extract H2/H3 headings into a TOC, slugged to match rehype-slug's anchor ids. */
function buildToc(markdown: string): TocEntry[] {
  const slugger = new GithubSlugger();
  const entries: TocEntry[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = match[2].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
    entries.push({ depth: match[1].length, text, slug: slugger.slug(text) });
  }
  return entries;
}

/** Renders a markdown document as an in-Studio page with a table of contents. */
export function DocPage({
  title,
  markdown,
  sourceHref,
  onHome,
  routeToken,
  anchor,
}: {
  title: string;
  markdown: string;
  sourceHref: string;
  onHome: () => void;
  /** This page's route segment (e.g. 'api-docs'), used to build section hash links. */
  routeToken: string;
  anchor?: string;
}) {
  const toc = React.useMemo(() => buildToc(markdown), [markdown]);

  // When a target section is in the route (e.g. #api-docs/conversation-memory),
  // scroll to that heading after the markdown has rendered and laid out.
  React.useEffect(() => {
    if (!anchor) return;
    const id = window.requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
    });
    return () => window.cancelAnimationFrame(id);
  }, [anchor]);

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

      <div className="docLayout">
        {toc.length > 1 ? (
          <nav className="docToc" aria-label="Table of contents">
            <p className="docTocTitle">On this page</p>
            <ul>
              {toc.map((entry) => (
                <li key={entry.slug}>
                  <a className={`docTocLink h${entry.depth}`} href={`#${routeToken}/${entry.slug}`}>
                    {entry.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}

        <article className="docPage">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]}>
            {markdown}
          </ReactMarkdown>
        </article>
      </div>
    </main>
  );
}
