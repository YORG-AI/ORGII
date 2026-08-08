import { Link2, ListTodo, Search, X } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { type WorkItemData, projectApi } from "@src/api/http/project";
import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import { pillControlStateClass } from "@src/components/CompoundPill/config";
import DropdownSearch from "@src/components/Dropdown/DropdownSearch";
import { DropdownPanel } from "@src/components/Dropdown/exports";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import Message from "@src/components/Message";
import type { SessionLaunchWorkItemContext } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { createLogger } from "@src/hooks/logger";

const logger = createLogger("WorkItemAttachmentControl");
const WORK_ITEM_SEARCH_RESULT_LIMIT = 8;

function getWorkItemOptionKey(item: ExistingWorkItemOption): string {
  return `${item.projectSlug ?? "standalone"}:${item.shortId}`;
}

interface ExistingWorkItemOption {
  shortId: string;
  orgId?: string;
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
  title: string;
}

type ExistingWorkItemSource =
  | {
      item: WorkItemData;
      orgId: string;
      projectId: string;
      projectName: string;
      projectSlug: string;
    }
  | {
      item: WorkItemData;
      projectSlug: undefined;
    };

function toExistingWorkItemOption(
  source: ExistingWorkItemSource
): ExistingWorkItemOption {
  const projectMeta =
    "orgId" in source
      ? {
          orgId: source.orgId,
          projectId: source.projectId,
          projectName: source.projectName,
        }
      : {};

  return {
    shortId: source.item.frontmatter.short_id || source.item.frontmatter.id,
    ...projectMeta,
    projectSlug: source.projectSlug,
    title: source.item.frontmatter.title,
  };
}

export interface WorkItemAttachmentControlProps {
  currentWorkItemContext?: SessionLaunchWorkItemContext | null;
  /** Direct navigation to the owning Work Item creator when available. */
  onCreateWorkItem?: () => void;
  onWorkItemContextChange?: (
    context: SessionLaunchWorkItemContext | null
  ) => void;
  panelHostRef?: React.RefObject<HTMLDivElement | null>;
}

const WorkItemAttachmentControl: React.FC<WorkItemAttachmentControlProps> = ({
  currentWorkItemContext,
  onCreateWorkItem,
  onWorkItemContextChange,
  panelHostRef,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  const [isLinkPanelOpen, setIsLinkPanelOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [workItems, setWorkItems] = useState<ExistingWorkItemOption[]>([]);
  const [selectedWorkItemKeys, setSelectedWorkItemKeys] = useState<string[]>(
    []
  );
  const [loadingSearch, setLoadingSearch] = useState(false);
  const {
    isOpen,
    isPositioned,
    panelPosition,
    triggerRef,
    panelRef,
    toggle,
    close,
  } = useDropdownEngine<HTMLButtonElement>({ placement: "top" });

  const loadExistingWorkItems = useCallback(async () => {
    setLoadingSearch(true);
    try {
      const [projects, standaloneItems] = await Promise.all([
        projectApi.readProjects(),
        projectApi.readStandaloneWorkItems(),
      ]);
      const projectItemGroups = await Promise.all(
        projects.map(async (project) => {
          const items = await projectApi.readWorkItems(project.slug);
          return items.map((item) => ({
            item,
            orgId: project.meta.org_id,
            projectId: project.meta.id,
            projectName: project.meta.name,
            projectSlug: project.slug,
          }));
        })
      );
      const allItems = [
        ...standaloneItems.map((item) => ({ item, projectSlug: undefined })),
        ...projectItemGroups.flat(),
      ];
      setWorkItems(allItems.map(toExistingWorkItemOption));
    } catch (err) {
      logger.error("Failed to load work items for linking", err);
      Message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSearch(false);
    }
  }, []);

  const handleLinkWorkItem = useCallback(() => {
    setIsLinkPanelOpen(true);
    close();
    void loadExistingWorkItems();
  }, [close, loadExistingWorkItems]);

  const handleCloseLinkPanel = useCallback(() => {
    setIsLinkPanelOpen(false);
    setSearchQuery("");
    setSelectedWorkItemKeys([]);
  }, []);

  const filteredWorkItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = query
      ? workItems.filter(
          (item) =>
            item.title.toLowerCase().includes(query) ||
            item.shortId.toLowerCase().includes(query)
        )
      : workItems;
    return filtered.slice(0, WORK_ITEM_SEARCH_RESULT_LIMIT);
  }, [searchQuery, workItems]);

  const handleToggleWorkItemSelection = useCallback(
    (item: ExistingWorkItemOption, checked: boolean) => {
      const itemKey = getWorkItemOptionKey(item);
      setSelectedWorkItemKeys((currentKeys) =>
        checked
          ? [...new Set([...currentKeys, itemKey])]
          : currentKeys.filter((key) => key !== itemKey)
      );
    },
    []
  );

  const handleAddLinkedWorkItems = useCallback(() => {
    const selectedItems = workItems.filter((item) =>
      selectedWorkItemKeys.includes(getWorkItemOptionKey(item))
    );
    const primaryItem = selectedItems[0];
    if (!primaryItem) return;

    onWorkItemContextChange?.({
      orgId: primaryItem.orgId,
      projectId: primaryItem.projectId,
      projectName: primaryItem.projectName,
      workItemId: primaryItem.shortId,
      projectSlug: primaryItem.projectSlug,
      agentRole: "custom",
      metadata: {
        linkedWorkItems: selectedItems.map((item) => ({
          orgId: item.orgId,
          projectId: item.projectId,
          projectName: item.projectName,
          workItemId: item.shortId,
          projectSlug: item.projectSlug,
          title: item.title,
        })),
      },
    });
    Message.success(primaryItem.title);
    setIsLinkPanelOpen(false);
    setSearchQuery("");
    setSelectedWorkItemKeys([]);
  }, [onWorkItemContextChange, selectedWorkItemKeys, workItems]);

  const handleRemoveWorkItem = useCallback(() => {
    onWorkItemContextChange?.(null);
    close();
  }, [close, onWorkItemContextChange]);

  const triggerActive =
    isOpen || isLinkPanelOpen || Boolean(currentWorkItemContext);

  const linkPanelContent = isLinkPanelOpen ? (
    <div
      className="w-full rounded-xl border border-solid border-border-2"
      data-testid="work-item-attachment-panel"
    >
      <div
        className="w-full max-w-[520px]"
        data-testid="work-item-link-inline-panel"
      >
        <DropdownSearch
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t("projects:workItems.searchPlaceholder")}
          autoFocus
        />
        <div className="max-h-[180px] overflow-y-auto p-1 scrollbar-hide">
          {loadingSearch ? (
            <div className="flex h-16 items-center justify-center text-[12px] text-text-3">
              {t("common:status.loading")}
            </div>
          ) : filteredWorkItems.length > 0 ? (
            filteredWorkItems.map((item) => {
              const itemKey = getWorkItemOptionKey(item);
              const checked = selectedWorkItemKeys.includes(itemKey);
              return (
                <div
                  key={itemKey}
                  className={`${DROPDOWN_CLASSES.menuActionItem} w-full justify-start`}
                >
                  <Checkbox
                    checked={checked}
                    onChange={(nextChecked) =>
                      handleToggleWorkItemSelection(item, nextChecked)
                    }
                    className="min-w-0 flex-1"
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <Search
                        size={DROPDOWN_ITEM.iconSize}
                        strokeWidth={1.75}
                        className="shrink-0 text-text-2"
                      />
                      <span className="min-w-0 flex-1 truncate text-left">
                        {item.title}
                      </span>
                      <span className="shrink-0 text-[11px] text-text-3">
                        {item.shortId}
                      </span>
                    </span>
                  </Checkbox>
                </div>
              );
            })
          ) : (
            <div className="flex h-16 items-center justify-center text-[12px] text-text-3">
              {t("projects:workItems.noResults")}
            </div>
          )}
        </div>
        <div className="flex justify-start gap-2 p-2">
          <Button
            variant="secondary"
            size="small"
            onClick={handleAddLinkedWorkItems}
            disabled={selectedWorkItemKeys.length === 0}
          >
            {t("common:actions.add")}
          </Button>
          <Button
            variant="tertiary"
            size="small"
            onClick={handleCloseLinkPanel}
          >
            {t("common:actions.cancel")}
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="relative shrink-0">
      <Button
        ref={triggerRef}
        variant="secondary"
        appearance="outline"
        size="small"
        shape="round"
        icon={<ListTodo size={14} strokeWidth={1.75} />}
        aria-expanded={onCreateWorkItem ? undefined : isOpen}
        aria-haspopup={onCreateWorkItem ? undefined : "menu"}
        onClick={onCreateWorkItem ?? toggle}
        className={`shrink-0 ${pillControlStateClass(triggerActive)}`}
        data-testid="session-creator-work-item-toggle"
      >
        {t("projects:workItems.addWorkItem")}
      </Button>

      {!onCreateWorkItem &&
        isOpen &&
        isPositioned &&
        createPortal(
          <DropdownPanel
            ref={panelRef}
            className={`fixed ${DROPDOWN_WIDTHS.menuClass}`}
            animated={false}
            maxHeight="none"
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
                  <X
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
                <Link2
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
      {panelHostRef?.current && linkPanelContent
        ? createPortal(linkPanelContent, panelHostRef.current)
        : linkPanelContent}
    </div>
  );
};

export default WorkItemAttachmentControl;
