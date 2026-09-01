import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { GitWorktreeDiffSummary } from "@src/api/http/git/types";
import AnyIcon from "@src/components/AnyIcon";
import DiffStatsBadge from "@src/components/DiffStatsBadge";
import Dropdown from "@src/components/Dropdown";
import DropdownItem from "@src/components/Dropdown/DropdownItem";
import DropdownSearch from "@src/components/Dropdown/DropdownSearch";
import DropdownSelectedCheck from "@src/components/Dropdown/DropdownSelectedCheck";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import IconButton from "@src/components/IconButton";
import SelectGhostTrigger from "@src/components/Select/SelectGhostTrigger";
import {
  ArrowRight01Icon,
  Delete02Icon,
  FolderClosedIcon,
  HugeiconsIcon,
  WorkflowCircle05Icon,
} from "@src/icons";
import {
  formatCompactStatNumber,
  formatDiffStatsLabel,
} from "@src/shared/pr/formatStatNumber";

import {
  type ScopePickerWorktreeEntry,
  type SourceControlScope,
  diffStatsFromSummary,
  filterScopePickerWorktrees,
  formatScopeDiffStatsTooltip,
  formatScopePickerPath,
  mainScopeMatchesQuery,
  resolveScopeBranchLabel,
  resolveScopeBreadcrumbSegments,
  scopePickerRowLabel,
  scopePickerRowTitle,
  shouldShowScopePickerSearch,
  sortWorktreesByDiffActivity,
  worktreeFolderName,
} from "./sourceControlScopePickerHelpers";

export type { SourceControlScope } from "./sourceControlScopePickerHelpers";

const BREADCRUMB_TONE_CLASS = {
  muted: "text-text-3",
  primary: "font-medium text-text-1",
  secondary: "text-text-2",
} as const;

const SCOPE_PICKER_REMOVE_BUTTON = [
  "absolute right-1 top-1/2 z-1 -translate-y-1/2 bg-surface-hover",
  "pointer-events-none opacity-0 transition-opacity",
  "group-hover/scope-row:pointer-events-auto group-hover/scope-row:opacity-100",
  "group-focus-within/scope-row:pointer-events-auto group-focus-within/scope-row:opacity-100",
  "focus-visible:pointer-events-auto focus-visible:opacity-100",
].join(" ");

function ScopePickerDiffStats({
  summary,
}: {
  summary?: GitWorktreeDiffSummary | null;
}) {
  const stats = diffStatsFromSummary(summary);
  if (!stats) return null;

  return (
    <span
      className="shrink-0"
      title={
        summary
          ? formatScopeDiffStatsTooltip(summary)
          : formatDiffStatsLabel(stats.additions, stats.deletions)
      }
    >
      <DiffStatsBadge
        additions={stats.additions}
        deletions={stats.deletions}
        variant="plain"
        size="xs"
        formatValue={formatCompactStatNumber}
        valueClassName="min-w-0"
      />
    </span>
  );
}

function ScopePickerItemSuffix({
  selected,
  summary,
}: {
  selected: boolean;
  summary?: GitWorktreeDiffSummary | null;
}) {
  const stats = <ScopePickerDiffStats summary={summary} />;
  if (!selected) return stats;

  return (
    <span className="flex shrink-0 items-center gap-2">
      {stats}
      <DropdownSelectedCheck />
    </span>
  );
}

function ScopePickerSectionLabel({ label }: { label: string }) {
  return (
    <div className={DROPDOWN_CLASSES.sectionLabel}>
      {label.toLocaleUpperCase()}
    </div>
  );
}

function ScopePickerItem({
  kind,
  name,
  branch,
  path,
  summary,
  selected,
  onSelect,
  onRemove,
  removeLabel,
}: {
  kind: "main" | "worktree";
  name: string;
  branch: string;
  path: string;
  summary?: GitWorktreeDiffSummary | null;
  selected: boolean;
  onSelect: () => void;
  onRemove?: () => void;
  removeLabel: string;
}) {
  const label = scopePickerRowLabel(kind, name, branch);
  const title = [
    scopePickerRowTitle(kind, name, branch, path),
    summary ? formatScopeDiffStatsTooltip(summary) : null,
  ]
    .filter(Boolean)
    .join("\n");
  const ScopeIcon =
    kind === "worktree" ? FolderClosedIcon : WorkflowCircle05Icon;
  const hasDiffStats = diffStatsFromSummary(summary) !== null;

  return (
    <div className="group/scope-row relative w-full">
      <DropdownItem
        selected={selected}
        showCheckmark={false}
        onClick={onSelect}
        icon={
          <AnyIcon
            icon={ScopeIcon}
            size={DROPDOWN_ITEM.iconSize}
            strokeWidth={1.75}
          />
        }
        className="w-full"
        suffix={
          selected || hasDiffStats ? (
            <ScopePickerItemSuffix selected={selected} summary={summary} />
          ) : undefined
        }
      >
        <span title={title}>{label}</span>
      </DropdownItem>
      {onRemove ? (
        <IconButton
          type="button"
          size="sm"
          variant="danger"
          className={SCOPE_PICKER_REMOVE_BUTTON}
          title={removeLabel}
          aria-label={removeLabel}
          data-dropdown-keyboard-skip="true"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <HugeiconsIcon
            icon={Delete02Icon}
            data-icon="trash-2"
            size={DROPDOWN_ITEM.iconSize}
          />
        </IconButton>
      ) : null}
    </div>
  );
}

export interface SourceControlScopeToolbarProps {
  repoName: string;
  branchLabel: string;
  repoPath: string;
  localDiffSummary?: GitWorktreeDiffSummary | null;
  worktrees: ScopePickerWorktreeEntry[];
  scope: SourceControlScope;
  onScopeChange: (scope: SourceControlScope) => void;
  onRemoveWorktree?: (worktree: ScopePickerWorktreeEntry) => void;
}

/** Worktree scope switcher for the main Source Control tab header. */
export function SourceControlScopeToolbar({
  repoName,
  branchLabel,
  repoPath,
  localDiffSummary,
  worktrees,
  scope,
  onScopeChange,
  onRemoveWorktree,
}: SourceControlScopeToolbarProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const sortedWorktrees = useMemo(
    () => sortWorktreesByDiffActivity(worktrees),
    [worktrees]
  );
  const filteredWorktrees = useMemo(
    () => filterScopePickerWorktrees(sortedWorktrees, searchQuery),
    [searchQuery, sortedWorktrees]
  );
  const showMainScope = mainScopeMatchesQuery(
    repoName,
    branchLabel,
    repoPath,
    searchQuery
  );
  const showSearch = shouldShowScopePickerSearch(worktrees.length);

  const selectedWorktree =
    scope.kind === "worktree"
      ? worktrees.find((worktree) => worktree.path === scope.path)
      : undefined;
  const activeBranch = resolveScopeBranchLabel(branchLabel, selectedWorktree);
  const activeScopePath = selectedWorktree?.path ?? repoPath;
  const breadcrumbSegments = useMemo(
    () =>
      resolveScopeBreadcrumbSegments({
        repoName,
        branchLabel: activeBranch,
        scope,
        selectedWorktreePath: selectedWorktree?.path,
      }),
    [activeBranch, repoName, scope, selectedWorktree?.path]
  );
  const triggerAriaLabel = t("sourceControl.scope.switchScopeActive", {
    repo: repoName,
    branch: activeBranch,
  });

  const handleVisibleChange = useCallback((visible: boolean) => {
    setOpen(visible);
    if (!visible) {
      setSearchQuery("");
    }
  }, []);

  const selectScope = useCallback(
    (nextScope: SourceControlScope) => {
      onScopeChange(nextScope);
      setOpen(false);
      setSearchQuery("");
    },
    [onScopeChange]
  );

  const droplist = (
    <div
      className={`${DROPDOWN_CLASSES.panel} ${DROPDOWN_WIDTHS.fileTreeClass} max-w-[320px] overflow-hidden`}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {showSearch ? (
        <DropdownSearch
          type="search"
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t("sourceControl.scope.searchPlaceholder")}
          ariaLabel={t("sourceControl.scope.searchPlaceholder")}
        />
      ) : null}
      <div className={DROPDOWN_CLASSES.optionsContainerScrollbar}>
        {showMainScope ? (
          <>
            <ScopePickerSectionLabel label={t("sourceControl.scope.main")} />
            <ScopePickerItem
              kind="main"
              name={repoName}
              branch={branchLabel}
              path={repoPath}
              summary={localDiffSummary}
              selected={scope.kind === "local"}
              onSelect={() => selectScope({ kind: "local" })}
              removeLabel={t("sourceControl.removeWorktree")}
            />
          </>
        ) : null}
        {filteredWorktrees.length > 0 ? (
          <>
            {showMainScope ? (
              <div
                aria-hidden="true"
                className={DROPDOWN_CLASSES.menuGroupSeparator}
              />
            ) : null}
            {showMainScope ? (
              <ScopePickerSectionLabel
                label={t("sourceControl.scope.worktrees")}
              />
            ) : null}
            {filteredWorktrees.map((worktree) => (
              <ScopePickerItem
                key={worktree.path}
                kind="worktree"
                name={worktreeFolderName(worktree.path)}
                branch={worktree.branch}
                path={worktree.path}
                summary={worktree.diff_summary}
                selected={
                  scope.kind === "worktree" && scope.path === worktree.path
                }
                onSelect={() =>
                  selectScope({ kind: "worktree", path: worktree.path })
                }
                onRemove={
                  onRemoveWorktree
                    ? () => onRemoveWorktree(worktree)
                    : undefined
                }
                removeLabel={t("sourceControl.removeWorktree")}
              />
            ))}
          </>
        ) : null}
        {!showMainScope && filteredWorktrees.length === 0 ? (
          <div className={DROPDOWN_CLASSES.listMessage}>
            {t("placeholders.noResults", "No results")}
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <Dropdown
      droplist={droplist}
      popupVisible={open}
      onVisibleChange={handleVisibleChange}
      trigger="click"
      position="bottom-start"
      getPopupContainer={() => document.body}
      avoidViewportOverflow
    >
      <SelectGhostTrigger
        open={open}
        className="w-auto max-w-[min(100%,32rem)] min-w-0"
        title={`${formatScopePickerPath(activeScopePath)} · ${activeBranch}`}
        ariaLabel={triggerAriaLabel}
        value={
          <span className="flex min-w-0 items-center gap-1 truncate">
            {breadcrumbSegments.map((segment, index) => (
              <React.Fragment key={`${segment.label}-${index}`}>
                {index > 0 ? (
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    data-icon="chevron-right"
                    size={10}
                    className="shrink-0 text-text-4"
                  />
                ) : null}
                <span
                  className={`truncate ${segment.tone === "primary" ? "min-w-0" : "shrink-0"} ${BREADCRUMB_TONE_CLASS[segment.tone]}`}
                >
                  {segment.label}
                </span>
              </React.Fragment>
            ))}
          </span>
        }
      />
    </Dropdown>
  );
}
