/**
 * Markdown Component
 *
 * Session content — agent messages, plans, issue and pull-request bodies —
 * renders through here, so the renderer is a STATIC import. There is no chunk
 * to fetch before a message can be shown, no loading placeholder between the
 * transcript arriving and the transcript being readable, and an unresolvable
 * dependency fails the build instead of turning every message in the app into
 * a runtime error placeholder.
 *
 * The weight that once justified a lazy wrapper here is the Prism grammar set,
 * not the Markdown parser. That boundary now lives one level down, in
 * `MarkdownCodeBlock`, where the cost of a miss is uncoloured code rather than
 * missing content. `react-syntax-highlighter` and `refractor` must therefore
 * stay unreachable from this module's static graph —
 * `markdownRendererBoundary.test.ts` and
 * `src/app/root/__tests__/startupGraph.test.ts` pin both halves of that.
 */
import React from "react";

import MarkdownImpl, { type MarkdownProps } from "./MarkDownImpl";
import { MarkdownFallbackBoundary } from "./MarkdownFallbackBoundary";

/**
 * Markdown renderer.
 *
 * A crash inside the renderer degrades to the message's own source text, which
 * stays readable and selectable, rather than to an error string.
 */
const Markdown: React.FC<MarkdownProps> = (props) => (
  <MarkdownFallbackBoundary
    label="Markdown preview"
    resetKey={props.textContent}
    fallback={
      <div className="chat-text allow-select-deep wrap-break-word whitespace-pre-wrap">
        {props.textContent}
      </div>
    }
  >
    <MarkdownImpl {...props} />
  </MarkdownFallbackBoundary>
);

Markdown.displayName = "Markdown";

export default Markdown;
