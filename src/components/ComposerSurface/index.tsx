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

interface ComposerSurfaceProps extends Omit<ComposerShellProps, "children"> {
  children?: React.ReactNode;
  /** Optional content at the left edge of the shared bottom action row. */
  leadingActions?: React.ReactNode;
  /** Optional content at the right edge of the shared bottom action row. */
  trailingActions?: React.ReactNode;
  /** Pill controls rendered after the + button (mode, model, settings…). */
  pills?: React.ReactNode;
  /** Enables the standard add-context control. */
  onAddContent?: () => void;
  showContextInfo?: boolean;
  repoPath?: string;
  secondaryControlsPosition?: "left" | "right";
}

const ComposerSurface = forwardRef<HTMLDivElement, ComposerSurfaceProps>(
  function ComposerSurface(
    {
      children,
      leadingActions,
      trailingActions,
      pills,
      onAddContent,
      showContextInfo = false,
      repoPath,
      secondaryControlsPosition = "left",
      ...shellProps
    },
    ref
  ) {
    const hasActionBar = Boolean(
      leadingActions ||
      trailingActions ||
      pills ||
      onAddContent ||
      showContextInfo
    );

    return (
      <ComposerShell ref={ref} {...shellProps}>
        {children}
        {hasActionBar ? (
          <ComposerBar
            onAddContent={onAddContent}
            leftPrefix={leadingActions}
            pills={pills}
            repoPath={repoPath}
            submitButton={trailingActions}
            hideAddButton={!onAddContent}
            showContextInfo={showContextInfo}
            secondaryControlsPosition={secondaryControlsPosition}
          />
        ) : null}
      </ComposerShell>
    );
  }
);

ComposerSurface.displayName = "ComposerSurface";

export default ComposerSurface;
