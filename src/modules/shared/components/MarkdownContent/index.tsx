import React, { memo } from "react";

import ClampedContent from "@src/components/ClampedContent";
import Markdown from "@src/components/MarkDown";

const MARKDOWN_IMAGE_TAG_RE = /<img\b([^>]*)\/?>/gi;
const IMAGE_ATTR_RE = /([\w:-]+)\s*=\s*(["'])(.*?)\2/g;

/** Fifteen lines at the GitHub timeline body's 20px line height. */
export const MARKDOWN_CONTENT_PREVIEW_MAX_HEIGHT = 300;

function sanitizeMarkdownImageAlt(value: string): string {
  return value.split("[").join("").split("]").join("");
}

/**
 * Rewrite raw GitHub `<img>` tags into markdown image syntax so the shared
 * `Markdown` renderer (which skips HTML) still shows uploaded screenshots.
 */
export function normalizeMarkdownContent(body: string): string {
  return body.replace(MARKDOWN_IMAGE_TAG_RE, (match, rawAttrs: string) => {
    const attrs = new Map<string, string>();
    for (const attrMatch of rawAttrs.matchAll(IMAGE_ATTR_RE)) {
      attrs.set(attrMatch[1].toLowerCase(), attrMatch[3]);
    }
    const src = attrs.get("src");
    if (!src) return match;
    const alt = attrs.get("alt") ?? "image";
    return `![${sanitizeMarkdownImageAlt(alt)}](${src})`;
  });
}

export interface MarkdownContentProps {
  body: string;
  emptyText?: string;
  clamped?: boolean;
  maxHeight?: number;
  className?: string;
}

/** Shared Markdown body renderer for activity cards and editor previews. */
export const MarkdownContent = memo(function MarkdownContent({
  body,
  emptyText,
  clamped = true,
  maxHeight = MARKDOWN_CONTENT_PREVIEW_MAX_HEIGHT,
  className = "",
}: MarkdownContentProps) {
  if (!body.trim()) {
    return (
      <div
        className={`select-text text-[12px] italic leading-5 text-text-3 ${className}`.trim()}
      >
        {emptyText}
      </div>
    );
  }

  const content = (
    <div
      className={`chat-block-content w-full min-w-0 select-text text-[12px] leading-5 text-text-2 [&_.chat-markdown-body]:select-text [&_.chat-markdown-body]:text-[12px] [&_.chat-markdown-body]:leading-5 ${className}`.trim()}
    >
      <Markdown textContent={normalizeMarkdownContent(body)} skipPreprocess />
    </div>
  );

  if (!clamped) return content;

  return (
    <ClampedContent
      maxHeight={maxHeight}
      fadeFrom="from-primary-container"
      alwaysShowControl
    >
      {content}
    </ClampedContent>
  );
});
