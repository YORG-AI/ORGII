import React from "react";

import { getLanguageFromPath } from "@src/config/languageMap";
import {
  EVENT_SNIPPET_INNER_PADDING_CLASS,
  getEventBlockContainerClasses,
} from "@src/engines/ChatPanel/blocks/primitives/config";
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
      className={`${getEventBlockContainerClasses()} min-w-0`}
      data-mobile-file-preview={target.diff ? "diff" : "code"}
      data-mobile-highlight-language={language}
      data-mobile-file-line={target.line}
    >
      <div className="scrollbar-hide max-h-80 overflow-auto">
        <pre
          className={`chat-code prism-html m-0 min-w-max whitespace-pre ${EVENT_SNIPPET_INNER_PADDING_CLASS} leading-normal text-text-2`}
        >
          {highlightedHtml ? (
            <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
          ) : (
            <code>{source}</code>
          )}
        </pre>
      </div>
    </div>
  );
}

MobileFilePreview.displayName = "MobileFilePreview";
