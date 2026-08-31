import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { createLogger } from "@src/hooks/logger";
import Modal from "@src/scaffold/ModalSystem";

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

export interface WorkItemPickerModalProps {
  open: boolean;
  onClose: () => void;
  /** The consumer owns applying the selection and closing the modal. */
  onSelect: (options: readonly WorkItemPickerOption[]) => void;
  repoId?: string;
  repoPath?: string;
  title?: string;
}

const WorkItemPickerModalContent: React.FC<
  Omit<WorkItemPickerModalProps, "open">
> = ({ onClose, onSelect, repoId, repoPath, title }) => {
  const { t } = useTranslation(["projects", "common"]);
  const searchInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<WorkItemPickerFilter>("all");
  const [workItems, setWorkItems] = useState<WorkItemPickerOption[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [loadingWorkItems, setLoadingWorkItems] = useState(true);
  const [workItemError, setWorkItemError] = useState<string | null>(null);
  const workItemLoadGenerationRef = useRef(0);
  const { github } = useWorktreeSourceData({
    open: true,
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

  const handleToggleSelection = useCallback((key: string, checked: boolean) => {
    setSelectedKeys((current) =>
      checked
        ? current.includes(key)
          ? current
          : [...current, key]
        : current.filter((candidate) => candidate !== key)
    );
  }, []);

  return (
    <Modal
      visible
      size="large"
      width={800}
      title={title ?? t("projects:workItems.addWorkItem")}
      bodyClassName="flex min-h-0 flex-col overflow-hidden p-0"
      initialFocusRef={searchInputRef}
      onClose={onClose}
      onCancel={onClose}
      onOk={() => {
        if (selectedOptions.length > 0) onSelect(selectedOptions);
      }}
      okText={t("common:actions.add")}
      cancelText={t("common:actions.cancel")}
      okButtonProps={{ disabled: selectedOptions.length === 0 }}
    >
      <WorkItemPickerPanel
        error={relevantError}
        filteredOptions={filteredOptions}
        loading={relevantSourceLoading}
        onFilterChange={setSourceFilter}
        onSearchChange={setSearchQuery}
        onRefresh={handleRefresh}
        onSelectionChange={handleToggleSelection}
        searchInputRef={searchInputRef}
        searchQuery={searchQuery}
        refreshing={
          loadingWorkItems || github.state === "loading" || github.refreshing
        }
        selectedKeys={selectedKeys}
        sourceFilter={sourceFilter}
      />
    </Modal>
  );
};

/** Mount data loading only while open; reset transient state when the repository changes. */
const WorkItemPickerModal: React.FC<WorkItemPickerModalProps> = ({
  open,
  ...props
}) =>
  open ? (
    <WorkItemPickerModalContent
      key={JSON.stringify([props.repoId ?? null, props.repoPath ?? null])}
      {...props}
    />
  ) : null;

export default WorkItemPickerModal;
