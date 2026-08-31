import React, { memo } from "react";

export interface ComposerBarLayoutProps {
  editorSlot?: React.ReactNode;
  leftContent?: React.ReactNode;
  rightContent?: React.ReactNode;
  bottomPaddingClassName?: string;
}

/**
 * Browser-safe composer layout shared by Desktop ChatSession and Mobile
 * Remote. Product-specific controls are supplied through slots so the mobile
 * bundle does not need to import Desktop menus, context, or Tauri actions.
 */
const ComposerBarLayout: React.FC<ComposerBarLayoutProps> = memo(
  ({ editorSlot, leftContent, rightContent, bottomPaddingClassName = "" }) => {
    const rowClass = "flex min-w-0 items-center gap-0.5";
    const toolbarRow = (
      <div
        className={`flex h-9 min-h-9 w-full items-center justify-between px-1 text-text-2 ${bottomPaddingClassName}`.trim()}
        style={{ transform: "translateZ(0)" }}
      >
        <div className={`${rowClass} flex-1`}>{leftContent}</div>
        <div className={rowClass}>{rightContent}</div>
      </div>
    );

    if (editorSlot == null) return toolbarRow;

    return (
      <div
        className="flex w-full flex-col gap-2"
        data-composer-bar-layout="true"
      >
        <div
          data-editor-slot="true"
          className="relative flex min-h-0 min-w-0 items-stretch self-stretch"
        >
          {editorSlot}
        </div>
        {toolbarRow}
      </div>
    );
  }
);

ComposerBarLayout.displayName = "ComposerBarLayout";

export default ComposerBarLayout;
