/**
 * Shared GitHub-style timeline primitives.
 *
 * Extracted from `IssuesContent/IssueDetailPanel.tsx` so the PR Conversation
 * tab and the Issue detail view render identical timeline cards (avatar +
 * "user did X · time" header, connected vertical rail, copy button, markdown
 * body). Keeping one source prevents the two surfaces from drifting.
 */
import { Check, Clipboard } from "lucide-react";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Markdown from "@src/components/MarkDown";
import { useCopyCheck } from "@src/hooks/ui";
import { copyText } from "@src/util/data/clipboard";

const GITHUB_IMAGE_TAG_RE = /<img\b([^>]*)\/?>/gi;
const IMAGE_ATTR_RE = /([\w:-]+)\s*=\s*(["'])(.*?)\2/g;

function sanitizeMarkdownImageAlt(value: string): string {
  return value.split("[").join("").split("]").join("");
}

/**
 * Rewrite raw GitHub `<img>` tags into markdown image syntax so the shared
 * `Markdown` renderer (which skips HTML) still shows uploaded screenshots.
 */
export function normalizeGitHubMarkdownBody(body: string): string {
  return body.replace(GITHUB_IMAGE_TAG_RE, (match, rawAttrs: string) => {
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

/** GitHub-issue/PR comment body rendered as markdown (or an empty-state note). */
export const GithubMarkdown = memo(function GithubMarkdown({
  body,
  emptyText,
}: {
  body: string;
  emptyText?: string;
}) {
  if (!body.trim()) {
    return (
      <div className="select-text text-[12px] italic leading-5 text-text-3">
        {emptyText}
      </div>
    );
  }
  return (
    <div className="chat-block-content max-w-[860px] select-text text-[12px] leading-5 text-text-2 [&_.chat-markdown-body]:select-text [&_.chat-markdown-body]:text-[12px] [&_.chat-markdown-body]:leading-5">
      <Markdown
        textContent={normalizeGitHubMarkdownBody(body)}
        skipPreprocess
      />
    </div>
  );
});

export function TimelineCopyButton({
  body,
}: {
  body: string;
}): React.ReactNode {
  const { t } = useTranslation("common");
  const onCopyContent = useCallback(async () => {
    await copyText(body);
  }, [body]);
  const { copied, handleCopy } = useCopyCheck(onCopyContent);

  if (!body.trim()) return null;

  return (
    <Button
      variant="tertiary"
      appearance="ghost"
      size="mini"
      iconOnly
      icon={
        copied ? (
          <Check size={12} strokeWidth={1.75} />
        ) : (
          <Clipboard size={12} strokeWidth={1.75} />
        )
      }
      title={copied ? t("status.copied") : t("actions.copy")}
      aria-label={copied ? t("status.copied") : t("actions.copy")}
      className="shrink-0 text-text-3 hover:bg-fill-2 hover:text-text-1"
      onClick={(event) => {
        event.stopPropagation();
        handleCopy();
      }}
    />
  );
}

/** A timeline entry with an optional connecting rail to the next item. */
export function ConnectedTimelineItem({
  children,
  isLast,
}: {
  children: React.ReactNode;
  isLast?: boolean;
}): React.ReactNode {
  return (
    <span className="flex min-w-0 flex-col">
      {children}
      {!isLast ? (
        <span
          className="-mt-px ml-5 h-3 border-l border-border-1"
          aria-hidden
        />
      ) : null}
    </span>
  );
}

/** A bordered timeline card: header row (+ optional copy button) over a body. */
export function TimelineCard({
  header,
  copyBody,
  children,
}: {
  header: React.ReactNode;
  copyBody?: string;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <span className="bg-surface-1 flex min-w-0 flex-1 flex-col rounded-xl border border-border-1 shadow-sm">
      <span className="flex min-w-0 select-text items-center justify-between gap-3 border-b border-border-1 px-3 py-2">
        {header}
        {copyBody ? <TimelineCopyButton body={copyBody} /> : null}
      </span>
      <span className="min-w-0 select-text px-3 py-3">{children}</span>
    </span>
  );
}
