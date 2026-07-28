/**
 * What actually gets typed into a text surface when a session reference is
 * inserted — by drag, by the `@` menu, anywhere.
 *
 * A bare url is unreadable while composing, so the reference is wrapped in
 * a markdown link titled with the session. That is one of the forms the
 * renderer turns into a chip, so the posted result is identical either
 * way; only the draft is easier to read. Brackets in a title would break
 * the link syntax, so they are stripped rather than escaped.
 */
export function referenceInsertText(reference: string, title?: string): string {
  const label = title?.replace(/[[\]]/gu, "").trim();
  return label ? `[${label}](${reference})` : reference;
}
