import { emit } from "@tauri-apps/api/event";
import {
  CheckCircle2,
  ChevronRight,
  CircleDot,
  CircleSlash2,
  ListTree,
  Plus,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { type WorkItemData, projectApi } from "@src/api/http/project";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Select, { type SelectOption } from "@src/components/Select";
import {
  allocateCloudAwareStandaloneWorkItemId,
  allocateCloudAwareWorkItemId,
} from "@src/features/Org2Cloud/cloudShortId";
import { createLogger } from "@src/hooks/logger";
import { useProjectDataChanged } from "@src/hooks/project";

import { WorkItemThreadSection } from "./WorkItemThread";

const logger = createLogger("WorkItemSubItems");

interface WorkItemFamily {
  children: WorkItemData[];
  parent: WorkItemData | null;
}

/**
 * Children and parent of one work item, resolved from the item's own
 * scope (project slug or standalone org) via `frontmatter.parent`
 * linkage, refreshed on every `orgii-data-changed` signal so CLI writes
 * from agent shells appear live.
 */
export function useWorkItemFamily(
  shortId: string,
  projectSlug?: string | null,
  orgId?: string | null
): WorkItemFamily {
  const [family, setFamily] = useState<WorkItemFamily>({
    children: [],
    parent: null,
  });

  const refresh = useCallback(() => {
    const read = projectSlug
      ? projectApi.readWorkItems(projectSlug)
      : projectApi.readStandaloneWorkItems(orgId ? { orgId } : undefined);
    read
      .then((items) => {
        const children = items.filter(
          (item) =>
            item.frontmatter.parent === shortId && !item.frontmatter.deleted_at
        );
        const ownParentId = items.find(
          (item) => item.frontmatter.short_id === shortId
        )?.frontmatter.parent;
        const parent = ownParentId
          ? (items.find((item) => item.frontmatter.short_id === ownParentId) ??
            null)
          : null;
        setFamily({ children, parent });
      })
      .catch(() => {
        setFamily({ children: [], parent: null });
      });
  }, [shortId, projectSlug, orgId]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useProjectDataChanged(refresh);

  return family;
}

const COMPLETED_SUB_ITEM_STATUSES = new Set(["completed", "done", "closed"]);
const CANCELLED_SUB_ITEM_STATUSES = new Set(["cancelled", "duplicate"]);

export type SubItemVisualState = "open" | "completed" | "cancelled";

/** Collapse domain statuses into the three states shown in the hierarchy. */
export function getSubItemVisualState(status: string): SubItemVisualState {
  if (COMPLETED_SUB_ITEM_STATUSES.has(status)) return "completed";
  if (CANCELLED_SUB_ITEM_STATUSES.has(status)) return "cancelled";
  return "open";
}

export function getSubItemProgress(children: WorkItemData[]): {
  completed: number;
  total: number;
  percent: number;
} {
  const completed = children.filter(
    (child) => getSubItemVisualState(child.frontmatter.status) !== "open"
  ).length;
  const total = children.length;
  return {
    completed,
    total,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}

interface SubItemStageGroup {
  key: string;
  /** Group header label; null when the set has no staged items at all. */
  label: string | null;
  stage?: number;
  items: WorkItemData[];
}

/**
 * Stage grouping: headers appear only when at least one
 * child carries a stage; staged groups sort ascending with unstaged
 * children trailing under "NO STAGE".
 */
export function groupSubItemsByStage(
  children: WorkItemData[]
): SubItemStageGroup[] {
  const anyStaged = children.some(
    (child) => child.frontmatter.stage !== undefined
  );
  if (!anyStaged) {
    return [{ key: "all", label: null, items: children }];
  }
  const byStage = new Map<number, WorkItemData[]>();
  const unstaged: WorkItemData[] = [];
  for (const child of children) {
    const stage = child.frontmatter.stage;
    if (stage === undefined) {
      unstaged.push(child);
      continue;
    }
    const bucket = byStage.get(stage) ?? [];
    bucket.push(child);
    byStage.set(stage, bucket);
  }
  const groups: SubItemStageGroup[] = [...byStage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([stage, items]) => ({
      key: `stage-${stage}`,
      label: `Stage ${stage}`,
      stage,
      items,
    }));
  if (unstaged.length > 0) {
    groups.push({ key: "no-stage", label: "No stage", items: unstaged });
  }
  return groups;
}

/**
 * Keep quick-add compact while making every existing stage and the next
 * sequential stage directly selectable. Filling gaps keeps recovery from a
 * deleted or moved stage possible without requiring a separate editor.
 */
export function getSubItemStageNumbers(children: WorkItemData[]): number[] {
  const maxStage = children.reduce(
    (max, child) => Math.max(max, child.frontmatter.stage ?? 0),
    0
  );
  return Array.from({ length: Math.max(1, maxStage + 1) }, (_, index) =>
    Number(index + 1)
  );
}

interface WorkItemSubItemsProps {
  family: WorkItemFamily;
  parentShortId: string;
  projectSlug?: string | null;
  orgId?: string | null;
  onOpenWorkItem?: (item: WorkItemData) => void;
}

interface SubItemStateIconProps {
  state: SubItemVisualState;
  label: string;
}

const SubItemStateIcon: React.FC<SubItemStateIconProps> = ({
  state,
  label,
}) => {
  const commonProps = {
    size: 16,
    strokeWidth: 1.8,
    "aria-hidden": true,
  } as const;

  return (
    <span
      className="flex size-5 shrink-0 items-center justify-center"
      title={label}
    >
      {state === "completed" ? (
        <CheckCircle2 {...commonProps} className="text-purple-6" />
      ) : state === "cancelled" ? (
        <CircleSlash2 {...commonProps} className="text-text-4" />
      ) : (
        <CircleDot {...commonProps} className="text-success-6" />
      )}
      <span className="sr-only">{label}</span>
    </span>
  );
};

const WorkItemSubItems: React.FC<WorkItemSubItemsProps> = ({
  family,
  parentShortId,
  projectSlug,
  orgId,
  onOpenWorkItem,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  const { children, parent } = family;
  const [adding, setAdding] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftStage, setDraftStage] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);

  const stageOptions = useMemo<SelectOption[]>(
    () => [
      {
        label: t("workItems.subItems.noStage", { defaultValue: "No stage" }),
        value: "none",
      },
      ...getSubItemStageNumbers(children).map((stage) => ({
        label: t("workItems.subItems.stage", {
          defaultValue: "Stage {{stage}}",
          stage,
        }),
        value: stage,
      })),
    ],
    [children, t]
  );

  const progress = useMemo(() => getSubItemProgress(children), [children]);

  const closeComposer = useCallback(() => {
    setAdding(false);
    setDraftTitle("");
    setDraftStage(null);
    setCreateError(false);
  }, []);

  const handleCreateSubItem = useCallback(async () => {
    const title = draftTitle.trim();
    if (!title || creating || !parentShortId) return;
    setCreating(true);
    setCreateError(false);
    try {
      if (projectSlug) {
        const shortId = await allocateCloudAwareWorkItemId(projectSlug);
        await projectApi.createWorkItem(projectSlug, shortId, {
          title,
          parent: parentShortId,
          stage: draftStage ?? undefined,
          status: "planned",
        });
      } else {
        const shortId = await allocateCloudAwareStandaloneWorkItemId(
          orgId ?? undefined
        );
        await projectApi.createStandaloneWorkItem(
          shortId,
          {
            title,
            parent: parentShortId,
            stage: draftStage ?? undefined,
            status: "planned",
          },
          orgId ? { orgId } : undefined
        );
      }
      setDraftTitle("");
      setDraftStage(null);
      setAdding(false);
      await emit("orgii-data-changed", {
        work_item_id: parentShortId,
        project_slug: projectSlug || undefined,
        source: "sub-item-quick-add",
      });
    } catch (error) {
      logger.error("Failed to create sub item", error);
      setCreateError(true);
    } finally {
      setCreating(false);
    }
  }, [creating, draftStage, draftTitle, orgId, parentShortId, projectSlug]);

  if (!parentShortId) return null;

  const statusLabel = (state: SubItemVisualState): string => {
    if (state === "completed") {
      return t("workItems.subItems.completedStatus", {
        defaultValue: "Completed",
      });
    }
    if (state === "cancelled") {
      return t("workItems.subItems.cancelledStatus", {
        defaultValue: "Cancelled",
      });
    }
    return t("workItems.subItems.openStatus", { defaultValue: "Open" });
  };

  const composer = adding ? (
    <div
      className={children.length > 0 ? "pb-1 pt-3" : "py-4"}
      data-testid="work-item-sub-item-composer"
    >
      <div className="flex items-center gap-2">
        <div className="w-28 shrink-0">
          <Select
            value={draftStage ?? "none"}
            options={stageOptions}
            disabled={creating}
            size="small"
            radius="md"
            appearance="ghost"
            dropdownWidthMode="auto"
            className="w-full"
            selectorClassName="font-normal"
            ariaLabel={t("workItems.subItems.stagePicker", {
              defaultValue: "Sub-item stage",
            })}
            dataTestId="work-item-sub-item-stage-select"
            onChange={(value) => {
              if (Array.isArray(value)) return;
              setDraftStage(value === "none" ? null : Number(value));
            }}
          />
        </div>
        <Input
          autoFocus
          value={draftTitle}
          disabled={creating}
          placeholder={t("workItems.subItems.titlePlaceholder", {
            defaultValue: "Add a sub-item title",
          })}
          size="small"
          appearance="ghost"
          className="min-w-0 flex-1"
          inputClassName="text-[13px] !font-normal"
          onChange={(value) => {
            setDraftTitle(value);
            if (createError) setCreateError(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleCreateSubItem();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              closeComposer();
            }
          }}
          data-testid="work-item-sub-item-title-input"
        />
        <Button
          variant="tertiary"
          appearance="ghost"
          size="small"
          shape="square"
          iconOnly
          icon={<Plus size={13} aria-hidden />}
          aria-label={t("common:actions.create")}
          disabled={!draftTitle.trim()}
          loading={creating}
          onClick={() => void handleCreateSubItem()}
          data-testid="work-item-sub-item-commit"
        />
        <Button
          variant="tertiary"
          appearance="ghost"
          size="small"
          shape="square"
          iconOnly
          icon={<X size={13} aria-hidden />}
          aria-label={t("common:actions.cancel")}
          disabled={creating}
          onClick={closeComposer}
        />
      </div>
      {createError ? (
        <p className="mt-1.5 text-[11px] text-danger-6" role="status">
          {t("workItems.subItems.createError", {
            defaultValue: "Could not create the sub-item. Try again.",
          })}
        </p>
      ) : null}
    </div>
  ) : null;

  return (
    <WorkItemThreadSection
      testId="work-item-sub-items"
      icon={
        <ListTree
          size={14}
          strokeWidth={1.8}
          className="shrink-0 text-text-3"
          aria-hidden
        />
      }
      title={
        <span className="font-normal">{t("workItems.subItems.title")}</span>
      }
      meta={
        progress.total > 0 ? (
          <span className="text-[11px] tabular-nums text-text-4">
            {t("workItems.subItems.progress", {
              defaultValue: "{{completed}} of {{total}} completed",
              completed: progress.completed,
              total: progress.total,
            })}
          </span>
        ) : null
      }
      action={
        <Button
          variant="tertiary"
          appearance="ghost"
          size="mini"
          icon={<Plus size={13} aria-hidden />}
          className="!font-normal"
          disabled={adding}
          onClick={() => setAdding(true)}
          data-testid="work-item-sub-item-add"
        >
          {t("workItems.subItems.add", { defaultValue: "Add sub-item" })}
        </Button>
      }
      bodyClassName="!p-0"
    >
      {parent ? (
        <button
          type="button"
          className="group mx-3 mt-1 flex w-[calc(100%-1.5rem)] cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-fill-1 disabled:cursor-default"
          onClick={() => onOpenWorkItem?.(parent)}
          disabled={!onOpenWorkItem}
          data-testid="work-item-parent-link"
        >
          <span className="shrink-0 text-[11px] font-normal text-text-4">
            {t("workItems.subItems.parent")}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] font-normal text-text-2">
            {parent.frontmatter.title}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-text-4">
            {parent.frontmatter.short_id}
          </span>
          {onOpenWorkItem ? (
            <ChevronRight
              size={14}
              className="shrink-0 text-text-4 transition-colors group-hover:text-text-2"
              aria-hidden
            />
          ) : null}
        </button>
      ) : null}

      {progress.total > 0 ? (
        <div className="px-3 pb-2 pt-2.5">
          <div
            className="h-1 overflow-hidden rounded-full bg-fill-2"
            role="progressbar"
            aria-label={t("workItems.subItems.progress", {
              defaultValue: "{{completed}} of {{total}} completed",
              completed: progress.completed,
              total: progress.total,
            })}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.completed}
            data-testid="work-item-sub-items-progress"
          >
            <div
              className="h-full rounded-full bg-success-6 transition-[width]"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      ) : null}

      {children.length > 0 || adding ? (
        <div className={children.length > 0 ? "px-3 pb-3" : "px-3"}>
          <div className="max-h-64 overflow-y-auto">
            {groupSubItemsByStage(children).map((group) => (
              <div key={group.key}>
                {group.label ? (
                  <div className="px-2 pb-1 pt-2 text-[10px] font-normal uppercase tracking-wide text-text-4">
                    {group.stage !== undefined
                      ? t("workItems.subItems.stage", {
                          defaultValue: "Stage {{stage}}",
                          stage: group.stage,
                        })
                      : t("workItems.subItems.noStage", {
                          defaultValue: "No stage",
                        })}
                  </div>
                ) : null}
                {group.items.map((child) => {
                  const state = getSubItemVisualState(child.frontmatter.status);
                  return (
                    <button
                      type="button"
                      key={child.frontmatter.short_id}
                      className="group flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-fill-1 disabled:cursor-default"
                      onClick={() => onOpenWorkItem?.(child)}
                      disabled={!onOpenWorkItem}
                      data-sub-item-state={state}
                      data-testid={`work-item-sub-item-${child.frontmatter.short_id}`}
                    >
                      <SubItemStateIcon
                        state={state}
                        label={statusLabel(state)}
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-normal text-text-1">
                        {child.frontmatter.title}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-text-4">
                        {child.frontmatter.short_id}
                      </span>
                      {onOpenWorkItem ? (
                        <ChevronRight
                          size={14}
                          className="shrink-0 text-text-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                          aria-hidden
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
            {composer}
          </div>
        </div>
      ) : (
        <div className="px-3 py-2">
          <Button
            variant="tertiary"
            appearance="ghost"
            size="small"
            long
            icon={<Plus size={13} aria-hidden />}
            iconPosition="right"
            className="!h-auto !justify-between !rounded-lg !px-2 !py-2 !text-left !text-[12px] !font-normal !text-text-3 hover:!bg-fill-1 hover:!text-text-2"
            onClick={() => setAdding(true)}
            data-testid="work-item-sub-items-empty-add"
          >
            {t("workItems.subItems.addFirst", {
              defaultValue: "Add the first sub-item",
            })}
          </Button>
        </div>
      )}
    </WorkItemThreadSection>
  );
};

export default WorkItemSubItems;
