/**
 * Options controlling how a profile is injected into a system template.
 */
export type InjectProfileOptions = {
  /** Where to place the profile block. Defaults to 'start' (prepend). */
  position?: 'start' | 'end';
  /** Optional heading line emitted immediately before the profile block. */
  heading?: string;
};

/**
 * Injects a profile document (e.g. me.md) into a system-prompt template.
 *
 * Pure string-in / string-out: the caller reads the file; this package never
 * touches `fs`. Injection happens BEFORE template rendering, so the result
 * remains a valid template that `renderPromptTemplate` (@aptkit/prompts) can
 * still render — placeholders like `{schema}` in `systemTemplate` are left
 * untouched.
 *
 * @param systemTemplate the system prompt template (may contain `{placeholder}`s)
 * @param profileText the profile content to inject
 * @param opts.position 'start' to prepend (default), 'end' to append
 * @param opts.heading optional line placed immediately before the profile block
 */
export function injectProfile(
  systemTemplate: string,
  profileText: string,
  opts?: InjectProfileOptions,
): string {
  const position = opts?.position ?? 'start';
  const heading = opts?.heading;

  const block = heading ? `${heading}\n${profileText}` : profileText;

  return position === 'end'
    ? `${systemTemplate}\n\n${block}`
    : `${block}\n\n${systemTemplate}`;
}
