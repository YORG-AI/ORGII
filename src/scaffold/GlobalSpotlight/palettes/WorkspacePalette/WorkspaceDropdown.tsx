/**
 * WorkspaceDropdown
 *
 * Anchored, compact variant of `WorkspacePalette` for the core switch path
 * (pick a repo / workspace). Add-source / Manage / multi-root flows are
 * intentionally absent — those remain in the Spotlight variant because
 * they include nested modal stages that don't fit a 320px anchored panel.
 *
 * Chosen by `general.modelPickerStyle === "dropdown"`. Falls through to
 * `WorkspacePalette` (Spotlight) otherwise.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { Check, Search } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { repoApi } from "@src/api/tauri/repo";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import {
  isSystemHomeRepoItem,
  isSystemPathRepoItem,
} from "@src/features/SessionCreator/utils/systemPathSource";
import { workspaceMatchesRepoFilter } from "@src/features/TeamCollaboration/orgScopeRepoFilter";
import {
  type UseDropdownListNavigationReturn,
  useDropdownEngine,
} from "@src/hooks/dropdown";
import { useTauriSelectAllShortcut } from "@src/hooks/keyboard";
import { REPO_KIND, cachedReposAtom } from "@src/store/repo";
import {
  isMultiRootWorkspaceAtom,
  setWorkspaceFoldersAtom,
} from "@src/store/ui/workspaceFoldersAtom";
import { getViewportSize } from "@src/util/ui/window/viewport";

import { ICONS } from "../../config";
import {
  EXTERNAL_RECENT_PATH_WORKSPACE_THRESHOLD,
  type WorkspaceSwitchEntry,
  useExternalRecentPaths,
  useSharedRepoList,
  useWorkspaceSwitch,
} from "../../hooks";
import { useWorkspaceForm } from "../../hooks/forms";
import type { RepoItem, SpotlightItem } from "../../types";
import { buildOpenPathItem } from "./pathActionItem";
import { importWorkspacePath } from "./pathImport";

const LIST_MAX_HEIGHT = 360;
const VIEWPORT_MARGIN = 12;
const MIN_DROPDOWN_WIDTH = 320;

type DropdownRepoItem =
  | { kind: "repo"; repo: RepoItem }
  | { kind: "workspace"; entry: WorkspaceSwitchEntry }
  | { kind: "openPath"; item: SpotlightItem };
type DropdownRepoRowItem = Extract<DropdownRepoItem, { kind: "repo" }>;
type DropdownWorkspaceRowItem = Extract<
  DropdownRepoItem,
  { kind: "workspace" }
>;

type WorkspaceDropdownSectionKey =
  | "openPath"
  | "current"
  | "recent"
  | "multiRepoWorkspace"
  | "system"
  | "externalRecent"
  | "workspace"
  | "repo"
  | "thisOrg"
  | "outsideOrg";

interface WorkspaceDropdownSection {
  key: WorkspaceDropdownSectionKey;
  label: string | null;
  items: DropdownRepoItem[];
}

interface RepoRowProps {
  repo: RepoItem;
  isCurrent: boolean;
  keyboardProps: ReturnType<UseDropdownListNavigationReturn["getItemProps"]>;
}

interface OpenPathRowProps {
  item: SpotlightItem;
  keyboardProps: ReturnType<UseDropdownListNavigationReturn["getItemProps"]>;
}

interface WorkspaceRowProps {
  entry: WorkspaceSwitchEntry;
  keyboardProps: ReturnType<UseDropdownListNavigationReturn["getItemProps"]>;
}

const RepoRow: React.FC<RepoRowProps> = ({
  repo,
  isCurrent,
  keyboardProps,
}) => {
  const isSystemPath = isSystemPathRepoItem(repo);
  const Icon = isSystemHomeRepoItem(repo)
    ? ICONS.home
    : isSystemPath
      ? ICONS.folder
      : ICONS.repo;
  const shouldShowDescription = Boolean(repo.description && !isSystemPath);

  return (
    <button
      type="button"
      data-testid={`repo-dropdown-row-${repo.id}`}
      {...keyboardProps}
      className={`${DROPDOWN_CLASSES.item} ${
        isCurrent ? DROPDOWN_CLASSES.itemSelected : DROPDOWN_CLASSES.itemHover
      } w-full justify-start`}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        {isCurrent ? (
          <Check size={DROPDOWN_ITEM.iconSize} className="text-primary-6" />
        ) : (
          <Icon size={DROPDOWN_ITEM.iconSize} />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start">
        <span className="truncate">{repo.name}</span>
        {shouldShowDescription && (
          <span className="truncate text-[11px] text-text-3">
            {repo.description}
          </span>
        )}
      </div>
    </button>
  );
};

const WorkspaceRow: React.FC<WorkspaceRowProps> = ({
  entry,
  keyboardProps,
}) => {
  const { workspace, isActive } = entry;

  return (
    <button
      type="button"
      data-testid={`repo-dropdown-workspace-row-${workspace.workspaceId}`}
      {...keyboardProps}
      className={`${DROPDOWN_CLASSES.item} ${
        isActive ? DROPDOWN_CLASSES.itemSelected : DROPDOWN_CLASSES.itemHover
      } w-full justify-start`}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        {isActive ? (
          <Check size={DROPDOWN_ITEM.iconSize} className="text-primary-6" />
        ) : (
          <ICONS.workspace size={DROPDOWN_ITEM.iconSize} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-left">
        {workspace.name}
      </span>
    </button>
  );
};

const OpenPathRow: React.FC<OpenPathRowProps> = ({ item, keyboardProps }) => {
  const Icon = typeof item.icon === "string" ? ICONS.folder : item.icon;

  return (
    <button
      type="button"
      data-testid="repo-dropdown-open-path-row"
      {...keyboardProps}
      className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full justify-start`}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        {Icon && <Icon size={DROPDOWN_ITEM.iconSize} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start">
        <span className="truncate">{item.label}</span>
        {item.desc && (
          <span className="truncate text-[11px] text-text-3">{item.desc}</span>
        )}
      </div>
    </button>
  );
};

export interface WorkspaceDropdownProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (repoId: string, repo: RepoItem) => void;
  currentRepoId?: string;
  /** Element the dropdown is anchored to. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Preferred vertical side of the anchor. */
  placement?: "top" | "bottom" | "auto";
  /** Optional first-class system path source rows. */
  leadingRepos?: readonly RepoItem[];
  /** Row eligibility predicate (e.g. active cloud org repo scope). */
  repoFilter?: (repo: {
    repo_url?: string | null;
    fs_uri?: string | null;
  }) => boolean;
}

export const WorkspaceDropdown: React.FC<WorkspaceDropdownProps> = ({
  isOpen,
  onClose,
  onSelect,
  currentRepoId,
  anchorRef,
  placement = "bottom",
  leadingRepos = [],
  repoFilter,
}) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const tauriSelectAll = useTauriSelectAllShortcut();

  const [searchQuery, setSearchQuery] = useState("");
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (!isOpen && searchQuery) setSearchQuery("");
  }

  const workspaceForm = useWorkspaceForm({
    onSuccess: async (workspaceId?: string) => {
      if (!workspaceId) return;
      const result = await repoApi.getRepoById(workspaceId);
      const repo = result.data;
      onSelect(repo.repo_id, {
        id: repo.repo_id,
        name: repo.name,
        fs_uri: repo.path,
        kind: repo.kind,
      });
      onClose();
    },
  });

  const { repos, filteredRepos, repoLoading, refreshReposForce } =
    useSharedRepoList({
      enabled: isOpen,
      currentRepoId,
      searchQuery,
    });
  const cachedRepos = useAtomValue(cachedReposAtom);

  const existingRepoPaths = useMemo(
    () => repos.map((repo) => repo.fs_uri ?? "").filter(Boolean),
    [repos]
  );

  const { recentPathRepos: externalRecentRepos } = useExternalRecentPaths({
    enabled: isOpen && repos.length <= EXTERNAL_RECENT_PATH_WORKSPACE_THRESHOLD,
    existingRepoPaths,
    searchQuery,
  });

  const isMultiRoot = useAtomValue(isMultiRootWorkspaceAtom);
  const dispatchSetFolders = useSetAtom(setWorkspaceFoldersAtom);

  const { workspaces, activateWorkspace } = useWorkspaceSwitch({
    repos,
    onActivate: onClose,
  });

  // Org scope never hides rows — non-matching ones group under "Outside
  // this org". System-path rows bypass the predicate; running repoFilter on
  // them would prime git-remote resolution against the user's home directory.
  const outsideOrgRepoIds = useMemo(() => {
    if (!repoFilter) return null;
    const ids = new Set<string>();
    for (const repo of [...leadingRepos, ...repos]) {
      if (!isSystemPathRepoItem(repo) && !repoFilter(repo)) ids.add(repo.id);
    }
    return ids;
  }, [leadingRepos, repos, repoFilter]);

  const outsideOrgWorkspaceIds = useMemo(() => {
    if (!repoFilter) return null;
    const ids = new Set<string>();
    for (const entry of workspaces) {
      if (
        !workspaceMatchesRepoFilter(
          entry.workspace.folders.map((folder) => folder.folderPath),
          repoFilter
        )
      ) {
        ids.add(entry.workspace.workspaceId);
      }
    }
    return ids;
  }, [workspaces, repoFilter]);

  // Filter multi-repo workspaces by the same query as repos. Match against
  // workspace name and member folder names so users can find a workspace by
  // any of its repos.
  const filteredWorkspaces = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return workspaces;
    return workspaces.filter((entry) => {
      if (entry.workspace.name.toLowerCase().includes(query)) return true;
      return entry.folderNames.some((name) =>
        name.toLowerCase().includes(query)
      );
    });
  }, [workspaces, searchQuery]);
  const invalidPathTitle = t("selectors.repo.pathImport.invalidTitle");
  const invalidPathMessage = useCallback(
    (path: string) => t("selectors.repo.pathImport.invalidMessage", { path }),
    [t]
  );

  const openPathItem = useMemo(
    () =>
      buildOpenPathItem({
        searchQuery,
        addLabel: t("selectors.repo.pathImport.addLabel"),
        onOpenPath: (candidatePath) => {
          void importWorkspacePath({
            candidatePath,
            invalidPathTitle,
            invalidPathMessage,
            onImportWorkspace: workspaceForm.handleImportWorkspace,
          });
        },
      }),
    [
      workspaceForm.handleImportWorkspace,
      invalidPathMessage,
      invalidPathTitle,
      searchQuery,
      t,
    ]
  );

  const sections = useMemo<WorkspaceDropdownSection[]>(() => {
    const allRepos = [...leadingRepos, ...filteredRepos];
    const currentItems: DropdownRepoRowItem[] = [];
    const systemItems: DropdownRepoRowItem[] = [];
    const externalRecentItems: DropdownRepoRowItem[] = externalRecentRepos.map(
      (repo) => ({ kind: "repo", repo })
    );
    const folderWorkspaceItems: DropdownRepoRowItem[] = [];
    const repoItems: DropdownRepoRowItem[] = [];

    for (const repo of allRepos) {
      const item: DropdownRepoRowItem = { kind: "repo", repo };
      if (repo.id === currentRepoId) {
        currentItems.push(item);
      } else if (isSystemPathRepoItem(repo)) {
        systemItems.push(item);
      } else if (repo.kind === REPO_KIND.FOLDER) {
        folderWorkspaceItems.push(item);
      } else {
        repoItems.push(item);
      }
    }

    const recentRepoRanks = new Map(
      cachedRepos.map((repo, index) => [repo.id, index])
    );
    // With an org scope active, Recent is scoped to the org too — out-of-org
    // rows appear only under "Outside this org", never in Recent.
    const recentRepoItems = [
      ...repoItems,
      ...folderWorkspaceItems,
      ...systemItems,
    ]
      .filter(
        (item) =>
          recentRepoRanks.has(item.repo.id) &&
          !outsideOrgRepoIds?.has(item.repo.id)
      )
      .sort(
        (itemA, itemB) =>
          (recentRepoRanks.get(itemA.repo.id) ?? Number.MAX_SAFE_INTEGER) -
          (recentRepoRanks.get(itemB.repo.id) ?? Number.MAX_SAFE_INTEGER)
      );

    // Active multi-repo workspace is the "current" selection; sits with the
    // current repo. Inactive workspaces get their own section above repos so
    // they are easy to spot.
    const activeWorkspaceItems: DropdownWorkspaceRowItem[] = [];
    const inactiveWorkspaceItems: DropdownWorkspaceRowItem[] = [];
    for (const entry of filteredWorkspaces) {
      const item: DropdownWorkspaceRowItem = { kind: "workspace", entry };
      if (entry.isActive) {
        activeWorkspaceItems.push(item);
      } else {
        inactiveWorkspaceItems.push(item);
      }
    }

    inactiveWorkspaceItems.sort((itemA, itemB) =>
      itemB.entry.workspace.updatedAt.localeCompare(
        itemA.entry.workspace.updatedAt
      )
    );
    const recentItems = [
      ...recentRepoItems,
      ...inactiveWorkspaceItems.filter(
        (item) => !outsideOrgWorkspaceIds?.has(item.entry.workspace.workspaceId)
      ),
    ].slice(0, 3);
    const recentRepoIds = new Set(
      recentItems
        .filter((item): item is DropdownRepoRowItem => item.kind === "repo")
        .map((item) => item.repo.id)
    );
    const recentWorkspaceIds = new Set(
      recentItems
        .filter(
          (item): item is DropdownWorkspaceRowItem => item.kind === "workspace"
        )
        .map((item) => item.entry.workspace.workspaceId)
    );

    const nextSections: WorkspaceDropdownSection[] = [];
    if (searchQuery.trim() && openPathItem) {
      nextSections.push({
        key: "openPath",
        label: null,
        items: [{ kind: "openPath", item: openPathItem }],
      });
    }
    if (activeWorkspaceItems.length > 0 || currentItems.length > 0) {
      nextSections.push({
        key: "current",
        label: t("selectors.repo.sections.current"),
        items: [...activeWorkspaceItems, ...currentItems],
      });
    }
    const nonCurrentRecentItems = recentItems.filter((item) => {
      if (item.kind === "repo") return item.repo.id !== currentRepoId;
      return !item.entry.isActive;
    });
    if (nonCurrentRecentItems.length > 0) {
      nextSections.push({
        key: "recent",
        label: t("selectors.repo.sections.recent", "Recent"),
        items: nonCurrentRecentItems,
      });
    }
    const regularRepoItems = repoItems.filter(
      (item) => !recentRepoIds.has(item.repo.id)
    );
    const regularInactiveWorkspaceItems = inactiveWorkspaceItems.filter(
      (item) => !recentWorkspaceIds.has(item.entry.workspace.workspaceId)
    );
    const regularFolderWorkspaceItems = folderWorkspaceItems.filter(
      (item) => !recentRepoIds.has(item.repo.id)
    );
    if (outsideOrgRepoIds) {
      const isOutsideOrgItem = (item: DropdownRepoItem) =>
        item.kind === "repo"
          ? outsideOrgRepoIds.has(item.repo.id)
          : item.kind === "workspace"
            ? !!outsideOrgWorkspaceIds?.has(item.entry.workspace.workspaceId)
            : false;
      const orgOrdered: DropdownRepoItem[] = [
        ...regularRepoItems,
        ...regularInactiveWorkspaceItems,
        ...regularFolderWorkspaceItems,
      ];
      const thisOrgItems = orgOrdered.filter((item) => !isOutsideOrgItem(item));
      const outsideOrgItems = orgOrdered.filter(isOutsideOrgItem);
      if (thisOrgItems.length > 0) {
        nextSections.push({
          key: "thisOrg",
          label: t("selectors.repo.sections.thisOrg", "This org"),
          items: thisOrgItems,
        });
      }
      if (outsideOrgItems.length > 0) {
        nextSections.push({
          key: "outsideOrg",
          label: t("selectors.repo.sections.outsideOrg", "Outside this org"),
          items: outsideOrgItems,
        });
      }
    } else {
      if (regularRepoItems.length > 0) {
        nextSections.push({
          key: "repo",
          label: t("selectors.repo.sections.repo"),
          items: regularRepoItems,
        });
      }
      if (regularInactiveWorkspaceItems.length > 0) {
        nextSections.push({
          key: "multiRepoWorkspace",
          label: t("workspaceForm.multiRepoWorkspace", "Multi-Repo Workspace"),
          items: regularInactiveWorkspaceItems,
        });
      }
      if (regularFolderWorkspaceItems.length > 0) {
        nextSections.push({
          key: "workspace",
          label: t("selectors.repo.sections.workspace"),
          items: regularFolderWorkspaceItems,
        });
      }
    }
    const regularSystemItems = systemItems.filter(
      (item) => !recentRepoIds.has(item.repo.id)
    );
    if (regularSystemItems.length > 0) {
      nextSections.push({
        key: "system",
        label: t("selectors.repo.sections.systemPaths"),
        items: regularSystemItems,
      });
    }
    if (externalRecentItems.length > 0) {
      nextSections.push({
        key: "externalRecent",
        label: t("selectors.repo.sections.usedElsewhere"),
        items: externalRecentItems,
      });
    }
    return nextSections;
  }, [
    filteredRepos,
    filteredWorkspaces,
    cachedRepos,
    currentRepoId,
    externalRecentRepos,
    outsideOrgRepoIds,
    outsideOrgWorkspaceIds,
    leadingRepos,
    openPathItem,
    searchQuery,
    t,
  ]);

  const dropdownItems = useMemo(
    () => sections.flatMap((section) => section.items),
    [sections]
  );

  const handleSelect = useCallback(
    (item: DropdownRepoItem) => {
      if (item.kind === "openPath") {
        item.item.action?.();
        return;
      }

      if (item.kind === "workspace") {
        activateWorkspace(item.entry.workspace);
        return;
      }

      if (isMultiRoot) {
        dispatchSetFolders([], null);
      }
      if (item.repo.id.startsWith("external-recent:")) {
        const path = item.repo.fs_uri;
        if (!path) return;
        void workspaceForm.handleImportWorkspace(path).then(() => {
          void refreshReposForce();
        });
        return;
      }
      onSelect(item.repo.id, item.repo);
      onClose();
    },
    [
      isMultiRoot,
      dispatchSetFolders,
      onSelect,
      onClose,
      activateWorkspace,
      workspaceForm,
      refreshReposForce,
    ]
  );

  const { isPositioned, panelRef, panelPosition, keyboard } = useDropdownEngine<
    HTMLElement,
    DropdownRepoItem
  >({
    open: isOpen,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
    anchorRef,
    placement,
    gap: DROPDOWN_PANEL.triggerGap,
    listNavigation: {
      items: dropdownItems,
      onSelect: handleSelect,
      initialSelectedIndex: -1,
    },
  });

  useEffect(() => {
    if (!isOpen || !isPositioned) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, isPositioned]);

  if (!isOpen || !isPositioned) return null;

  const width = Math.max(MIN_DROPDOWN_WIDTH, panelPosition.width);
  const { width: vw } = getViewportSize();
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(panelPosition.left, vw - VIEWPORT_MARGIN - width)
  );

  return createPortal(
    <div
      ref={panelRef}
      className={`${DROPDOWN_CLASSES.panel} fixed flex flex-col`}
      style={{
        top: panelPosition.top,
        bottom: panelPosition.bottom,
        left,
        width,
      }}
    >
      <div className={DROPDOWN_CLASSES.searchContainer}>
        <Search
          size={DROPDOWN_ITEM.iconSize}
          className="shrink-0 text-text-3"
        />
        <input
          ref={inputRef}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={tauriSelectAll}
          placeholder={t("selectors.spotlight.placeholders.workspace")}
          className={DROPDOWN_CLASSES.searchInput}
        />
      </div>

      <div
        className={DROPDOWN_CLASSES.optionsContainerOverlay}
        style={{ maxHeight: LIST_MAX_HEIGHT }}
      >
        {repoLoading && dropdownItems.length === 0 ? (
          <div className={DROPDOWN_CLASSES.listMessage}>
            {t("status.loading")}
          </div>
        ) : dropdownItems.length === 0 ? (
          <div className={DROPDOWN_CLASSES.listMessage}>
            {t("selectors.modelSelector.noResults")}
          </div>
        ) : (
          sections.map((section) => (
            <React.Fragment key={section.key}>
              {section.label && (
                <div className={DROPDOWN_CLASSES.sectionLabel}>
                  {section.label}
                </div>
              )}
              {section.items.map((item) => {
                const index = dropdownItems.indexOf(item);
                if (item.kind === "openPath") {
                  return (
                    <OpenPathRow
                      key={item.item.id}
                      item={item.item}
                      keyboardProps={keyboard.getItemProps(index)}
                    />
                  );
                }
                if (item.kind === "workspace") {
                  return (
                    <WorkspaceRow
                      key={`workspace-${item.entry.workspace.workspaceId}`}
                      entry={item.entry}
                      keyboardProps={keyboard.getItemProps(index)}
                    />
                  );
                }
                return (
                  <RepoRow
                    key={item.repo.id}
                    repo={item.repo}
                    isCurrent={item.repo.id === currentRepoId}
                    keyboardProps={keyboard.getItemProps(index)}
                  />
                );
              })}
            </React.Fragment>
          ))
        )}
      </div>
    </div>,
    document.body
  );
};

WorkspaceDropdown.displayName = "WorkspaceDropdown";
