/**
 * ComposerBar — shared bottom toolbar for input areas
 *
 * Used by both ChatPanel InputArea and SessionCreator EditorArea
 * to ensure identical layout: [+ button | pills] ---- [context | submit]
 *
 * When an editor slot is present, the editor uses the full-width row above
 * the shared toolbar controls.
 */
import { Plus } from "lucide-react";
import React, { memo } from "react";

import { PILL_CONTROL_IDLE_SURFACE_CLASS } from "@src/components/CompoundPill/config";
import { INPUT_AREA_BUTTONS } from "@src/config/inputAreaTokens";
import ContextInfoButton from "@src/engines/ChatPanel/InputArea/components/ContextInfoButton";
import AddActionsDropdown from "@src/features/SessionCreator/components/AddActionsDropdown";

// ============================================
// Types
// ============================================

export interface ComposerBarProps {
  /** + button: open add-content selector (@-mentions, files) */
  onAddContent?: () => void;
  /** + button: open upload picker */
  onUpload?: () => void;
  /** + button: open Skills & Tools slash menu */
  onOpenSkillsTools?: () => void;
  /** Direction the + menu opens */
  dropdownDirection?: "up" | "down";
  /** Content before the + button (e.g. cite-code badge, reply indicator) */
  leftPrefix?: React.ReactNode;
  /** Optional tools rendered after the + button. */
  leftTools?: React.ReactNode;
  /** Pills rendered after the + button (mode, model, source, settings…) */
  pills?: React.ReactNode;
  /** Repo path forwarded to ContextInfoButton */
  repoPath?: string;
  /** Submit / launch button on the far right */
  submitButton?: React.ReactNode;
  /** Optional bottom padding for the toolbar row inside the composer shell. */
  bottomPaddingClassName?: string;
  /** Optional editor field above the toolbar. */
  editorSlot?: React.ReactNode;
  /** Render the editor and toolbar controls in one horizontal row. */
  inlineLayout?: boolean;
  /**
   * Keep the adaptive grid mounted while `inlineLayout` changes so editor
   * focus, selection, and document state survive compact-to-stacked moves.
   */
  adaptiveEditorLayout?: boolean;
  /** Hide the default add-content button while preserving the shared layout. */
  hideAddButton?: boolean;
  /** Places add/tools/pills beside submit, leaving only the prefix on the left. */
  secondaryControlsPosition?: "left" | "right";
  /**
   * When false, omits ContextInfoButton.
   * @default true
   */
  showContextInfo?: boolean;
}

// ============================================
// Component
// ============================================

const ComposerBar: React.FC<ComposerBarProps> = memo(
  ({
    onAddContent,
    onUpload,
    onOpenSkillsTools,
    dropdownDirection = "up",
    leftPrefix,
    leftTools,
    pills,
    repoPath,
    submitButton,
    bottomPaddingClassName = "",
    editorSlot,
    inlineLayout = false,
    adaptiveEditorLayout = false,
    hideAddButton = false,
    secondaryControlsPosition = "left",
    showContextInfo = true,
  }) => {
    const rowClass = "flex min-w-0 items-center gap-0.5";

    const addButton =
      hideAddButton || !onAddContent || !onUpload ? null : onOpenSkillsTools ? (
        <button
          type="button"
          onClick={onOpenSkillsTools}
          onMouseDown={(e) => e.preventDefault()}
          className={[
            `flex items-center justify-center rounded-full text-text-1 transition-colors duration-200 focus:outline-none ${PILL_CONTROL_IDLE_SURFACE_CLASS}`,
            INPUT_AREA_BUTTONS.iconButtonSizeClass,
          ].join(" ")}
          aria-label="Skills & Tools"
          data-composer-plus-menu-trigger="true"
          data-testid="composer-skills-tools-button"
        >
          <Plus
            size={INPUT_AREA_BUTTONS.iconSize}
            strokeWidth={1.75}
            className="text-text-1"
          />
        </button>
      ) : (
        <AddActionsDropdown
          onAddContent={onAddContent}
          onUpload={onUpload}
          dropdownDirection={dropdownDirection}
        />
      );

    const toolbarRow = (
      <div
        className={`flex h-9 min-h-9 w-full items-center justify-between px-1 text-text-2 ${bottomPaddingClassName}`.trim()}
        style={{ transform: "translateZ(0)" }}
      >
        <div className={rowClass}>
          {leftPrefix}
          {secondaryControlsPosition === "left" ? (
            <>
              {addButton}
              {leftTools}
              {pills}
            </>
          ) : null}
        </div>
        <div className={rowClass}>
          {secondaryControlsPosition === "right" ? (
            <>
              {addButton}
              {leftTools}
              {pills}
            </>
          ) : null}
          {showContextInfo && <ContextInfoButton repoPath={repoPath} />}
          {submitButton}
        </div>
      </div>
    );

    if (editorSlot != null && (adaptiveEditorLayout || inlineLayout)) {
      const gridStyle: React.CSSProperties = inlineLayout
        ? {
            display: "grid",
            gridTemplateColumns: "auto 1fr auto auto",
            gridTemplateAreas: '"left editor pills right"',
            alignItems: "center",
            columnGap: 6,
          }
        : {
            display: "grid",
            gridTemplateColumns: "auto auto 1fr",
            gridTemplateAreas: '"editor editor editor" "left pills right"',
            rowGap: 4,
            columnGap: 6,
          };

      return (
        <div
          className={`w-full text-text-2 ${bottomPaddingClassName}`.trim()}
          style={gridStyle}
        >
          <div className={`${rowClass} shrink-0`} style={{ gridArea: "left" }}>
            {leftPrefix}
            {addButton}
            {leftTools}
          </div>
          <div
            data-editor-slot="true"
            className="relative flex min-h-0 min-w-0 items-stretch self-stretch"
            style={{ gridArea: "editor" }}
          >
            {editorSlot}
          </div>
          <div
            className="flex min-w-0 shrink-0 items-center gap-1"
            style={{ gridArea: "pills" }}
          >
            {pills}
          </div>
          <div
            className={`${rowClass} min-w-0 shrink justify-end`}
            style={{ gridArea: "right" }}
          >
            {showContextInfo && (
              <ContextInfoButton repoPath={repoPath} variant="corner" compact />
            )}
            {submitButton}
          </div>
        </div>
      );
    }

    if (editorSlot != null) {
      return (
        <div className="flex w-full flex-col gap-2">
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

    return toolbarRow;
  }
);

ComposerBar.displayName = "ComposerBar";

export default ComposerBar;
