import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { LaunchpadActionCard } from "@src/features/SessionCreator/components/LaunchpadActionGrid";
import { useWorktreeSourceData } from "@src/features/SessionCreator/components/useWorktreeSourceData";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { createLogger } from "@src/hooks/logger";
import {
  Cancel01Icon,
  HugeiconsIcon,
  Link02Icon,
  ListTodoIcon,
} from "@src/icons";
import { insertPillFromTabPayload } from "@src/shared/dnd/dropTargetUtils";

import WorkItemPickerPanel from "./WorkItemPickerPanel";
import {
  type WorkItemPickerFilter,
  type WorkItemPickerOption,
  filterWorkItemPickerOptions,
  githubWorkItemsToPickerOptions,
  loadWorkspaceWorkItemOptions,
} from "./workItemPickerModel";

const logger = createLogger("WorkItemAttachmentControl");

export interface WorkItemAttachmentControlProps {
  composerInputRef?: React.RefObject<ComposerInputRef | null>;
  currentWorkItemContext?: SessionLaunchWorkItemContext | null;
  /** Direct navigation to the owning Work Item creator when available. */
  onCreateWorkItem?: () => void;
  onWorkItemContextChange?: (
    context: SessionLaunchWorkItemContext | null
  ) => void;
  onPickerOpenChange?: (open: boolean) => void;
  /** Stable composer-chrome host used by the Launchpad card presentation. */
  pickerPortalTarget?: HTMLElement | null;
  repoId?: string;
  repoPath?: string;
  /** Launchpad opens the picker directly and uses the solve-oriented label. */
  mode?: "add" | "solve";
  presentation?: "button" | "card";
}

const WorkItemAttachmentControl: React.FC<WorkItemAttachmentControlProps> = ({
  composerInputRef,
  currentWorkItemContext,
  onCreateWorkItem,
  onPickerOpenChange,
  onWorkItemContextChange,
  pickerPortalTarget,
  repoId,
  repoPath,
  mode = "add",
  presentation = "button",
}) => {
  const { t } = useTranslation(["sessions", "projects", "common"]);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<WorkItemPickerFilter>("all");
  const [workItems, setWorkItems] = useState<WorkItemPickerOption[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [loadingWorkItems, setLoadingWorkItems] = useState(false);
  const [workItemError, setWorkItemError] = useState<string | null>(null);
  const workItemLoadGenerationRef = useRef(0);
  const {
    isOpen,
    isPositioned,
    panelPosition,
    triggerRef,
    panelRef,
    toggle,
    close,
  } = useDropdownEngine<HTMLButtonElement>({ placement: "top" });
  const { github } = useWorktreeSourceData({
    open: isPickerOpen && (presentation === "card" || isOpen),
    repoId,
    repoPath,
    loadBranches: false,
  });

  const loadWorkItems = useCallback(() => {
    const generation = workItemLoadGenerationRef.current + 1;
    workItemLoadGenerationRef.current = generation;
    setLoadingWorkItems(true);
    setWorkItemError(null);
    void loadWorkspaceWorkItemOptions()
      .then((options) => {
        if (workItemLoadGenerationRef.current === generation) {
          setWorkItems(options);
        }
      })
      .catch((error) => {
        if (workItemLoadGenerationRef.current !== generation) return;
        logger.error("Failed to load work items for solving", error);
        setWorkItemError(
          error instanceof Error ? error.message : String(error)
        );
      })
      .finally(() => {
        if (workItemLoadGenerationRef.current === generation) {
          setLoadingWorkItems(false);
        }
      });
  }, []);

  useEffect(
    () => () => {
      workItemLoadGenerationRef.current += 1;
    },
    []
  );

  const githubOptions = useMemo(
    () => githubWorkItemsToPickerOptions(github),
    [github]
  );
  const allOptions = useMemo(
    () => [...workItems, ...githubOptions],
    [githubOptions, workItems]
  );
  const filteredOptions = useMemo(
    () => filterWorkItemPickerOptions(allOptions, sourceFilter, searchQuery),
    [allOptions, searchQuery, sourceFilter]
  );

  const localSourceRelevant =
    sourceFilter === "all" || sourceFilter === "workitem";
  const githubSourceRelevant =
    sourceFilter === "all" || sourceFilter.startsWith("github_");
  const relevantSourceLoading =
    (localSourceRelevant && loadingWorkItems) ||
    (githubSourceRelevant && github.state === "loading");
  const relevantError = localSourceRelevant
    ? (workItemError ?? (githubSourceRelevant ? github.error : null))
    : github.error;

  const resetPicker = useCallback(() => {
    workItemLoadGenerationRef.current += 1;
    setIsPickerOpen(false);
    setSearchQuery("");
    setSourceFilter("all");
    setSelectedKeys([]);
    onPickerOpenChange?.(false);
  }, [onPickerOpenChange]);

  const handleClosePicker = useCallback(() => {
    resetPicker();
    close();
  }, [close, resetPicker]);

  const handleOpenPicker = useCallback(() => {
    if (isOpen && isPickerOpen) {
      handleClosePicker();
      return;
    }
    setIsPickerOpen(true);
    onPickerOpenChange?.(true);
    loadWorkItems();
    if (presentation !== "card" && !isOpen) toggle();
  }, [
    handleClosePicker,
    isOpen,
    isPickerOpen,
    loadWorkItems,
    onPickerOpenChange,
    presentation,
    toggle,
  ]);

  const handleLinkWorkItem = useCallback(() => {
    setIsPickerOpen(true);
    loadWorkItems();
  }, [loadWorkItems]);

  const handleRefresh = useCallback(() => {
    loadWorkItems();
    github.refresh();
  }, [github, loadWorkItems]);

  const handleToggleSelection = useCallback((key: string, checked: boolean) => {
    setSelectedKeys((current) =>
      checked
        ? current.includes(key)
          ? current
          : [...current, key]
        : current.filter((candidate) => candidate !== key)
    );
  }, []);

  const handleAddSelected = useCallback(() => {
    const editor = composerInputRef?.current;
    if (!editor) return;
    const selected = allOptions.filter((option) =>
      selectedKeys.includes(option.key)
    );
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
    handleClosePicker();
    editor.focus();
  }, [
    allOptions,
    composerInputRef,
    handleClosePicker,
    onWorkItemContextChange,
    selectedKeys,
  ]);

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
    presentation !== "card" && (!onCreateWorkItem || solveMode) && isOpen;
  const pickerPanel = (
    <WorkItemPickerPanel
      error={relevantError}
      expanded={presentation === "card"}
      filteredOptions={filteredOptions}
      loading={relevantSourceLoading}
      onAdd={handleAddSelected}
      onBack={presentation === "card" ? handleClosePicker : undefined}
      onCancel={handleClosePicker}
      onFilterChange={setSourceFilter}
      onSearchChange={setSearchQuery}
      onRefresh={handleRefresh}
      onSelectionChange={handleToggleSelection}
      searchQuery={searchQuery}
      refreshing={
        loadingWorkItems || github.state === "loading" || github.refreshing
      }
      selectedKeys={selectedKeys}
      showCancel={presentation !== "card"}
      sourceFilter={sourceFilter}
    />
  );

  if (presentation === "card" && isPickerOpen) {
    return pickerPortalTarget
      ? createPortal(pickerPanel, pickerPortalTarget)
      : null;
  }
  const trigger =
    presentation === "card" ? (
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
        presentation="card"
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
        aria-expanded={onCreateWorkItem && !solveMode ? undefined : isOpen}
        aria-haspopup={onCreateWorkItem && !solveMode ? undefined : "dialog"}
        onClick={solveMode ? handleOpenPicker : (onCreateWorkItem ?? toggle)}
        className={`shrink-0 ${pillControlStateClass(
          isOpen || Boolean(currentWorkItemContext)
        )}`}
        data-testid="session-creator-work-item-toggle"
      >
        {triggerLabel}
      </Button>
    );

  return (
    <div className={presentation === "card" ? "contents" : "relative shrink-0"}>
      {trigger}

      {showDropdown &&
        isPositioned &&
        createPortal(
          <DropdownPanel
            ref={panelRef}
            className="fixed"
            animated={false}
            width="min(520px, calc(100vw - 32px))"
            maxHeight={panelPosition.maxHeight}
            style={{
              ...(panelPosition.top !== undefined
                ? { top: panelPosition.top }
                : { bottom: panelPosition.bottom }),
              left: panelPosition.left,
            }}
            role={isPickerOpen ? "dialog" : "menu"}
            aria-label={isPickerOpen ? triggerLabel : undefined}
          >
            {isPickerOpen ? (
              pickerPanel
            ) : (
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
                  onClick={handleLinkWorkItem}
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
            )}
          </DropdownPanel>,
          document.body
        )}
    </div>
  );
};

export default WorkItemAttachmentControl;
