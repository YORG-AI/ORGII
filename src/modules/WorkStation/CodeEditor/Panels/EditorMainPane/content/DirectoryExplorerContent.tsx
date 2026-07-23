import { readDir } from "@tauri-apps/plugin-fs";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";

import { getGitCommits } from "@src/api/http/git";
import FileTypeIcon from "@src/components/FileTypeIcon";
import { ComposerStackListRow } from "@src/engines/ChatPanel/blocks/primitives";
import { FileHeader } from "@src/modules/WorkStation/shared";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import {
  createDirectoryTab,
  openTab as openTabHelper,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { toFsPluginPath } from "@src/util/file/pathUtils";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

const MAX_GIT_META_ENTRIES = 80;
const DIRECTORY_ROW_HEIGHT = 34;

interface DirectoryExplorerContentProps {
  directoryPath: string;
  repoPath: string;
  onFileSelect: (path: string) => void;
}

interface DirectoryEntryRow {
  name: string;
  path: string;
  type: "directory" | "file";
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

async function loadDirectoryEntries(
  directoryPath: string
): Promise<DirectoryEntryRow[]> {
  // On Windows the repo path arrives canonicalized as `\\?\C:\…`, which the
  // Tauri fs plugin can't read (readDir returns nothing → "top level but no
  // children"). Strip the verbatim prefix before reading, and build child
  // paths from the cleaned dir so they're usable too.
  const dir = toFsPluginPath(directoryPath).replace(/\/+$/, "");
  const entries = await readDir(dir);
  return entries
    .map((entry) => ({
      name: entry.name,
      path: `${dir}/${entry.name}`,
      type: entry.isDirectory ? ("directory" as const) : ("file" as const),
    }))
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
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
    const [error, setError] = useState<string | null>(null);
    const loadGenerationRef = useRef(0);

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
      const generation = ++loadGenerationRef.current;
      setEntries([]);
      setGitMetaMap(new Map());
      setLoading(true);
      setError(null);

      void (async () => {
        try {
          const loadedEntries = await loadDirectoryEntries(directoryPath);
          if (generation !== loadGenerationRef.current) return;

          const loadedGitMetaMap = await loadEntryGitMetaMap(
            loadedEntries,
            repoPath
          );
          if (generation !== loadGenerationRef.current) return;

          setEntries(loadedEntries);
          setGitMetaMap(loadedGitMetaMap);
          setError(null);
        } catch (loadError: unknown) {
          if (generation !== loadGenerationRef.current) return;
          const message =
            loadError instanceof Error
              ? loadError.message
              : t("cards.path.openFailed");
          setError(message);
        } finally {
          if (generation === loadGenerationRef.current) setLoading(false);
        }
      })();

      return () => {
        if (generation === loadGenerationRef.current) {
          loadGenerationRef.current += 1;
        }
      };
    }, [directoryPath, repoPath, t]);

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
            title={t("cards.path.openFailed")}
            subtitle={error}
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
          <Virtuoso
            className="min-h-0 flex-1 pt-1 scrollbar-hide"
            data={listItems}
            computeItemKey={(_index, item) => `${item.type}:${item.path}`}
            fixedItemHeight={DIRECTORY_ROW_HEIGHT}
            overscan={DIRECTORY_ROW_HEIGHT * 8}
            itemContent={(_index, item) => (
              <div className="px-1 pb-0.5">{renderDirectoryItem(item)}</div>
            )}
          />
        )}
      </div>
    );
  }
);

DirectoryExplorerContent.displayName = "DirectoryExplorerContent";

export default DirectoryExplorerContent;
