import React, { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import "@src/components/MarkDown/index.scss";

export interface PortableMarkdownProps {
  textContent: string;
}

/**
 * Browser-safe subset of the desktop session Markdown renderer.
 *
 * The syntax and stylesheet match desktop chat, while desktop-only actions
 * (Tauri file opening, hover previews, Mermaid and canvas blocks) stay out of
 * the public mobile bundle.
 */
const PortableMarkdown: React.FC<PortableMarkdownProps> = memo(
  ({ textContent }) => (
    <ReactMarkdown className="chat-markdown-body" remarkPlugins={[remarkGfm]}>
      {textContent}
    </ReactMarkdown>
  )
);

PortableMarkdown.displayName = "PortableMarkdown";

export default PortableMarkdown;
