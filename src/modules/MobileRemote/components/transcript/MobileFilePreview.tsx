import React from "react";

import { getLanguageFromPath } from "@src/config/languageMap";
import { useSyntaxHighlight } from "@src/hooks/code/useSyntaxHighlight";
import { getLanguageFromFilePath } from "@src/util/editor/extension";

import type { MobileFileTarget } from "./mobileFileTool";

export interface MobileFilePreviewProps {
  target: MobileFileTarget;
}

/**
 * Browser-safe file preview using the same lazy Prism pipeline and theme
 * tokens as Desktop ChatPanel output. The source text remains visible while
 * the grammar chunk loads or when a language is unsupported.
 */
export default function MobileFilePreview({ target }: MobileFilePreviewProps) {
  const source = target.diff ?? target.content ?? "";
  const language = target.diff
    ? "diff"
    : target.language ||
      getLanguageFromFilePath(target.filePath) ||
      getLanguageFromPath(target.filePath) ||
      "text";
  const highlightedHtml = useSyntaxHighlight(source, {
    lang: language,
    enabled: source.length > 0,
  });

  if (!source) return null;

  return (
    <div
      className="overflow-x-auto rounded-lg border border-border-2 bg-bg-2"
      data-mobile-file-preview={target.diff ? "diff" : "code"}
      data-mobile-highlight-language={language}
    >
      {target.line ? (
        <div className="chat-code-xs border-b border-border-2 px-3 py-1.5 text-text-3">
          {target.fileName}:{target.line}
        </div>
      ) : null}
      <pre className="chat-code-sm prism-html m-0 min-w-max whitespace-pre p-3 leading-5 text-text-2">
        {highlightedHtml ? (
          <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
        ) : (
          <code>{source}</code>
        )}
      </pre>
    </div>
  );
}

MobileFilePreview.displayName = "MobileFilePreview";
