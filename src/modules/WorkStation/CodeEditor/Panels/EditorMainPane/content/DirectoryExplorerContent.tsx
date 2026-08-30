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

import FileTypeIcon from "@src/components/FileTypeIcon";
import { Placeholder } from "@src/components/Placeholder";
import { ComposerStackListRow } from "@src/engines/ChatPanel/blocks/primitives";
import { FileHeader } from "@src/modules/WorkStation/shared";
import {
  type DirectoryEntryGitMeta,
  type DirectoryEntryRow,
  type DirectoryViewRequest,
  getCachedDirectoryEntries,
  getCachedDirectoryMetadata,
  loadDirectoryEntries,
  loadDirectoryMetadata,
} from "@src/services/git/directoryViewResource";
import {
  createDirectoryTab,
  openTab as openTabHelper,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

const DIRECTORY_ROW_HEIGHT = 34;

interface DirectoryExplorerContentProps {
  directoryPath: string;
  repoPath: string;
  onFileSelect: (path: string) => void;
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
    const request = useMemo<DirectoryViewRequest>(
      () => ({ directoryPath, repoPath }),
      [directoryPath, repoPath]
    );
    const initialEntries = useMemo(
      () => getCachedDirectoryEntries(request),
      [request]
    );
    const initialMetadata = useMemo(
      () =>
        initialEntries
          ? getCachedDirectoryMetadata(request, initialEntries)
          : null,
      [initialEntries, request]
    );
    const [entries, setEntries] = useState<DirectoryEntryRow[]>(
      () => initialEntries ?? []
    );
    const [gitMetaMap, setGitMetaMap] = useState<
      Map<string, DirectoryEntryGitMeta>
    >(() => initialMetadata ?? new Map());
    const [hasLoadedEntries, setHasLoadedEntries] = useState(
      () => initialEntries !== null
    );
    const [loading, setLoading] = useState(() => initialEntries === null);
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
      const cachedEntries = getCachedDirectoryEntries(request);
      const cachedMetadata = cachedEntries
        ? getCachedDirectoryMetadata(request, cachedEntries)
        : null;

      setEntries(cachedEntries ?? []);
      setGitMetaMap(cachedMetadata ?? new Map());
      setHasLoadedEntries(cachedEntries !== null);
      setLoading(cachedEntries === null);
      setError(null);

      void (async () => {
        try {
          const loadedEntries = await loadDirectoryEntries(request);
          if (generation !== loadGenerationRef.current) return;

          setEntries(loadedEntries);
          setHasLoadedEntries(true);
          setLoading(false);
          setError(null);

          const cachedLoadedMetadata = getCachedDirectoryMetadata(
            request,
            loadedEntries
          );
          if (cachedLoadedMetadata) {
            setGitMetaMap(cachedLoadedMetadata);
          } else if (cachedEntries !== loadedEntries) {
            setGitMetaMap(new Map());
          }

          const loadedGitMetaMap = await loadDirectoryMetadata(
            request,
            loadedEntries
          );
          if (generation !== loadGenerationRef.current) return;
          setGitMetaMap(loadedGitMetaMap);
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
    }, [request, t]);

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

    if (loading && !hasLoadedEntries) {
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

    if (error && !hasLoadedEntries) {
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
