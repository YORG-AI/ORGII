import React from "react";

import GitHubIcon from "@src/assets/channelIcons/github.svg";
import FileTypeIcon from "@src/components/FileTypeIcon";

import { parseMarkdownFileRef } from "./markdownFileRef";
import type { MarkdownLinkTarget } from "./markdownLinkTarget";

interface MarkdownLinkIconProps {
  href: string;
  target: MarkdownLinkTarget;
}

const ICON_WRAPPER_CLASS =
  "markdown-link-icon mr-1 inline-flex shrink-0 items-center justify-center leading-none";

export function isGitHubMarkdownHref(href: string): boolean {
  try {
    const url = new URL(href);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "github.com" || url.hostname === "www.github.com")
    );
  } catch {
    return false;
  }
}

export function hasMarkdownLinkIcon(
  href: string,
  target: MarkdownLinkTarget
): boolean {
  return target.kind === "local" || isGitHubMarkdownHref(href);
}

const MarkdownLinkIcon: React.FC<MarkdownLinkIconProps> = ({
  href,
  target,
}) => {
  if (isGitHubMarkdownHref(href)) {
    return (
      <span aria-hidden="true" className={ICON_WRAPPER_CLASS}>
        <GitHubIcon width={12} height={12} />
      </span>
    );
  }

  if (target.kind !== "local") return null;

  return (
    <span aria-hidden="true" className={ICON_WRAPPER_CLASS}>
      <FileTypeIcon
        fileName={parseMarkdownFileRef(target.path).path}
        size="tiny"
      />
    </span>
  );
};

MarkdownLinkIcon.displayName = "MarkdownLinkIcon";

export default MarkdownLinkIcon;
