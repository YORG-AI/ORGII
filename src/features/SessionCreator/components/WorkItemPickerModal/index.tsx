import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { createLogger } from "@src/hooks/logger";
import { SPOTLIGHT_FOOTER_ACTIVE_CHIP } from "@src/scaffold/GlobalSpotlight/components/SpotlightFooter";
import { SpotlightShell } from "@src/scaffold/GlobalSpotlight/shell";

import { useWorktreeSourceData } from "../useWorktreeSourceData";
import WorkItemPickerPanel from "./WorkItemPickerPanel";
import {
  type WorkItemPickerFilter,
  type WorkItemPickerOption,
  filterWorkItemPickerOptions,
  githubWorkItemsToPickerOptions,
  loadWorkspaceWorkItemOptions,
} from "./workItemPickerModel";

export type { WorkItemPickerOption } from "./workItemPickerModel";

const logger = createLogger("WorkItemPickerModal");
const DEFAULT_SOURCE_FILTERS: readonly WorkItemPickerFilter[] = [
  "all",
  "workitem",
  "github_issue",
  "github_pr",
];

export interface WorkItemPickerModalProps {
  open: boolean;
  onClose: () => void;
  /** The consumer owns applying the selection and closing the modal. */
  onSelect: (options: readonly WorkItemPickerOption[]) => void;
  /** Whether more than one result can be selected before confirming. */
  multiple?: boolean;
  repoId?: string;
  repoPath?: string;
  /** Limit the selectable sources when a caller represents one specific command. */
  sourceFilters?: readonly WorkItemPickerFilter[];
  title?: string;
}

const WorkItemPickerModalContent: React.FC<
  Omit<WorkItemPickerModalProps, "open">
> = ({
  onClose,
  onSelect,
  multiple = true,
  repoId,
  repoPath,
  sourceFilters = DEFAULT_SOURCE_FILTERS,
  title,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  const panelRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<WorkItemPickerFilter>(
    sourceFilters[0] ?? "workitem"
  );
  const [workItems, setWorkItems] = useState<WorkItemPickerOption[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [loadingWorkItems, setLoadingWorkItems] = useState(true);
  const [workItemError, setWorkItemError] = useState<string | null>(null);
  const workItemLoadGenerationRef = useRef(0);
  const githubEnabled = sourceFilters.some(
    (filter) => filter === "all" || filter.startsWith("github_")
  );
  const { github } = useWorktreeSourceData({
    open: githubEnabled,
    repoId,
    repoPath,
    loadBranches: false,
  });

  const loadWorkItems = useCallback(() => {
    const generation = ++workItemLoadGenerationRef.current;
    void loadWorkspaceWorkItemOptions()
      .then((options) => {
        if (workItemLoadGenerationRef.current === generation) {
          setWorkItems(options);
        }
      })
      .catch((error) => {
        if (workItemLoadGenerationRef.current !== generation) return;
        logger.error("Failed to load work items for selection", error);
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

  useEffect(() => {
    const previousFocus = document.activeElement;
    const panel = panelRef.current;
    return () => {
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected &&
        (document.activeElement === document.body ||
          panel?.contains(document.activeElement))
      ) {
        previousFocus.focus();
      }
    };
  }, []);

  useEffect(() => {
    panelRef.current
      ?.querySelector<HTMLInputElement>("[data-spotlight-input]")
      ?.focus();
  }, []);

  useEffect(() => {
    loadWorkItems();
    return () => {
      workItemLoadGenerationRef.current += 1;
    };
  }, [loadWorkItems]);

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
  const selectedOptions = useMemo(
    () => allOptions.filter((option) => selectedKeys.includes(option.key)),
    [allOptions, selectedKeys]
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

  const handleRefresh = useCallback(() => {
    setLoadingWorkItems(true);
    setWorkItemError(null);
    loadWorkItems();
    github.refresh();
  }, [github, loadWorkItems]);

  const handleToggleSelection = useCallback(
    (key: string, checked: boolean) => {
      setSelectedKeys((current) =>
        checked
          ? multiple
            ? current.includes(key)
              ? current
              : [...current, key]
            : [key]
          : current.filter((candidate) => candidate !== key)
      );
    },
    [multiple]
  );

  const handleConfirm = useCallback(() => {
    if (selectedOptions.length > 0) onSelect(selectedOptions);
  }, [onSelect, selectedOptions]);

  return (
    <SpotlightShell
      isOpen
      onClose={onClose}
      hasActiveAction
      activeActionChip={SPOTLIGHT_FOOTER_ACTIVE_CHIP.switchSection}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? t("projects:workItems.addWorkItem")}
      >
        <WorkItemPickerPanel
          onClose={onClose}
          onConfirm={handleConfirm}
          error={relevantError}
          filteredOptions={filteredOptions}
          loading={relevantSourceLoading}
          onFilterChange={setSourceFilter}
          onSearchChange={setSearchQuery}
          onRefresh={handleRefresh}
          onSelectionChange={handleToggleSelection}
          searchQuery={searchQuery}
          refreshing={
            loadingWorkItems || github.state === "loading" || github.refreshing
          }
          selectedKeys={selectedKeys}
          selectedCount={selectedOptions.length}
          sourceFilter={sourceFilter}
          sourceFilters={sourceFilters}
        />
      </div>
    </SpotlightShell>
  );
};

/** Mount data loading only while open; reset transient state when the repository changes. */
const WorkItemPickerModal: React.FC<WorkItemPickerModalProps> = ({
  open,
  ...props
}) =>
  open ? (
    <WorkItemPickerModalContent
      key={JSON.stringify([
        props.repoId ?? null,
        props.repoPath ?? null,
        props.sourceFilters ?? DEFAULT_SOURCE_FILTERS,
      ])}
      {...props}
    />
  ) : null;

export default WorkItemPickerModal;
