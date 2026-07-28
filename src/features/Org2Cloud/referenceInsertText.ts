/**
 * What gets typed into a text surface when a session reference is inserted
 * — by drag, by the `@` menu, anywhere.
 *
 * The BARE reference, deliberately. Wrapping it in a titled markdown link
 * reads better while composing, and was tried, but GitHub strips the
 * anchor and href from a non-http scheme and renders only the label. That
 * costs both properties this feature depends on:
 *
 * - the id disappears from github.com, so a reader cannot tell a reference
 *   is there at all, and copying the rendered text loses it entirely;
 * - the session TITLE becomes plain text for anyone who can see the repo,
 *   when the whole premise is that an outsider learns nothing. A title
 *   leaks far more than an opaque uuid does.
 *
 * The draft being briefly ugly is the cheaper cost, and in-app the chip
 * shows the real session name anyway once it renders.
 */
export function referenceInsertText(reference: string): string {
  return reference;
}
