/**
 * MarkdownCodeHighlighter
 *
 * The Prism-rendered body of a Markdown code fence.
 *
 * Split out from `MarkdownCodeBlock` so `react-syntax-highlighter` and the
 * refractor grammar set stay behind a dynamic `import()`. They are the bulk of
 * what the Markdown renderer used to drag around, and they are needed only to
 * colour code — never to display it. Until this module lands (or if it never
 * does) the caller shows the same code as plain text, so the fence is readable
 * either way.
 */
import React from "react";

import { codeMirrorPrismTheme } from "@src/features/CodeMirror/themes/prism";
import { PrismLight as SyntaxHighlighterPrism } from "@src/util/language/prismLight";

const SyntaxHighlighter =
  SyntaxHighlighterPrism as unknown as React.ComponentType<
    Record<string, unknown>
  >;

const CODE_CUSTOM_STYLE: React.CSSProperties = {
  fontFamily: "var(--cm-font-family)",
  fontSize: "12px",
  lineHeight: "1.6",
  margin: 0,
  padding: "12px 14px",
  borderRadius: "8px",
  background: "transparent",
};

export interface MarkdownCodeHighlighterProps {
  code: string;
  language: string;
}

const MarkdownCodeHighlighter: React.FC<MarkdownCodeHighlighterProps> = ({
  code,
  language,
}) => (
  <SyntaxHighlighter
    customStyle={CODE_CUSTOM_STYLE}
    style={codeMirrorPrismTheme}
    language={language}
    PreTag="div"
    showLineNumbers={false}
    wrapLongLines
    wrapLines={true}
  >
    {code}
  </SyntaxHighlighter>
);

MarkdownCodeHighlighter.displayName = "MarkdownCodeHighlighter";

export default MarkdownCodeHighlighter;
