/**
 * PullRequestContent
 *
 * Sidebar PR list using TreeRowBase rows grouped under a collapsible
 * "OPEN" section header (same pattern as IssuesContent).
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAtomValue } from "jotai";
import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type { OpenPRItem } from "@src/api/tauri/github";
import PrHoverCard from "@src/components/PrHoverCard";
import { TreeRowBase, type TreeRowNode } from "@src/components/TreeRow";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import {
  type SectionStatus,
  SectionStatusRow,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/components/SectionStatusRow";
import { TreeSectionHeader } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/components/TreeSectionHeader";
import type { TabDragPillPayload } from "@src/modules/WorkStation/shared/TabBar/tabDragTypes";
import { TYPOGRAPHY } from "@src/modules/WorkStation/shared/tokens";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { ReferenceDragGhost } from "@src/shared/dnd/ReferenceDragGhost";
import { setPrDragStash } from "@src/shared/dnd/dragSideChannel";
import { useReferencePillDrag } from "@src/shared/dnd/useReferencePillDrag";
import {
  workstationAllClosedPrsAtomFamily,
  workstationAllOpenPrsAtomFamily,
  workstationClosedPrsErrorAtomFamily,
  workstationClosedPrsLoadStateAtomFamily,
  workstationOpenPrsErrorAtomFamily,
  workstationOpenPrsLoadStateAtomFamily,
  workstationPrAtomFamily,
  workstationPrCallbackAtomFamily,
  workstationRepoScopeKey,
} from "@src/store/workstation/codeEditor/workstationPrAtom";
import type { SourceControlHistorySelection } from "@src/store/workstation/tabs";

import { filterPullRequestsByQuery } from "../../hooks/workstationPrHelpers";
import { getPrStatusIconName, getPrStatusVariant } from "./prCardHelpers";

export interface PullRequestContentProps {
  branchName?: string;
  filterQuery?: string;
  onHistorySelectionChange?: (selection: SourceControlHistorySelection) => void;
  repoId?: string | null;
  repoPath?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePrUrl(
  prUrl: string | undefined
): { repoFullName: string; number: number } | null {
  if (!prUrl) return null;
  const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { repoFullName: m[1], number: Number(m[2]) };
}

// ── PR tree row ───────────────────────────────────────────────────────────────

type PrVirtualRow =
  | { kind: "header"; section: "open" | "closed" }
  | { kind: "status"; section: "open" | "closed"; status: SectionStatus }
  | { kind: "pr"; pr: OpenPRItem };

interface PrRowProps {
  pr: OpenPRItem;
  depth?: number;
  isCurrentBranch: boolean;
  isSelected: boolean;
  onClick: (pr: OpenPRItem) => void;
}

const PrRow: React.FC<PrRowProps> = memo(
  ({ pr, depth = 1, isCurrentBranch, isSelected, onClick }) => {
    const statusKey = pr.draft ? "draft" : pr.state;
    const statusVariant = getPrStatusVariant(statusKey);

    const buildPrPayload = useCallback(
      () => ({
        prNumber: pr.number,
        prTitle: pr.title,
        prUrl: pr.url,
        prStatus: statusKey,
        sourceBranch: pr.head_branch,
        targetBranch: pr.base_branch,
      }),
      [pr, statusKey]
    );

    const buildPrPillPayload = useCallback((): TabDragPillPayload => {
      const prPayload = buildPrPayload();
      return {
        path: `pr://${prPayload.prNumber}`,
        name: `#${prPayload.prNumber} ${prPayload.prTitle}`,
        iconType: "pr",
        isFolder: false,
        contextText: JSON.stringify(prPayload),
      };
    }, [buildPrPayload]);

    const stashPrDrag = useCallback(() => {
      setPrDragStash(buildPrPayload());
    }, [buildPrPayload]);

    const node: TreeRowNode = useMemo(() => {
      const iconName = getPrStatusIconName(statusKey);
      const PrIcon =
        iconName === "draft"
          ? GitPullRequestDraft
          : iconName === "merge"
            ? GitMerge
            : iconName === "closed"
              ? GitPullRequestClosed
              : GitPullRequest;
      return {
        id: String(pr.number),
        name: pr.title,
        path: pr.url,
        type: "file",
        icon: (
          <span className={statusVariant.dotClass.replace("bg-", "text-")}>
            <PrIcon size={14} strokeWidth={1.75} />
          </span>
        ),
      };
    }, [pr.number, pr.title, pr.url, statusKey, statusVariant.dotClass]);

    const { dragHandlers, dragState } = useReferencePillDrag<HTMLDivElement>({
      tabId: `pr-${pr.number}`,
      getPayload: buildPrPillPayload,
      onPointerDown: stashPrDrag,
    });

    return (
      <>
        {dragState && <ReferenceDragGhost dragState={dragState} />}
        <PrHoverCard pr={pr}>
          <TreeRowBase
            node={node}
            depth={depth}
            isSelected={isSelected}
            onClick={() => onClick(pr)}
            showIndentGuides={false}
            onMouseDown={stashPrDrag}
            {...dragHandlers}
            className={
              isCurrentBranch
                ? "border-l-2 border-primary-5 !pl-[calc(theme(spacing.3)+2px+theme(spacing.4))]"
                : undefined
            }
          >
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <span className="min-w-[28px] text-right text-[11px] tabular-nums text-text-3">
                #{pr.number}
              </span>
            </span>
          </TreeRowBase>
        </PrHoverCard>
      </>
    );
  }
);
PrRow.displayName = "PrRow";

// ── Main component ─────────────────────────────────────────────────────────────

const PullRequestContent: React.FC<PullRequestContentProps> = ({
  branchName,
  filterQuery = "",
  onHistorySelectionChange,
  repoId,
  repoPath,
}) => {
  const { t } = useTranslation("common");
  const scopeKey = workstationRepoScopeKey(repoId, repoPath);
  const {
    prUrl,
    readyToCreate,
    isCreating: prCreating,
  } = useAtomValue(workstationPrAtomFamily(scopeKey));
  const {
    createPr: onCreatePr,
    loadOpenPrs,
    loadClosedPrs,
  } = useAtomValue(workstationPrCallbackAtomFamily(scopeKey));
  const allOpenPrs = useAtomValue(workstationAllOpenPrsAtomFamily(scopeKey));
  const allClosedPrs = useAtomValue(
    workstationAllClosedPrsAtomFamily(scopeKey)
  );
  const openPrsLoadState = useAtomValue(
    workstationOpenPrsLoadStateAtomFamily(scopeKey)
  );
  const openPrsError = useAtomValue(
    workstationOpenPrsErrorAtomFamily(scopeKey)
  );
  const closedPrsLoadState = useAtomValue(
    workstationClosedPrsLoadStateAtomFamily(scopeKey)
  );
  const closedPrsError = useAtomValue(
    workstationClosedPrsErrorAtomFamily(scopeKey)
  );

  useEffect(() => {
    loadOpenPrs?.();
  }, [loadOpenPrs]);

  const [selectedPrNumber, setSelectedPrNumber] = useState<number | null>(null);
  const [localCreateError, setLocalCreateError] = useState<string | null>(null);
  const [openCollapsed, setOpenCollapsed] = useState(false);
  const [closedCollapsed, setClosedCollapsed] = useState(true);

  const currentBranchPrFromList = useMemo(
    () =>
      branchName
        ? (allOpenPrs.find((p) => p.head_branch === branchName) ?? null)
        : null,
    [allOpenPrs, branchName]
  );

  const parsedAtomPr = useMemo(() => parsePrUrl(prUrl), [prUrl]);

  const orderedPrs = useMemo(() => {
    const sorted = currentBranchPrFromList
      ? [
          currentBranchPrFromList,
          ...allOpenPrs.filter(
            (p) => p.number !== currentBranchPrFromList.number
          ),
        ]
      : allOpenPrs;
    return filterPullRequestsByQuery(sorted, filterQuery);
  }, [allOpenPrs, currentBranchPrFromList, filterQuery]);

  const filteredClosedPrs = useMemo(
    () => filterPullRequestsByQuery(allClosedPrs, filterQuery),
    [allClosedPrs, filterQuery]
  );

  const handleToggleClosed = useCallback(() => {
    setClosedCollapsed((collapsed) => {
      if (collapsed && closedPrsLoadState === "idle") {
        loadClosedPrs?.();
      }
      return !collapsed;
    });
  }, [closedPrsLoadState, loadClosedPrs]);

  const handlePrClick = useCallback(
    (pr: OpenPRItem) => {
      setSelectedPrNumber(pr.number);
      const statusKey = pr.draft ? "draft" : pr.state;
      onHistorySelectionChange?.({
        type: "pr",
        prNumber: pr.number,
        prTitle: pr.title,
        prUrl: pr.url,
        prStatus: statusKey,
        headBranch: pr.head_branch,
      });
    },
    [onHistorySelectionChange]
  );

  const handleCreate = useCallback(async () => {
    if (!onCreatePr || prCreating) return;
    setLocalCreateError(null);
    try {
      const result = await onCreatePr();
      if (result.error && result.error !== "not_authenticated") {
        setLocalCreateError(result.error);
      }
    } catch (err) {
      setLocalCreateError(err instanceof Error ? err.message : String(err));
    }
  }, [onCreatePr, prCreating]);

  const hasCurrentBranchPr = !!currentBranchPrFromList || !!parsedAtomPr;

  const openStatus = useMemo<SectionStatus | null>(
    () =>
      openPrsLoadState === "loading" && orderedPrs.length === 0
        ? { kind: "loading", message: t("actions.loading", "Loading…") }
        : openPrsLoadState === "error" && orderedPrs.length === 0
          ? {
              kind: "error",
              message:
                openPrsError ??
                t("git.pr.failedToLoad", "Failed to load pull requests"),
            }
          : orderedPrs.length === 0
            ? {
                kind: "empty",
                message: t("labels.noPullRequest", "No pull request"),
              }
            : null,
    [openPrsError, openPrsLoadState, orderedPrs.length, t]
  );

  const closedStatus = useMemo<SectionStatus | null>(
    () =>
      closedPrsLoadState === "loading" && filteredClosedPrs.length === 0
        ? { kind: "loading", message: t("actions.loading", "Loading…") }
        : closedPrsLoadState === "error" && filteredClosedPrs.length === 0
          ? {
              kind: "error",
              message:
                closedPrsError ??
                t("git.pr.failedToLoad", "Failed to load pull requests"),
            }
          : closedPrsLoadState === "ready" && filteredClosedPrs.length === 0
            ? {
                kind: "empty",
                message: t("labels.noPullRequest", "No pull request"),
              }
            : null,
    [closedPrsError, closedPrsLoadState, filteredClosedPrs.length, t]
  );

  // When the Open section is the sidebar's only content (Closed collapsed) and
  // it has no rows, render its loading/empty state as a centered Explorer-style
  // Placeholder that fills the pane instead of a compact inline row. Error
  // states and per-section states keep the inline SectionStatusRow so each
  // section retains its own structured state.
  const openWholePane = closedCollapsed && orderedPrs.length === 0;

  // Virtualized row model — headers, per-section status, and PR rows flattened
  // into one windowed list (same pattern as IssuesContent). Collapsed sections
  // contribute only their header, so their rows are never built or mounted.
  const virtualRows = useMemo<PrVirtualRow[]>(() => {
    const rows: PrVirtualRow[] = [{ kind: "header", section: "open" }];
    if (!openCollapsed) {
      if (openStatus) {
        rows.push({ kind: "status", section: "open", status: openStatus });
      } else {
        rows.push(...orderedPrs.map((pr) => ({ kind: "pr" as const, pr })));
      }
    }
    rows.push({ kind: "header", section: "closed" });
    if (!closedCollapsed) {
      if (closedStatus) {
        rows.push({ kind: "status", section: "closed", status: closedStatus });
      } else {
        rows.push(
          ...filteredClosedPrs.map((pr) => ({ kind: "pr" as const, pr }))
        );
      }
    }
    return rows;
  }, [
    closedCollapsed,
    closedStatus,
    filteredClosedPrs,
    openCollapsed,
    openStatus,
    orderedPrs,
  ]);

  const listRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual exposes imperative helpers that cannot be memoized safely.
  const prListVirtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => (virtualRows[index]?.kind === "status" ? 36 : 24),
    overscan: 10,
  });
  const virtualItems = prListVirtualizer.getVirtualItems();

  const renderVirtualRow = (row: PrVirtualRow): React.ReactNode => {
    switch (row.kind) {
      case "header":
        return row.section === "open" ? (
          <TreeSectionHeader
            id="open-prs"
            title="Open"
            collapsed={openCollapsed}
            count={orderedPrs.length}
            onToggle={() => setOpenCollapsed((prev) => !prev)}
          />
        ) : (
          <TreeSectionHeader
            id="closed-prs"
            title="Closed"
            collapsed={closedCollapsed}
            count={
              closedPrsLoadState === "ready" ? filteredClosedPrs.length : null
            }
            onToggle={handleToggleClosed}
          />
        );
      case "status":
        return <SectionStatusRow status={row.status} />;
      case "pr":
        return (
          <PrRow
            pr={row.pr}
            depth={1}
            isCurrentBranch={row.pr.head_branch === branchName}
            isSelected={row.pr.number === selectedPrNumber}
            onClick={handlePrClick}
          />
        );
    }
  };

  let listContent: React.ReactNode;
  if (!openCollapsed && openWholePane && openStatus?.kind !== "error") {
    // Open is the only expanded section and has no rows — surface its
    // loading/empty state as a full-pane placeholder, keeping both headers.
    listContent = (
      <div className="flex flex-1 flex-col overflow-hidden">
        <TreeSectionHeader
          id="open-prs"
          title="Open"
          collapsed={openCollapsed}
          count={orderedPrs.length}
          onToggle={() => setOpenCollapsed((prev) => !prev)}
        />
        <Placeholder
          variant={openStatus?.kind === "loading" ? "loading" : "empty"}
          placement="sidebar"
          title={
            openStatus?.kind === "loading" ? undefined : openStatus?.message
          }
          fillParentHeight
        />
        <TreeSectionHeader
          id="closed-prs"
          title="Closed"
          collapsed={closedCollapsed}
          count={
            closedPrsLoadState === "ready" ? filteredClosedPrs.length : null
          }
          onToggle={handleToggleClosed}
        />
      </div>
    );
  } else {
    listContent = (
      <div ref={listRef} className="flex flex-1 overflow-y-auto">
        <div
          className="relative w-full"
          style={{ height: prListVirtualizer.getTotalSize() }}
        >
          {virtualItems.map((virtualItem) => {
            const row = virtualRows[virtualItem.index];
            return (
              <div
                key={virtualItem.key}
                ref={prListVirtualizer.measureElement}
                data-index={virtualItem.index}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                {renderVirtualRow(row)}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Create PR section */}
      {!hasCurrentBranchPr && readyToCreate && (
        <div className="flex flex-col gap-3 border-b border-border-2 p-3">
          <div>
            <p className={`${TYPOGRAPHY.secondary} text-text-2`}>
              {t(
                "labels.noPullRequestForBranch",
                "There is no pull request for this branch yet"
              )}
            </p>
          </div>
          {prCreating ? (
            <div
              className={`flex items-center gap-2 ${TYPOGRAPHY.secondary} text-text-3`}
            >
              <Loader2
                size={SPINNER_TOKENS.default}
                className="animate-spin text-text-3"
              />
              <span>{t("labels.creatingPullRequest", "Creating…")}</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleCreate}
              disabled={!onCreatePr}
              className="flex h-7 items-center justify-center rounded-md bg-primary-6 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-primary-7 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("actions.createPullRequest", "Create pull request")}
            </button>
          )}
          {localCreateError && (
            <div className="flex items-start gap-1.5 rounded-md bg-fill-2 px-2 py-1.5">
              <TriangleAlert
                size={12}
                className="mt-0.5 shrink-0 text-warning-6"
              />
              <p
                className={`min-w-0 flex-1 ${TYPOGRAPHY.secondary} text-text-2`}
              >
                {localCreateError}
              </p>
            </div>
          )}
        </div>
      )}

      {/* PR tree list (virtualized) */}
      {listContent}
    </div>
  );
};

PullRequestContent.displayName = "PullRequestContent";

export default memo(PullRequestContent);
