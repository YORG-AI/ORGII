import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import type { ComposerInputRef } from "@src/components/ComposerInput";
import { pillControlStateClass } from "@src/components/CompoundPill/config";
import { DropdownPanel } from "@src/components/Dropdown/exports";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import type { SessionLaunchWorkItemContext } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import {
  LaunchpadActionCard,
  type LaunchpadActionPresentation,
} from "@src/features/SessionCreator/components/LaunchpadActionGrid";
import WorkItemPickerModal, {
  type WorkItemPickerOption,
} from "@src/features/SessionCreator/components/WorkItemPickerModal";
import { useDropdownEngine } from "@src/hooks/dropdown";
import {
  Cancel01Icon,
  HugeiconsIcon,
  Link02Icon,
  ListTodoIcon,
} from "@src/icons";
import { insertPillFromTabPayload } from "@src/shared/dnd/dropTargetUtils";

export interface WorkItemAttachmentControlProps {
  composerInputRef?: React.RefObject<ComposerInputRef | null>;
  currentWorkItemContext?: SessionLaunchWorkItemContext | null;
  /** Direct navigation to the owning Work Item creator when available. */
  onCreateWorkItem?: () => void;
  onWorkItemContextChange?: (
    context: SessionLaunchWorkItemContext | null
  ) => void;
  repoId?: string;
  repoPath?: string;
  /** Launchpad opens the picker directly and uses the solve-oriented label. */
  mode?: "add" | "solve";
  presentation?: "button" | LaunchpadActionPresentation;
}

const WorkItemAttachmentControl: React.FC<WorkItemAttachmentControlProps> = ({
  composerInputRef,
  currentWorkItemContext,
  onCreateWorkItem,
  onWorkItemContextChange,
  repoId,
  repoPath,
  mode = "add",
  presentation = "button",
}) => {
  const { t } = useTranslation(["sessions", "projects", "common"]);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const focusComposerAfterCloseRef = useRef(false);
  useEffect(() => {
    if (!isPickerOpen && focusComposerAfterCloseRef.current) {
      focusComposerAfterCloseRef.current = false;
      composerInputRef?.current?.focus();
    }
  }, [composerInputRef, isPickerOpen]);
  const {
    isOpen,
    isPositioned,
    panelPosition,
    triggerRef,
    panelRef,
    toggle,
    close,
  } = useDropdownEngine<HTMLButtonElement>({ placement: "top" });
  const handleClosePicker = useCallback(() => setIsPickerOpen(false), []);
  const handleOpenPicker = useCallback(() => {
    close();
    triggerRef.current?.focus();
    setIsPickerOpen(true);
  }, [close, triggerRef]);

  const handleAddSelected = useCallback(
    (selected: readonly WorkItemPickerOption[]) => {
      const editor = composerInputRef?.current;
      if (!editor) return;
      const existingPaths = editor.getFilePills().map((pill) => pill.filePath);

      for (const option of selected) {
        const alreadyInserted =
          option.kind === "workitem"
            ? existingPaths.some((path) =>
                path.startsWith(`workitem://${option.pillPath}/`)
              )
            : existingPaths.includes(option.pillPath);
        if (alreadyInserted) continue;

        insertPillFromTabPayload(composerInputRef, {
          path: option.pillPath,
          name: option.pillName,
          iconType:
            option.kind === "workitem"
              ? "workitem"
              : option.kind === "github_pr"
                ? "pr"
                : "issue",
          contextText: option.contextText,
          notify: false,
        });
      }

      const selectedWorkItems = selected.filter(
        (option) => option.kind === "workitem" && option.workItemContext
      );
      const primary = selectedWorkItems[0];
      if (primary?.workItemContext) {
        onWorkItemContextChange?.({
          ...primary.workItemContext,
          metadata: {
            linkedWorkItems: selectedWorkItems.map((option) => ({
              ...option.workItemContext,
              title: option.title,
            })),
          },
        });
      }
      focusComposerAfterCloseRef.current = true;
      handleClosePicker();
    },
    [composerInputRef, handleClosePicker, onWorkItemContextChange]
  );

  const handleRemoveWorkItem = useCallback(() => {
    onWorkItemContextChange?.(null);
    close();
  }, [close, onWorkItemContextChange]);

  const solveMode = mode === "solve";
  const triggerLabel = solveMode
    ? t("sessions:creator.solveWorkItem", {
        defaultValue: "Solve Work Item",
      })
    : t("projects:workItems.addWorkItem");
  const showDropdown =
    presentation === "button" &&
    !onCreateWorkItem &&
    !solveMode &&
    isOpen &&
    !isPickerOpen;
  const trigger =
    presentation !== "button" ? (
      <LaunchpadActionCard
        ref={triggerRef}
        action={{
          id: "solve-work-item",
          title: triggerLabel,
          icon: (
            <HugeiconsIcon
              icon={ListTodoIcon}
              data-icon="list-todo"
              size={16}
              strokeWidth={1.8}
            />
          ),
          onClick: handleOpenPicker,
          tone: "neutral",
        }}
        presentation={presentation}
        aria-haspopup="dialog"
        aria-expanded={isPickerOpen}
      />
    ) : (
      <Button
        ref={triggerRef}
        variant="secondary"
        appearance="outline"
        size="small"
        shape="round"
        icon={
          <HugeiconsIcon
            icon={ListTodoIcon}
            data-icon="list-todo"
            size={14}
            strokeWidth={1.75}
          />
        }
        aria-expanded={
          onCreateWorkItem && !solveMode
            ? undefined
            : solveMode
              ? isPickerOpen
              : isOpen
        }
        aria-haspopup={
          onCreateWorkItem && !solveMode
            ? undefined
            : solveMode
              ? "dialog"
              : "menu"
        }
        onClick={solveMode ? handleOpenPicker : (onCreateWorkItem ?? toggle)}
        className={`shrink-0 ${pillControlStateClass(
          isOpen || isPickerOpen || Boolean(currentWorkItemContext)
        )}`}
        data-testid="session-creator-work-item-toggle"
      >
        {triggerLabel}
      </Button>
    );

  return (
    <div
      className={presentation !== "button" ? "contents" : "relative shrink-0"}
    >
      {trigger}

      {showDropdown &&
        isPositioned &&
        createPortal(
          <DropdownPanel
            ref={panelRef}
            className="fixed"
            animated={false}
            width={240}
            maxHeight={panelPosition.maxHeight}
            style={{
              ...(panelPosition.top !== undefined
                ? { top: panelPosition.top }
                : { bottom: panelPosition.bottom }),
              left: panelPosition.left,
            }}
            role="menu"
          >
            <div className={DROPDOWN_CLASSES.itemsColumnPadded}>
              {currentWorkItemContext ? (
                <button
                  type="button"
                  className={DROPDOWN_CLASSES.menuActionItem}
                  role="menuitem"
                  onClick={handleRemoveWorkItem}
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    data-icon="x"
                    size={DROPDOWN_ITEM.iconSize}
                    strokeWidth={1.75}
                    className="text-text-2"
                  />
                  <span>{t("common:actions.remove")}</span>
                  <span className="ml-auto text-[11px] text-text-3">
                    {currentWorkItemContext.workItemId}
                  </span>
                </button>
              ) : null}
              <button
                type="button"
                className={DROPDOWN_CLASSES.menuActionItem}
                role="menuitem"
                onClick={handleOpenPicker}
              >
                <HugeiconsIcon
                  icon={Link02Icon}
                  data-icon="link-2"
                  size={DROPDOWN_ITEM.iconSize}
                  strokeWidth={1.75}
                  className="text-text-2"
                />
                <span>{t("common:actions.link")}</span>
              </button>
            </div>
          </DropdownPanel>,
          document.body
        )}
      <WorkItemPickerModal
        open={isPickerOpen}
        onClose={handleClosePicker}
        onSelect={handleAddSelected}
        repoId={repoId}
        repoPath={repoPath}
        title={triggerLabel}
      />
    </div>
  );
};

export default WorkItemAttachmentControl;
