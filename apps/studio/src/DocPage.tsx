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
  anchor,
}: {
  title: string;
  markdown: string;
  sourceHref: string;
  onHome: () => void;
  anchor?: string;
}) {
  const toc = React.useMemo(() => buildToc(markdown), [markdown]);

  // When opened with a target section (e.g. from the Studio home package list),
  // scroll to that heading once the markdown has rendered.
  React.useEffect(() => {
    if (!anchor) return;
    document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
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
                  <a className={`docTocLink h${entry.depth}`} href={`#${entry.slug}`}>
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
