import React from "react";

import { FileTreeHoverPreview } from "@src/components/FileTreePreview/exports";

import { parseMarkdownFileRef } from "./markdownFileRef";

/**
 * Matches `LinkHoverCard`'s mouseEnterDelay so a file link and a URL link in
 * the same paragraph open their cards on the same beat.
 */
export const MARKDOWN_FILE_HOVER_DELAY_MS = 350;

interface MarkdownFilePathHoverCardProps {
  /** Absolute workspace path, possibly carrying an agent's `:line` suffix. */
  path: string;
  workspaceRootPath?: string;
  children: React.ReactElement;
}

/**
 * Gives a workspace file link the same hover affordance a URL link already
 * has, reusing the existing `FileTreePreview` card so the tree, icons and
 * highlight stay identical to the one tool-call blocks show.
 */
const MarkdownFilePathHoverCard: React.FC<MarkdownFilePathHoverCardProps> = ({
  path,
  workspaceRootPath,
  children,
}) => {
  const filePath = parseMarkdownFileRef(path).path;
  if (!filePath) return children;

  return (
    <FileTreeHoverPreview
      path={filePath}
      itemType="file"
      repoPath={workspaceRootPath || undefined}
      as="span"
      // A markdown link sits mid-sentence. The component's default inline-flex
      // anchor would turn the whole link into an unbreakable box and stop the
      // paragraph from wrapping through it, so keep the anchor plain inline.
      display="inline"
      placement="bottom"
      showDelayMs={MARKDOWN_FILE_HOVER_DELAY_MS}
    >
      {children}
    </FileTreeHoverPreview>
  );
};

MarkdownFilePathHoverCard.displayName = "MarkdownFilePathHoverCard";

export default MarkdownFilePathHoverCard;
