import { useAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { OpenPRItem } from "@src/api/tauri/github";
import AnyIcon from "@src/components/AnyIcon";
import DropdownSearch from "@src/components/Dropdown/DropdownSearch";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import { Placeholder } from "@src/components/Placeholder";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { ArrowDown01Icon, Refresh04Icon } from "@src/icons";
import { preparePullRequestBranch } from "@src/services/git/operations/preparePullRequestBranch";
import { spotlightShowBranchInfoAtom } from "@src/store/ui/spotlightShowBranchInfoAtom";
import { getViewportSize } from "@src/util/ui/window/viewport";

import {
  SpotlightFooterToggle,
  SpotlightPinnedActionSection,
} from "../../components";
import { useRefreshSpin } from "../../shared";
import { PaletteBody, ShellFooterAction } from "../../shell";
import type { SpotlightItem } from "../../types";
import { useSelectorKernel } from "../core";
import { BranchDropdownList } from "./BranchDropdownList";
import { type BranchPickerTab, BranchPickerTabs } from "./BranchPickerTabs";
import { BranchPullRequestChecks } from "./BranchPullRequestChecks";
import { getBranchPullRequestIcon } from "./BranchPullRequestIcon";
import type { BranchPaletteProps } from "./types";
import {
  BRANCH_PICKER_PR_LIMIT,
  useBranchPullRequests,
} from "./useBranchPullRequests";

interface Props {
  repoId: string;
  repoPath: string;
  onSelect: BranchPaletteProps["onSelect"];
  onClose: () => void;
  onBranchPrepared: () => void;
  onTabChange: (tab: BranchPickerTab) => void;
  presentation?: "spotlight" | "dropdown";
  anchorRef?: React.RefObject<HTMLElement | null>;
  placement?: "top" | "bottom" | "auto";
}

const prRowKey = (pr: OpenPRItem) => pr.number;
const prRowHeight = () => 48;

function describePullRequest(pr: OpenPRItem, showBranchInfo: boolean) {
  return showBranchInfo
    ? `#${pr.number} · ${pr.author_login} · ${pr.head_branch} → ${pr.base_branch}`
    : `#${pr.number} · ${pr.author_login}`;
}

export function BranchPullRequestPicker({
  repoId,
  repoPath,
  onSelect,
  onClose,
  onBranchPrepared,
  onTabChange,
  presentation = "spotlight",
  anchorRef,
  placement = "bottom",
}: Props) {
  const { t } = useTranslation();
  const [showBranchInfo, setShowBranchInfo] = useAtom(
    spotlightShowBranchInfoAtom
  );
  const data = useBranchPullRequests(repoId, repoPath);
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const fallbackAnchor = useRef<HTMLElement>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const select = useCallback(
    async (pr: OpenPRItem) => {
      if (pendingRef.current || !data.remote || !data.repoFullName) return;
      pendingRef.current = true;
      setSelecting(true);
      setSelectionError(null);
      try {
        const name = await preparePullRequestBranch({
          repoId,
          repoPath,
          remote: data.remote,
          repoFullName: data.repoFullName,
          prNumber: pr.number,
          isActive: () => mountedRef.current,
        });
        if (!name || !mountedRef.current) return;
        onBranchPrepared();
        const shouldClose = await onSelect(name, {
          name,
          isCurrent: false,
          isRemote: false,
        });
        if (mountedRef.current && shouldClose !== false) onClose();
      } catch (error) {
        if (mountedRef.current)
          setSelectionError(
            error instanceof Error ? error.message : String(error)
          );
      } finally {
        pendingRef.current = false;
        if (mountedRef.current) setSelecting(false);
      }
    },
    [
      data.remote,
      data.repoFullName,
      repoId,
      repoPath,
      onSelect,
      onClose,
      onBranchPrepared,
    ]
  );

  const prs = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return data.prs;
    return data.prs.filter((pr) =>
      `${pr.title} #${pr.number} ${pr.head_branch} ${pr.base_branch} ${pr.author_login}`
        .toLowerCase()
        .includes(search)
    );
  }, [data.prs, query]);
  const items = useMemo<SpotlightItem[]>(
    () =>
      prs.map((pr) => ({
        id: `pr:${pr.number}`,
        label: pr.title,
        desc: describePullRequest(pr, showBranchInfo),
        icon: getBranchPullRequestIcon(pr),
        type: "option",
        data: {
          isSelector: true,
          disabled: selecting || Boolean(selectionError),
          rightContent: <BranchPullRequestChecks status={pr.ci_status} />,
        },
        action: () => {
          void select(pr);
        },
      })),
    [prs, select, selecting, selectionError, showBranchInfo]
  );
  const { refresh: refreshPullRequests } = data;
  const retry = useCallback(() => {
    setSelectionError(null);
    refreshPullRequests();
  }, [refreshPullRequests]);
  const { triggerRefresh, RefreshIcon } = useRefreshSpin(Refresh04Icon, retry);
  const refreshAction = useMemo<SpotlightItem>(
    () => ({
      id: "pinned-pr-refresh",
      label: t("selectors.branch.actions.refreshPullRequests"),
      icon: RefreshIcon,
      type: "action",
      data: { disabled: selecting || data.loading },
      action: triggerRefresh,
    }),
    [RefreshIcon, data.loading, selecting, t, triggerRefresh]
  );
  const { loadMore, hasMore, loadingMore, loadMoreError } = data;
  const pinnedActionItems = useMemo<SpotlightItem[]>(
    () => [
      refreshAction,
      ...(hasMore
        ? [
            {
              id: "pinned-pr-load-more",
              label: t(
                loadMoreError
                  ? "actions.retry"
                  : loadingMore
                    ? "status.loading"
                    : "actions.loadMore"
              ),
              icon: ArrowDown01Icon,
              type: "action" as const,
              data: { disabled: selecting || loadingMore },
              action: () => {
                void loadMore();
              },
            },
          ]
        : []),
    ],
    [refreshAction, hasMore, loadMoreError, loadingMore, loadMore, selecting, t]
  );
  const navigationItems = useMemo(
    () => [...items, ...pinnedActionItems],
    [items, pinnedActionItems]
  );
  const kernel = useSelectorKernel({
    isOpen: presentation === "spotlight",
    onClose,
    items: navigationItems,
    resetSelectionOnItemsChange: false,
    isItemSelectable: (item) => !item.data?.disabled,
    externalSearchQuery: query,
    externalSetSearchQuery: setQuery,
    onTab: (_forward, selectedIndex, setSelectedIndex) => {
      setSelectedIndex(
        selectedIndex >= items.length && items.length > 0 ? 0 : items.length
      );
    },
  });
  const { isPositioned, panelRef, panelPosition, keyboard } = useDropdownEngine<
    HTMLElement,
    SpotlightItem
  >({
    open: presentation === "dropdown",
    onOpenChange: (open) => {
      if (!open) onClose();
    },
    anchorRef: anchorRef ?? fallbackAnchor,
    placement,
    gap: DROPDOWN_PANEL.triggerGap,
    listNavigation: {
      items: navigationItems,
      onSelect: (item) => item.action?.(),
      isItemSelectable: (item) => !item.data?.disabled,
      initialSelectedIndex: -1,
    },
  });
  useEffect(() => {
    if (presentation === "dropdown" && isPositioned) inputRef.current?.focus();
  }, [presentation, isPositioned]);

  const previousItemCount = useRef(items.length);
  useEffect(() => {
    const previous = previousItemCount.current;
    previousItemCount.current = items.length;
    if (previous === 0 || previous === items.length) return;
    const navigation = presentation === "spotlight" ? kernel : keyboard;
    if (navigation.selectedIndex >= previous) {
      // Appending a page must not turn a highlighted footer action into a PR.
      navigation.setSelectedIndex(
        Math.min(
          navigation.selectedIndex + items.length - previous,
          items.length + pinnedActionItems.length - 1
        )
      );
    }
  }, [items.length, pinnedActionItems.length, presentation, kernel, keyboard]);

  const tabs = (
    <BranchPickerTabs value="prs" onChange={onTabChange} disabled={selecting} />
  );
  const placeholder = t("selectors.branch.placeholders.pullRequests");
  const error = selectionError ?? data.error;
  const content = error ? (
    <div role="alert">
      <Placeholder variant="error" subtitle={error} onRetry={retry} />
    </div>
  ) : data.loading ? (
    <Placeholder variant="loading" />
  ) : !data.repoFullName ? (
    <Placeholder
      variant="empty"
      title={t("selectors.branch.labels.noGithubRemote")}
    />
  ) : prs.length === 0 ? (
    <Placeholder
      variant="no-results"
      title={t("selectors.branch.labels.noPullRequests")}
    />
  ) : undefined;
  const searchIsPartial =
    Boolean(query.trim()) && (data.hasMore || data.limitReached);
  const loadOnScroll =
    data.hasMore &&
    !data.loadingMore &&
    !data.loadMoreError &&
    !selecting &&
    !query.trim()
      ? () => {
          void data.loadMore();
        }
      : undefined;
  const statusNote =
    selecting ||
    data.loadingMore ||
    data.loadMoreError ||
    data.limitReached ||
    searchIsPartial ? (
      <div
        className="px-4 py-2 text-xs text-text-3"
        aria-live="polite"
        role={data.loadMoreError ? "alert" : "status"}
      >
        {selecting
          ? t("sessions:creator.worktreeSource.resolving")
          : data.loadMoreError
            ? data.loadMoreError
            : data.loadingMore
              ? t("status.loading")
              : searchIsPartial
                ? t("selectors.branch.labels.prSearchScope", {
                    count: data.prs.length,
                  })
                : t("selectors.branch.labels.prLimit", {
                    count: BRANCH_PICKER_PR_LIMIT,
                  })}
      </div>
    ) : undefined;

  const branchInfoToggle = (
    <SpotlightFooterToggle
      label={t("selectors.spotlightFooter.showBranchInfo", "Show branch info")}
      checked={showBranchInfo}
      onCheckedChange={setShowBranchInfo}
    />
  );

  if (presentation === "spotlight") {
    return (
      <>
        <PaletteBody
          kernel={kernel}
          items={items}
          inputLeadingSlot={tabs}
          placeholder={placeholder}
          inputAriaLabel={placeholder}
          isLoading={data.loading || selecting}
          fixedHeight
          onLoadMore={loadOnScroll}
          hintSlot={statusNote}
          contentOverride={
            content ? (
              <div className="flex h-[350px] flex-col justify-center">
                {content}
              </div>
            ) : undefined
          }
          afterListSlot={
            <SpotlightPinnedActionSection
              items={pinnedActionItems}
              startIndex={items.length}
              selectedIndex={kernel.selectedIndex}
              onItemSelect={kernel.handleItemClick}
              onItemHover={kernel.setSelectedIndex}
              searchQuery={kernel.searchQuery}
              layout="twoColumn"
            />
          }
        />
        <ShellFooterAction placement="inline">
          {branchInfoToggle}
        </ShellFooterAction>
      </>
    );
  }
  if (!isPositioned) return null;
  const viewportWidth = getViewportSize().width;
  const width = Math.min(
    Math.max(420, panelPosition.width),
    viewportWidth - 24
  );
  const left = Math.max(
    12,
    Math.min(panelPosition.left, viewportWidth - 12 - width)
  );
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={placeholder}
      className={`${DROPDOWN_CLASSES.panel} fixed flex flex-col`}
      style={{
        top: panelPosition.top,
        bottom: panelPosition.bottom,
        left,
        width,
      }}
    >
      <DropdownSearch
        ref={inputRef}
        value={query}
        onChange={(value) => {
          setQuery(value);
          keyboard.setSelectedIndex(-1);
        }}
        placeholder={placeholder}
        ariaLabel={placeholder}
        leading={tabs}
        containerClassName="gap-2"
        disabled={selecting}
      />
      {statusNote}
      {content ? (
        <div
          className={DROPDOWN_CLASSES.optionsContainerOverlay}
          style={{ maxHeight: 360 }}
        >
          {content}
        </div>
      ) : (
        <BranchDropdownList
          items={prs}
          getKey={prRowKey}
          estimateHeight={prRowHeight}
          selectedIndex={keyboard.selectedIndex}
          keyboardNavigated={keyboard.keyboardNavigated}
          searchQuery={query}
          onLoadMore={loadOnScroll}
          renderItem={(pr, index) => {
            const StatusIcon = getBranchPullRequestIcon(pr);
            return (
              <button
                type="button"
                key={pr.number}
                {...keyboard.getItemProps(index)}
                disabled={selecting}
                title={pr.title}
                data-testid={`branch-picker-pr-${pr.number}`}
                className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} h-auto min-h-12 w-full justify-start py-2`}
              >
                <StatusIcon size={DROPDOWN_ITEM.iconSize} />
                <span className="flex min-w-0 flex-1 flex-col items-start">
                  <span className="w-full truncate">{pr.title}</span>
                  <span className="w-full truncate text-xs text-text-3">
                    {describePullRequest(pr, showBranchInfo)}
                  </span>
                </span>
                <BranchPullRequestChecks status={pr.ci_status} />
              </button>
            );
          }}
        />
      )}
      <div className={DROPDOWN_CLASSES.footerContainer}>
        {pinnedActionItems.map((action, index) => (
          <button
            key={action.id}
            type="button"
            {...keyboard.getItemProps(items.length + index)}
            disabled={action.data?.disabled}
            className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full justify-start`}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center">
              <AnyIcon
                icon={action.icon}
                size={DROPDOWN_ITEM.iconSize}
                className="text-text-2"
              />
            </span>
            <span>{action.label}</span>
          </button>
        ))}
      </div>
      <div className="flex justify-end px-3 py-2">{branchInfoToggle}</div>
    </div>,
    document.body
  );
}
