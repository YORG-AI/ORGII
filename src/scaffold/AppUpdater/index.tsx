import { getVersion } from "@tauri-apps/api/app";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { atom, useAtom, useAtomValue } from "jotai";
import React, { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";

import AppMark from "@src/components/AppMark";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import { createLogger } from "@src/hooks/logger";
import Modal from "@src/scaffold/ModalSystem";
import { settingsLoadedAtom } from "@src/store/settings/settingsAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  AppUpdateDownloadNoticeContent,
  type AppUpdateDownloadProgress,
  DownloadProgressOrb,
  EMPTY_APP_UPDATE_DOWNLOAD_PROGRESS,
  getDownloadProgressTitle,
} from "./DownloadProgress";
import {
  AppUpdaterCoordinator,
  type AppUpdaterState,
  createInitialAppUpdaterState,
} from "./appUpdaterCoordinator";
import {
  AppUpdaterScheduler,
  type AutomaticUpdateReason,
} from "./appUpdaterScheduler";
import { checkAppUpdateOnChannel } from "./channelCheck";

const log = createLogger("AppUpdater");

const STARTUP_CHECK_DELAY_MS = 10_000;
const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 60_000;
const FOREGROUND_CHECK_MIN_INTERVAL_MS = 5 * 60_000;
const FOREGROUND_EVENT_DEBOUNCE_MS = 750;
const DOWNLOAD_PROGRESS_UPDATE_MIN_INTERVAL_MS = 250;
const UPDATE_TOAST_DURATION_MS = 5_000;
const UPDATE_CHECK_TIMEOUT_MS = 30_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const UPDATE_RETRY_BASE_DELAY_MS = 60_000;
const UPDATE_RETRY_MAX_DELAY_MS = 60 * 60_000;
const UPDATE_RETRY_JITTER_RATIO = 0.2;

const CHECK_TOAST_ID = "app-update-check";
const INSTALL_TOAST_ID = "app-update-progress";
const SKIPPED_UPDATE_VERSION_STORAGE_KEY =
  "orgii:updater:skipped-update-version";

export interface CheckForAppUpdatesOptions {
  notify?: boolean;
  force?: boolean;
}

const appUpdaterStateAtom = atom<AppUpdaterState>(
  createInitialAppUpdaterState()
);
const availableAppUpdateAtom = atom((get) => get(appUpdaterStateAtom).update);
const appUpdateInstallPromptAtom = atom(false);
const appUpdateDownloadProgressAtom = atom<AppUpdateDownloadProgress>(
  EMPTY_APP_UPDATE_DOWNLOAD_PROGRESS
);
const isAppUpdateInstallingAtom = atom((get) => {
  const phase = get(appUpdaterStateAtom).phase;
  return (
    phase === "downloading" || phase === "installing" || phase === "relaunching"
  );
});

function store() {
  return getInstrumentedStore();
}

function setDownloadProgress(progress: AppUpdateDownloadProgress): void {
  store().set(appUpdateDownloadProgressAtom, progress);
}

function collapseDownloadProgressNotice(): void {
  const progress = store().get(appUpdateDownloadProgressAtom);
  if (!progress.active || progress.collapsed) return;
  setDownloadProgress({ ...progress, collapsed: true });
}

function showDownloadProgressNotice(progress: AppUpdateDownloadProgress): void {
  Message.info({
    id: INSTALL_TOAST_ID,
    title: getDownloadProgressTitle(progress),
    content: <AppUpdateDownloadNoticeContent progress={progress} />,
    duration: 0,
    closable: true,
    persistent: true,
    onClose: collapseDownloadProgressNotice,
  });
}

function beginDownloadProgress(): void {
  const progress = {
    ...EMPTY_APP_UPDATE_DOWNLOAD_PROGRESS,
    active: true,
  };
  setDownloadProgress(progress);
  showDownloadProgressNotice(progress);
}

function expandDownloadProgressNotice(): void {
  const progress = store().get(appUpdateDownloadProgressAtom);
  if (!progress.active) return;
  const expanded = { ...progress, collapsed: false };
  setDownloadProgress(expanded);
  showDownloadProgressNotice(expanded);
}

function endDownloadProgress(): void {
  Message.remove(INSTALL_TOAST_ID);
  setDownloadProgress(EMPTY_APP_UPDATE_DOWNLOAD_PROGRESS);
}

function getSkippedUpdateVersion(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(SKIPPED_UPDATE_VERSION_STORAGE_KEY);
}

function setSkippedUpdateVersion(version: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SKIPPED_UPDATE_VERSION_STORAGE_KEY, version);
}

function clearSkippedUpdateVersion(version: string): void {
  if (typeof window !== "undefined" && getSkippedUpdateVersion() === version) {
    window.localStorage.removeItem(SKIPPED_UPDATE_VERSION_STORAGE_KEY);
  }
}

function createCoordinator(): AppUpdaterCoordinator {
  return new AppUpdaterCoordinator({
    check: () => checkAppUpdateOnChannel(UPDATE_CHECK_TIMEOUT_MS),
    downloadTimeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
    getVersion,
    minCheckIntervalMs: FOREGROUND_CHECK_MIN_INTERVAL_MS,
    onStateChange: (state) => store().set(appUpdaterStateAtom, state),
  });
}

const coordinator = createCoordinator();
let activeAutomaticScheduler: AppUpdaterScheduler | null = null;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}

function getDownloadErrorMessage(error: unknown): string {
  const message = getErrorMessage(error);
  if (/timed?\s*out|timeout/i.test(message)) {
    return "The download timed out. Check your network or proxy, then retry.";
  }
  return message;
}

function notifyCheckSuccess(
  update: Update | null,
  currentVersion: string | undefined,
  notify: boolean
): void {
  if (!notify) return;

  if (update) {
    Message.info({
      id: CHECK_TOAST_ID,
      title: "Update available",
      content: `Version ${update.version} is ready to install.`,
      duration: UPDATE_TOAST_DURATION_MS,
    });
    return;
  }

  Message.success({
    id: CHECK_TOAST_ID,
    content: currentVersion
      ? `ORGII is up to date (v${currentVersion}).`
      : "ORGII is up to date.",
    duration: UPDATE_TOAST_DURATION_MS,
  });
}

function notifyCheckFailure(error: unknown, notify: boolean): void {
  const message = getErrorMessage(error);
  log.warn("Update check failed", message);

  if (!notify) return;
  Message.error({
    id: CHECK_TOAST_ID,
    title: "Update check failed",
    content: message,
    duration: UPDATE_TOAST_DURATION_MS,
  });
}

export async function checkForAppUpdates(
  options: CheckForAppUpdatesOptions = {}
): Promise<Update | null> {
  const { notify = false, force = false } = options;

  if (notify) {
    Message.info({
      id: CHECK_TOAST_ID,
      content: "Checking for updates…",
      duration: 0,
    });
  }

  try {
    const result = await coordinator.checkForUpdate(force);
    notifyCheckSuccess(result.update, result.currentVersion, notify);
    return result.update;
  } catch (error) {
    // A manual check is an explicit freshness request. Do not keep showing an
    // update that this check could not confirm. Silent failures keep the last
    // successful result so transient network loss does not erase UI state.
    if (notify) coordinator.clearAvailableUpdate();
    notifyCheckFailure(error, notify);
    return notify ? null : coordinator.getAvailableUpdate();
  }
}

export async function checkForUpdatesManually(): Promise<Update | null> {
  return checkForAppUpdates({ notify: true, force: true });
}

function createProgressReporter(): (event: DownloadEvent) => void {
  let lastReportedAt = 0;
  let downloaded = 0;
  let total: number | null = null;

  return (event) => {
    if (event.event === "Started") {
      downloaded = 0;
      total = event.data.contentLength ?? null;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
    }

    const now = Date.now();
    const shouldReport =
      event.event !== "Progress" ||
      now - lastReportedAt >= DOWNLOAD_PROGRESS_UPDATE_MIN_INTERVAL_MS;
    if (!shouldReport) return;

    lastReportedAt = now;
    const previous = store().get(appUpdateDownloadProgressAtom);
    const percent =
      event.event === "Finished"
        ? 100
        : total
          ? Math.min(100, Math.round((downloaded / total) * 100))
          : null;
    const progress: AppUpdateDownloadProgress = {
      active: true,
      collapsed: previous.collapsed,
      downloadedBytes: downloaded,
      totalBytes: total,
      percent,
    };
    setDownloadProgress(progress);
    if (!progress.collapsed) showDownloadProgressNotice(progress);
  };
}

async function relaunchApp(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

export interface InstallAvailableAppUpdateOptions {
  confirmed?: boolean;
  silentDownload?: boolean;
}

async function prepareAvailableAppUpdate(
  update: Update,
  silentDownload: boolean
): Promise<void> {
  const progressReporter = silentDownload
    ? undefined
    : createProgressReporter();
  clearSkippedUpdateVersion(update.version);
  if (progressReporter) beginDownloadProgress();

  try {
    await coordinator.downloadAvailableUpdate(progressReporter);
    endDownloadProgress();
    store().set(appUpdateInstallPromptAtom, true);
  } catch (error) {
    if (progressReporter) endDownloadProgress();
    throw error;
  }
}

function showDownloadFailure(
  error: unknown,
  options: { automatic: boolean; retry: () => void }
): void {
  const errorContent = getDownloadErrorMessage(error);
  Message.error({
    id: INSTALL_TOAST_ID,
    title: "Update download failed",
    content: options.automatic
      ? `${errorContent} ORGII will retry in the background with increasing delays.`
      : errorContent,
    duration: 0,
    cancel: {
      label: options.automatic ? "Retry now" : "Retry",
      onClick: options.retry,
      closeOnClick: false,
    },
  });
}

export async function installAvailableAppUpdate(
  options: InstallAvailableAppUpdateOptions = {}
): Promise<void> {
  const { confirmed = false, silentDownload = false } = options;
  const update =
    coordinator.getAvailableUpdate() ?? (await checkForUpdatesManually());
  if (!update) return;

  if (!confirmed) {
    try {
      await prepareAvailableAppUpdate(update, silentDownload);
      activeAutomaticScheduler?.resetRetry();
    } catch (error) {
      showDownloadFailure(error, {
        automatic: false,
        retry: () => void installAvailableAppUpdate({ silentDownload }),
      });
      log.error("Update download failed", error);
    }
    return;
  }

  try {
    Message.info({
      id: INSTALL_TOAST_ID,
      title: "Installing update",
      content: `Preparing v${update.version}…`,
      duration: 0,
    });

    const installed = await coordinator.installAvailableUpdate();
    if (!installed) return;

    Message.success({
      id: INSTALL_TOAST_ID,
      title: "Update installed",
      content: "Restarting ORGII to finish the update.",
      duration: 2500,
    });
    await relaunchApp();
  } catch (error) {
    Message.error({
      id: INSTALL_TOAST_ID,
      title: "Update install failed",
      content: getErrorMessage(error),
      duration: 6000,
    });
    log.error("Update install failed", error);
  }
}

async function executeAutomaticUpdate(
  reason: AutomaticUpdateReason,
  scheduler: AppUpdaterScheduler
): Promise<void> {
  let update: Update | null;
  try {
    const cachedRetryUpdate =
      reason === "retry" ? coordinator.getAvailableUpdate() : null;
    update =
      cachedRetryUpdate ??
      (
        await coordinator.checkForUpdate(
          reason === "startup" || reason === "interval" || reason === "retry"
        )
      ).update;
  } catch (error) {
    log.warn(
      `Automatic update check (${reason}) failed`,
      getErrorMessage(error)
    );
    throw error;
  }

  if (!update) {
    return;
  }
  if (getSkippedUpdateVersion() === update.version) {
    coordinator.clearAvailableUpdate();
    return;
  }

  try {
    // Installing can terminate the app on Windows. Every automatic path only
    // prepares the package and asks the user before installing or relaunching.
    await prepareAvailableAppUpdate(update, true);
  } catch (error) {
    showDownloadFailure(error, {
      automatic: true,
      retry: () => scheduler.retryNow(),
    });
    log.warn(
      `Automatic update download (${reason}) failed`,
      getErrorMessage(error)
    );
    throw error;
  }
}

export function useAvailableAppUpdate(): Update | null {
  return useAtomValue(availableAppUpdateAtom);
}

export function useIsAppUpdateInstalling(): boolean {
  return useAtomValue(isAppUpdateInstallingAtom);
}

export const AppUpdater: React.FC = () => {
  const { t } = useTranslation(["settings", "common"]);
  const availableUpdate = useAtomValue(availableAppUpdateAtom);
  const downloadProgress = useAtomValue(appUpdateDownloadProgressAtom);
  const [installPromptVisible, setInstallPromptVisible] = useAtom(
    appUpdateInstallPromptAtom
  );
  const settingsLoaded = useAtomValue(settingsLoadedAtom);

  const handleInstallLater = useCallback(() => {
    setInstallPromptVisible(false);
  }, [setInstallPromptVisible]);

  const handleSkipVersion = useCallback(() => {
    if (availableUpdate) setSkippedUpdateVersion(availableUpdate.version);
    coordinator.clearAvailableUpdate();
    setInstallPromptVisible(false);
  }, [availableUpdate, setInstallPromptVisible]);

  const handleInstallConfirm = useCallback(async () => {
    await installAvailableAppUpdate({ confirmed: true });
    setInstallPromptVisible(false);
  }, [setInstallPromptVisible]);

  useEffect(() => {
    if (!settingsLoaded) return;

    const scheduler = new AppUpdaterScheduler({
      startupDelayMs: STARTUP_CHECK_DELAY_MS,
      intervalMs: UPDATE_CHECK_INTERVAL_MS,
      foregroundDebounceMs: FOREGROUND_EVENT_DEBOUNCE_MS,
      retryBaseDelayMs: UPDATE_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: UPDATE_RETRY_MAX_DELAY_MS,
      retryJitterRatio: UPDATE_RETRY_JITTER_RATIO,
    });
    activeAutomaticScheduler = scheduler;
    scheduler.start((reason) => executeAutomaticUpdate(reason, scheduler));

    return () => {
      scheduler.stop();
      if (activeAutomaticScheduler === scheduler) {
        activeAutomaticScheduler = null;
      }
    };
  }, [settingsLoaded]);

  return (
    <>
      <Modal
        visible={installPromptVisible && Boolean(availableUpdate)}
        title={t("update.installConfirmTitle")}
        width={620}
        closable={false}
        maskClosable={false}
        escToExit={false}
        onCancel={handleInstallLater}
        onClose={handleInstallLater}
        bodyClassName="px-6 py-5"
        footerTopBorder={false}
        footer={
          <div className="flex items-center justify-between gap-3 px-5 py-4">
            <Button
              variant="tertiary"
              appearance="ghost"
              size="large"
              shape="round"
              onClick={handleSkipVersion}
            >
              {t("update.skipVersion")}
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                appearance="solid"
                size="large"
                shape="round"
                onClick={handleInstallLater}
              >
                {t("common:actions.later")}
              </Button>
              <Button
                variant="primary"
                size="large"
                shape="round"
                onClick={handleInstallConfirm}
                data-modal-primary-action
              >
                {t("update.installAndRestart")}
              </Button>
            </div>
          </div>
        }
      >
        <div className="flex items-center gap-5">
          <AppMark
            size={72}
            className="border border-border-2 bg-bg-2 shadow-sm"
            glyphClassName="text-text-1"
          />
          <p className="min-w-0 flex-1 text-sm leading-6 text-text-2">
            {t("update.installConfirmDesc", {
              version: availableUpdate?.version,
            })}
          </p>
        </div>
      </Modal>
      <DownloadProgressOrb
        progress={downloadProgress}
        onExpand={expandDownloadProgressNotice}
      />
    </>
  );
};

/** Test-only reset for the module singleton. */
export function resetAppUpdaterForTests(): void {
  activeAutomaticScheduler?.stop();
  activeAutomaticScheduler = null;
  coordinator.reset();
  store().set(appUpdateInstallPromptAtom, false);
  setDownloadProgress(EMPTY_APP_UPDATE_DOWNLOAD_PROGRESS);
}
