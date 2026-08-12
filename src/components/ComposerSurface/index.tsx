/**
 * ComposerSurface
 *
 * Shared shell and bottom action row for editor-backed composers. Session,
 * create, issue, and review surfaces provide their editor content as children
 * while this component keeps their shell padding and left/right action
 * positions identical.
 */
import React, { forwardRef } from "react";

import ComposerBar from "@src/components/ComposerBar";
import ComposerShell from "@src/components/ComposerShell";
import type { ComposerShellProps } from "@src/components/ComposerShell";

export interface ComposerSurfaceProps extends Omit<
  ComposerShellProps,
  "children"
> {
  children?: React.ReactNode;
  /** Optional content at the left edge of the shared bottom action row. */
  leadingActions?: React.ReactNode;
  /** Optional content at the right edge of the shared bottom action row. */
  trailingActions?: React.ReactNode;
  /** Enables the standard add-content control when paired with `onUpload`. */
  onAddContent?: () => void;
  /** Enables the standard add-content control when paired with `onAddContent`. */
  onUpload?: () => void;
  onOpenSkillsTools?: () => void;
  dropdownDirection?: "up" | "down";
  showContextInfo?: boolean;
  repoPath?: string;
}

const ComposerSurface = forwardRef<HTMLDivElement, ComposerSurfaceProps>(
  function ComposerSurface(
    {
      children,
      leadingActions,
      trailingActions,
      onAddContent,
      onUpload,
      onOpenSkillsTools,
      dropdownDirection = "up",
      showContextInfo = false,
      repoPath,
      ...shellProps
    },
    ref
  ) {
    return (
      <ComposerShell ref={ref} {...shellProps}>
        {children}
        <ComposerBar
          onAddContent={onAddContent}
          onUpload={onUpload}
          onOpenSkillsTools={onOpenSkillsTools}
          dropdownDirection={dropdownDirection}
          leftPrefix={leadingActions}
          repoPath={repoPath}
          submitButton={trailingActions}
          hideAddButton={!onAddContent || !onUpload}
          showContextInfo={showContextInfo}
        />
      </ComposerShell>
    );
  }
);

ComposerSurface.displayName = "ComposerSurface";

export default ComposerSurface;
