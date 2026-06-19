export type MarkdownSection = {
  heading?: string;
  content: string;
};

/**
 * Splits markdown into ordered sections by h2 (`##`) headings. H3+ headings
 * stay inside the current section, matching Dryrun's source-document workflow.
 */
export function splitMarkdownSections(markdown: string): MarkdownSection[] {
  if (markdown.trim().length === 0) return [];

  const sections: MarkdownSection[] = [];
  let heading: string | undefined;
  let body: string[] = [];

  function flush(): void {
    const content = body.join('\n').trim();
    if (content.length > 0 || heading !== undefined) {
      sections.push(heading === undefined ? { content } : { heading, content });
    }
    body = [];
  }

  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('## ') && !trimmed.startsWith('### ')) {
      flush();
      heading = trimmed.slice(3).trim();
    } else {
      body.push(line);
    }
  }
  flush();

  if (sections.length === 0) return [{ content: markdown.trim() }];
  return sections;
}
