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

/**
 * Nominal box for a markdown link's leading icon, shared by both variants so
 * a GitHub link and a file link never render at different sizes in the same
 * paragraph. `FileTypeIcon`'s "medium" token is the same 16px.
 *
 * The rendered size is re-stated in `em` by `.markdown-link-icon svg` in
 * `_base-elements.scss`: the markdown body inherits the chat font size, so a
 * fixed pixel box drifts out of proportion whenever the reader changes it.
 * These attributes are the intrinsic fallback and the aspect ratio.
 */
const LINK_ICON_SIZE = 16;

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
        <GitHubIcon width={LINK_ICON_SIZE} height={LINK_ICON_SIZE} />
      </span>
    );
  }

  if (target.kind !== "local") return null;

  return (
    <span aria-hidden="true" className={ICON_WRAPPER_CLASS}>
      <FileTypeIcon
        fileName={parseMarkdownFileRef(target.path).path}
        size="medium"
      />
    </span>
  );
};

MarkdownLinkIcon.displayName = "MarkdownLinkIcon";

export default MarkdownLinkIcon;
