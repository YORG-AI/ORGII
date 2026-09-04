/**
 * Storage Settings Section
 *
 * Displays disk usage breakdown for app data directories.
 * Auto-scans on mount (non-blocking) and allows manual rescan.
 * Per-category: open folder + clear (with confirmation).
 */
import {
  PathCopyOpenRow,
  SECTION_VALUE_SMALL_CLASSES,
  SECTION_VALUE_SMALL_MUTED_CLASSES,
  SECTION_VALUE_SMALL_SECONDARY_CLASSES,
  SectionContainer,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Message from "@src/components/Message";
import { REFRESH_ICON_TOKENS } from "@src/components/RefreshIcon/tokens";
import SettingsTable, {
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import { createLogger } from "@src/hooks/logger";
import {
  Delete02Icon,
  FolderOpenIcon,
  HugeiconsIcon,
  Refresh04Icon,
} from "@src/icons";
import { flushGitHubListCachePersistence } from "@src/services/git/githubListCache";
import {
  monitorScanningAtom,
  storageRefreshTriggerAtom,
} from "@src/store/ui/settingsPanelAtoms";
import {
  type BrowserStorageUsage,
  cleanUpBrowserStorage,
  inspectBrowserStorage,
} from "@src/util/core/storage/quotaRecovery";
import { copyText } from "@src/util/data/clipboard";
import { askNativeDialogSafely } from "@src/util/dialogs/nativeDialog";

const log = createLogger("Storage");

interface StorageCategory {
  key: string;
  label: string;
  path: string;
  size_bytes: number;
  exists: boolean;
  is_folder: boolean;
}

interface DiskUsageReport {
  root_path: string;
  categories: StorageCategory[];
  total_bytes: number;
}

/** Category keys that the backend rejects for clear (e.g. sessionsDb). */
const PROTECTED_CATEGORIES = new Set(["sessionsDb"]);

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
  if (bytes >= 1024) {
    return (bytes / 1024).toFixed(0) + " KB";
  }
  return bytes + " B";
}

const StorageSection: React.FC = () => {
  const { t } = useTranslation("settings");
  const [diskUsage, setDiskUsage] = useState<DiskUsageReport | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [clearingKey, setClearingKey] = useState<string | null>(null);
  const [logsDir, setLogsDir] = useState<string | null>(null);
  const [browserStorageUsage, setBrowserStorageUsage] =
    useState<BrowserStorageUsage>(() => inspectBrowserStorage());
  const [isCleaningBrowserStorage, setIsCleaningBrowserStorage] =
    useState(false);

  const setScanning = useSetAtom(monitorScanningAtom);
  const storageRefreshTrigger = useAtomValue(storageRefreshTriggerAtom);

  const handleDiskScan = useCallback(async () => {
    setIsScanning(true);
    setScanning(true);
    try {
      const report = await invoke<DiskUsageReport>("get_disk_usage");
      setDiskUsage(report);
      setBrowserStorageUsage(inspectBrowserStorage());
      Message.success(
        t("common:refreshToast.successName", { name: t("sections.storage") })
      );
    } catch (error) {
      log.error("[Storage] Failed to fetch disk usage:", error);
      Message.error(t("storage.scanFailed"));
    } finally {
      setIsScanning(false);
      setScanning(false);
    }
  }, [setScanning, t]);

  useEffect(() => {
    if (storageRefreshTrigger > 0) {
      handleDiskScan();
    }
  }, [storageRefreshTrigger, handleDiskScan]);

  const handleOpenStorageDir = useCallback(
    async (path?: string) => {
      try {
        let target = path;
        if (!target) {
          if (diskUsage) {
            target = diskUsage.root_path;
          } else {
            const report = await invoke<DiskUsageReport>("get_disk_usage");
            target = report.root_path;
          }
        }
        if (target) {
          await invoke("open_folder", { path: target });
        }
      } catch (error) {
        log.error("[Storage] Failed to open storage directory:", error);
        Message.error(t("storage.openFolderFailed"));
      }
    },
    [diskUsage, t]
  );

  const handleRevealOrOpen = useCallback(
    async (cat: StorageCategory) => {
      try {
        if (!cat.path) return;
        if (cat.is_folder) {
          await invoke("open_folder", { path: cat.path });
        } else {
          await invoke("show_in_folder", { path: cat.path });
        }
      } catch (error) {
        log.error("[Storage] Failed to reveal/open:", error);
        Message.error(t("storage.openFolderFailed"));
      }
    },
    [t]
  );

  const handleClearCategory = useCallback(
    async (key: string) => {
      setClearingKey(key);
      try {
        await invoke<number>("clear_storage_category", { key });
        const report = await invoke<DiskUsageReport>("get_disk_usage");
        setDiskUsage(report);
        Message.success(t("storage.clearSuccess"));
      } catch (error) {
        log.error("[Storage] Failed to clear category:", error);
        Message.error(t("storage.clearFailed"));
      } finally {
        setClearingKey(null);
      }
    },
    [t]
  );

  const handleClearClick = useCallback(
    async (cat: StorageCategory) => {
      if (cat.size_bytes === 0 || PROTECTED_CATEGORIES.has(cat.key)) return;
      setClearingKey(cat.key);
      try {
        const categoryLabel = t("monitor.diskCategory_" + cat.key);
        const confirmed = await askNativeDialogSafely(
          t("storage.clearConfirmMessage", { category: categoryLabel }),
          {
            title: t("storage.clearConfirmTitle"),
            kind: "warning",
            okLabel: t("common:actions.clear"),
            cancelLabel: t("common:actions.cancel"),
          }
        );
        if (confirmed) {
          await handleClearCategory(cat.key);
        }
      } finally {
        setClearingKey((current) => (current === cat.key ? null : current));
      }
    },
    [t, handleClearCategory]
  );

  const storageRows = useMemo(
    () =>
      diskUsage
        ? diskUsage.categories
            .filter((cat) => cat.exists)
            .sort((catA, catB) => catB.size_bytes - catA.size_bytes)
        : [],
    [diskUsage]
  );

  const storageColumns = useMemo<SettingsTableColumn<StorageCategory>[]>(
    () => [
      {
        key: "category",
        label: t("storage.tableCategory"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (catA, catB) =>
          t("monitor.diskCategory_" + catA.key).localeCompare(
            t("monitor.diskCategory_" + catB.key)
          ),
        renderCell: (cat) => (
          <span className={SECTION_VALUE_SMALL_CLASSES}>
            {t("monitor.diskCategory_" + cat.key)}
          </span>
        ),
      },
      {
        key: "size",
        label: t("storage.tableSize"),
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (catA, catB) => catA.size_bytes - catB.size_bytes,
        renderCell: (cat) => (
          <span
            className={`${SECTION_VALUE_SMALL_SECONDARY_CLASSES} whitespace-nowrap`}
          >
            {formatBytes(cat.size_bytes)}
          </span>
        ),
      },
      {
        key: "percentage",
        label: t("storage.tablePercentage"),
        width: SETTINGS_TABLE_COL.valueMd,
        renderCell: (cat) => {
          const pct =
            diskUsage && diskUsage.total_bytes > 0
              ? ((cat.size_bytes / diskUsage.total_bytes) * 100).toFixed(1)
              : "0";
          return (
            <span
              className={`${SECTION_VALUE_SMALL_MUTED_CLASSES} whitespace-nowrap`}
            >
              {pct}%
            </span>
          );
        },
      },
      {
        key: "actions",
        label: "",
        width: SETTINGS_TABLE_COL.hug,
        align: "right" as const,
        renderCell: (cat) => {
          const isClearing = clearingKey === cat.key;
          const canClear =
            cat.size_bytes > 0 && !PROTECTED_CATEGORIES.has(cat.key);
          return (
            <div className="ml-auto inline-flex items-center gap-2 whitespace-nowrap">
              <Button
                onClick={() => handleRevealOrOpen(cat)}
                icon={
                  <HugeiconsIcon
                    icon={FolderOpenIcon}
                    data-icon="folder-open"
                    size={14}
                  />
                }
                iconOnly
                title={
                  cat.is_folder ? t("storage.openFolder") : t("storage.reveal")
                }
              />
              <Button
                onClick={() => handleClearClick(cat)}
                icon={
                  <HugeiconsIcon
                    icon={Delete02Icon}
                    data-icon="trash-2"
                    size={14}
                    className="text-danger-6"
                  />
                }
                iconOnly
                disabled={!canClear || isClearing}
              />
            </div>
          );
        },
      },
    ],
    [t, diskUsage, clearingKey, handleRevealOrOpen, handleClearClick]
  );

  const handleOpenLogsDir = useCallback(async () => {
    try {
      const dir = logsDir ?? (await invoke<string>("get_logs_directory"));
      if (!logsDir) setLogsDir(dir);
      await invoke("open_folder", { path: dir });
    } catch (error) {
      log.error("[Storage] Failed to open logs directory:", error);
      Message.error(t("storage.openFolderFailed"));
    }
  }, [logsDir, t]);

  const handleCleanBrowserStorage = useCallback(() => {
    setIsCleaningBrowserStorage(true);
    try {
      // Drain the short coalescing window before deleting persisted cache
      // snapshots so an already-scheduled write cannot immediately recreate
      // the entries the user just cleaned.
      flushGitHubListCachePersistence();
      const result = cleanUpBrowserStorage("all-disposable");
      setBrowserStorageUsage(inspectBrowserStorage());
      if (result.freedBytes > 0) {
        Message.success(
          t("storage.browserCacheCleaned", {
            size: formatBytes(result.freedBytes),
          })
        );
      } else {
        Message.info(t("storage.browserCacheAlreadyClean"));
      }
    } catch (error) {
      log.error("[Storage] Failed to clean browser cache:", error);
      Message.error(t("storage.browserCacheCleanFailed"));
    } finally {
      setIsCleaningBrowserStorage(false);
    }
  }, [t]);

  // Auto-scan on mount (non-blocking)
  useEffect(() => {
    let cancelled = false;

    const scan = async () => {
      setIsScanning(true);
      try {
        const [report, dir] = await Promise.all([
          invoke<DiskUsageReport>("get_disk_usage"),
          invoke<string>("get_logs_directory"),
        ]);
        if (!cancelled) {
          setDiskUsage(report);
          setLogsDir(dir);
        }
      } catch (error) {
        if (!cancelled) {
          log.error("[Storage] Auto-scan failed:", error);
          Message.error(t("storage.scanFailed"));
        }
      } finally {
        if (!cancelled) {
          setIsScanning(false);
        }
      }
    };

    void scan();

    return () => {
      cancelled = true;
    };
  }, [t]);

  return (
    <>
      {/* Root path */}
      <SectionContainer>
        <PathCopyOpenRow
          label={t("storage.dataDirectory")}
          description={t("storage.dataDirectoryDesc")}
          path={diskUsage?.root_path ?? "…"}
          onCopy={() => {
            const path = diskUsage?.root_path;
            if (!path) return;
            void copyText(path).then(() => {
              Message.success(t("storage.copiedPath"));
            });
          }}
          onOpen={() => handleOpenStorageDir()}
          disabled={!diskUsage?.root_path}
          copyTitle={t("common:actions.copy")}
          openTitle={t("storage.openFolder")}
        />
      </SectionContainer>

      {/* Log files directory */}
      <SectionContainer>
        <PathCopyOpenRow
          label={t("storage.logFiles")}
          description={t("storage.logFilesDesc")}
          path={logsDir ?? "…"}
          onCopy={() => {
            if (!logsDir) return;
            void copyText(logsDir).then(() => {
              Message.success(t("storage.copiedPath"));
            });
          }}
          onOpen={handleOpenLogsDir}
          disabled={!logsDir}
          copyTitle={t("common:actions.copy")}
          openTitle={t("storage.openFolder")}
        />
      </SectionContainer>

      {/* WebView localStorage — caches only; protected user state is retained. */}
      <SectionContainer>
        <SectionRow
          label={t("storage.browserCache")}
          description={t("storage.browserCacheDesc", {
            used: formatBytes(browserStorageUsage.usedBytes),
            cleanable: formatBytes(browserStorageUsage.cleanableBytes),
          })}
        >
          <Button
            variant="secondary"
            size="default"
            icon={
              <HugeiconsIcon
                icon={Delete02Icon}
                data-icon="trash-2"
                size={14}
              />
            }
            loading={isCleaningBrowserStorage}
            disabled={browserStorageUsage.cleanableBytes === 0}
            onClick={handleCleanBrowserStorage}
            data-testid="clean-browser-storage"
          >
            {t("storage.cleanBrowserCache")}
          </Button>
        </SectionRow>
      </SectionContainer>

      {/* Disk usage breakdown */}
      <SectionContainer>
        <SectionRow
          label={t("monitor.diskUsage")}
          description={
            diskUsage
              ? t("monitor.diskTotal") +
                ": " +
                formatBytes(diskUsage.total_bytes)
              : isScanning
                ? t("monitor.diskScanning")
                : t("monitor.diskUsageDesc")
          }
        />

        <SectionRow label="" indent showHeader={false}>
          {diskUsage ? (
            <SettingsTable<StorageCategory>
              columns={storageColumns}
              rows={storageRows}
              getRowKey={(cat) => cat.key}
              noPx
            />
          ) : isScanning ? (
            <div className="flex items-center gap-2 py-2">
              <HugeiconsIcon
                icon={Refresh04Icon}
                data-icon="refresh-cw"
                size={12}
                className={`${REFRESH_ICON_TOKENS.spin} text-text-3`}
              />
              <span className="text-xs text-text-3">
                {t("monitor.diskScanning")}
              </span>
            </div>
          ) : (
            <div className="py-2 text-xs text-text-3">
              {t("monitor.diskNotScanned")}
            </div>
          )}
        </SectionRow>
      </SectionContainer>
    </>
  );
};

export default StorageSection;
