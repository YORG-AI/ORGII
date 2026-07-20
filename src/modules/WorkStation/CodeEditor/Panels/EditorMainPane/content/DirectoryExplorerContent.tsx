import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { getGitCommits } from "@src/api/http/git";
import FileTypeIcon from "@src/components/FileTypeIcon";
import {
  ComposerStackListRow,
  EventBlockExpandableStackList,
} from "@src/engines/ChatPanel/blocks/primitives";
import { FileHeader } from "@src/modules/WorkStation/shared";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import {
  createDirectoryTab,
  openTab as openTabHelper,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import {
  type DirectoryEntryRow,
  type DirectoryOpenError,
  classifyDirectoryOpenError,
  loadDirectoryEntries,
} from "./directoryExplorerUtils";

const MAX_GIT_META_ENTRIES = 80;

interface DirectoryExplorerContentProps {
  directoryPath: string;
  repoPath: string;
  onFileSelect: (path: string) => void;
}

interface DirectoryEntryGitMeta {
  summary: string;
  authorDate: string;
}

interface DirectoryListItem {
  name: string;
  path: string;
  type: "parent" | "directory" | "file";
  gitMeta?: DirectoryEntryGitMeta;
}

function toRelativePath(path: string, repoPath: string): string {
  if (!repoPath || !path.startsWith(repoPath)) return path;
  return path.slice(repoPath.length).replace(/^\//, "") || ".";
}

function getParentPath(path: string): string | null {
  const normalized = path.replace(/\/+$/, "");
  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex <= 0) return null;
  return normalized.slice(0, separatorIndex);
}

async function loadEntryGitMeta(
  entryPath: string,
  repoPath: string
): Promise<DirectoryEntryGitMeta | undefined> {
  const filePath = toRelativePath(entryPath, repoPath);
  const result = await getGitCommits({
    repo_id: repoPath,
    repo_path: repoPath,
    file_path: filePath,
    limit: 1,
  });
  const commit = result?.commits[0];
  if (!commit) return undefined;
  return {
    summary: commit.summary,
    authorDate: commit.author.date,
  };
}

async function loadEntryGitMetaMap(
  entries: DirectoryEntryRow[],
  repoPath: string
): Promise<Map<string, DirectoryEntryGitMeta>> {
  const pairs = await Promise.all(
    entries.slice(0, MAX_GIT_META_ENTRIES).map(async (entry) => {
      try {
        const meta = await loadEntryGitMeta(entry.path, repoPath);
        return meta ? ([entry.path, meta] as const) : null;
      } catch {
        return null;
      }
    })
  );
  return new Map(
    pairs.filter((pair): pair is [string, DirectoryEntryGitMeta] => !!pair)
  );
}

function openDirectoryTab(directoryPath: string): void {
  const store = getInstrumentedStore();
  const tab = createDirectoryTab(directoryPath);
  store.set(workstationLayoutAtom, (layout) => ({
    ...layout,
    mainPane: openTabHelper(
      layout?.mainPane ?? { tabs: [], activeTabId: null },
      tab
    ),
  }));
}

const DirectoryExplorerContent: React.FC<DirectoryExplorerContentProps> = memo(
  ({ directoryPath, repoPath, onFileSelect }) => {
    const { t } = useTranslation("sessions");
    const [entries, setEntries] = useState<DirectoryEntryRow[]>([]);
    const [gitMetaMap, setGitMetaMap] = useState<
      Map<string, DirectoryEntryGitMeta>
    >(new Map());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<DirectoryOpenError | null>(null);
    const [reloadToken, setReloadToken] = useState(0);

    const relativePath = useMemo(
      () => toRelativePath(directoryPath, repoPath),
      [directoryPath, repoPath]
    );

    const parentPath = useMemo(
      () => getParentPath(directoryPath),
      [directoryPath]
    );
    const canNavigateParent = !!parentPath && parentPath.startsWith(repoPath);

    const listItems = useMemo<DirectoryListItem[]>(() => {
      const parentItem: DirectoryListItem[] =
        canNavigateParent && parentPath
          ? [{ name: "..", path: parentPath, type: "parent" }]
          : [];
      return [
        ...parentItem,
        ...entries.map((entry) => ({
          name: entry.name,
          path: entry.path,
          type: entry.type,
          gitMeta: gitMetaMap.get(entry.path),
        })),
      ];
    }, [canNavigateParent, entries, gitMetaMap, parentPath]);

    useEffect(() => {
      let cancelled = false;
      loadDirectoryEntries(directoryPath)
        .then(async (loadedEntries) => {
          const loadedGitMetaMap = await loadEntryGitMetaMap(
            loadedEntries,
            repoPath
          );
          if (cancelled) return;
          setEntries(loadedEntries);
          setGitMetaMap(loadedGitMetaMap);
          setError(null);
        })
        .catch((loadError: unknown) => {
          if (cancelled) return;
          setError(classifyDirectoryOpenError(loadError));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });

      return () => {
        cancelled = true;
      };
    }, [directoryPath, reloadToken, repoPath]);

    const handleRetry = useCallback(() => {
      setLoading(true);
      setError(null);
      setReloadToken((value) => value + 1);
    }, []);

    const handleOpenItem = useCallback(
      (item: DirectoryListItem) => {
        if (item.type === "parent" || item.type === "directory") {
          openDirectoryTab(item.path);
          return;
        }
        onFileSelect(item.path);
      },
      [onFileSelect]
    );

    const renderDirectoryItem = useCallback(
      (item: DirectoryListItem) => {
        const isDirectory = item.type === "parent" || item.type === "directory";
        const displayName =
          item.type === "parent"
            ? ".."
            : isDirectory
              ? `${item.name}/`
              : item.name;
        const secondary = item.gitMeta?.summary;
        const trailing = item.gitMeta?.authorDate
          ? formatRelativeTime(item.gitMeta.authorDate, "short")
          : undefined;

        return (
          <button
            type="button"
            className="block w-full text-left"
            onClick={() => handleOpenItem(item)}
          >
            <ComposerStackListRow
              title={item.path}
              leading={
                isDirectory ? (
                  <FileTypeIcon
                    fileName={displayName}
                    type="folder"
                    size="small"
                    className="shrink-0"
                  />
                ) : (
                  <FileTypeIcon
                    fileName={item.name}
                    size="small"
                    className="shrink-0"
                  />
                )
              }
              primary={displayName}
              secondary={secondary}
              trailing={trailing}
              layout="columns"
              columnsClassName="grid-cols-[minmax(180px,1fr)_minmax(280px,2fr)_120px]"
            />
          </button>
        );
      },
      [handleOpenItem]
    );

    if (loading) {
      return (
        <>
          <FileHeader
            publishToHost="code"
            filePath={relativePath}
            repoPath={repoPath}
            headerIcon={
              <FileTypeIcon fileName="folder" type="folder" size="small" />
            }
            disableNavigation
            relativePathToCopy={relativePath}
          />
          <Placeholder
            variant="loading"
            placement="detail-panel"
            fillParentHeight
          />
        </>
      );
    }

    if (error) {
      const genericMessages = new Set([
        "failed to open path",
        t("cards.path.openFailed").toLowerCase(),
      ]);
      const errorPresentation = (() => {
        switch (error.kind) {
          case "not_found":
            return {
              title: t("cards.path.directoryNotFound"),
              subtitle: t("cards.path.directoryNotFoundHint"),
            };
          case "not_directory":
            return {
              title: t("cards.path.notDirectory"),
              subtitle: t("cards.path.notDirectoryHint"),
            };
          case "permission":
            return {
              title: t("cards.path.permissionDenied"),
              subtitle: t("cards.path.permissionDeniedHint"),
            };
          default:
            return {
              title: t("cards.path.openFailed"),
              subtitle: genericMessages.has(error.message.toLowerCase())
                ? t("cards.path.openFailedHint")
                : error.message,
            };
        }
      })();

      return (
        <>
          <FileHeader
            publishToHost="code"
            filePath={relativePath}
            repoPath={repoPath}
            headerIcon={
              <FileTypeIcon fileName="folder" type="folder" size="small" />
            }
            disableNavigation
            relativePathToCopy={relativePath}
          />
          <Placeholder
            variant="error"
            placement="detail-panel"
            title={errorPresentation.title}
            subtitle={errorPresentation.subtitle}
            action={
              error.kind === "not_directory"
                ? {
                    label: t("cards.path.openAsFile"),
                    onClick: () => onFileSelect(directoryPath),
                  }
                : undefined
            }
            onRetry={error.kind === "not_directory" ? undefined : handleRetry}
            fillParentHeight
          />
        </>
      );
    }

    return (
      <div className="flex h-full min-h-0 flex-col">
        <FileHeader
          publishToHost="code"
          filePath={relativePath}
          repoPath={repoPath}
          headerIcon={
            <FileTypeIcon fileName="folder" type="folder" size="small" />
          }
          disableNavigation
          relativePathToCopy={relativePath}
        />

        {listItems.length === 0 ? (
          <Placeholder
            variant="empty"
            placement="detail-panel"
            title={t("cards.path.emptyDirectory")}
            fillParentHeight
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto pt-1">
            <EventBlockExpandableStackList
              layout="body"
              items={listItems}
              renderItem={renderDirectoryItem}
              getKey={(item) => `${item.type}:${item.path}`}
              visibleCount={listItems.length}
            />
          </div>
        )}
      </div>
    );
  }
);

DirectoryExplorerContent.displayName = "DirectoryExplorerContent";

export default DirectoryExplorerContent;
