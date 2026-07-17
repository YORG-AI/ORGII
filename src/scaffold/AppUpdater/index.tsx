import { getVersion } from "@tauri-apps/api/app";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { check } from "@tauri-apps/plugin-updater";
import { atom, useAtomValue } from "jotai";
import React, { useEffect } from "react";

import Message from "@src/components/Message";
import { useVisiblePolling } from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";
import i18n from "@src/i18n";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

const log = createLogger("AppUpdater");

const STARTUP_CHECK_DELAY_MS = 10_000;
// Background poll is intentionally long: focus/visibilitychange checks (throttled
// by FOREGROUND_CHECK_MIN_INTERVAL_MS) cover active users, so the timer only
// matters for a window left focused for hours without any focus events.
const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 60_000;
const FOREGROUND_CHECK_MIN_INTERVAL_MS = 5 * 60_000;
const INSTALL_PROGRESS_MESSAGE_MIN_INTERVAL_MS = 2_000;
const UPDATE_TOAST_DURATION_MS = 5_000;
const UPDATE_CHECK_TIMEOUT_MS = 30_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

// Reused toast slots so status updates replace in place instead of stacking.
const CHECK_TOAST_ID = "app-update-check";
const INSTALL_TOAST_ID = "app-update-progress";

interface CheckForAppUpdatesOptions {
  notify?: boolean;
  force?: boolean;
}

const availableAppUpdateAtom = atom<Update | null>(null);
const isAppUpdateInstallingAtom = atom(false);

let lastCheckStartedAt = 0;
let pendingCheck: Promise<Update | null> | null = null;

function store() {
  return getInstrumentedStore();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string"
    ? error
    : i18n.t("common:errors.unknownError", "Unknown error");
}

function getInstallErrorMessage(error: unknown): string {
  const message = getErrorMessage(error);
  if (/timed?\s*out|timeout/i.test(message)) {
    return i18n.t(
      "common:update.downloadTimedOut",
      "The download timed out. Check your network or proxy, then retry."
    );
  }
  return message;
}

function getCachedUpdate(): Update | null {
  return store().get(availableAppUpdateAtom);
}

function setCachedUpdate(update: Update | null): void {
  store().set(availableAppUpdateAtom, update);
}

function shouldReuseRecentResult(force: boolean): boolean {
  return (
    !force && Date.now() - lastCheckStartedAt < FOREGROUND_CHECK_MIN_INTERVAL_MS
  );
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
      title: i18n.t("common:update.available", "Update available"),
      content: i18n.t(
        "common:update.versionReady",
        "Version {{version}} is ready to download.",
        { version: update.version }
      ),
      duration: UPDATE_TOAST_DURATION_MS,
    });
    return;
  }

  Message.success({
    id: CHECK_TOAST_ID,
    content: currentVersion
      ? i18n.t(
          "common:update.upToDateVersion",
          "ORGII is up to date (v{{version}}).",
          { version: currentVersion }
        )
      : i18n.t("common:update.upToDate", "ORGII is up to date."),
    duration: UPDATE_TOAST_DURATION_MS,
  });
}

function notifyCheckFailure(error: unknown, notify: boolean): void {
  const message = getErrorMessage(error);
  log.warn("Update check failed", message);

  if (!notify) return;
  Message.error({
    id: CHECK_TOAST_ID,
    title: i18n.t("common:update.checkFailed", "Update check failed"),
    content: message,
    duration: UPDATE_TOAST_DURATION_MS,
  });
}

async function runUpdateCheck(notify: boolean): Promise<Update | null> {
  lastCheckStartedAt = Date.now();

  if (notify) {
    Message.info({
      id: CHECK_TOAST_ID,
      content: i18n.t("common:update.checking", "Checking for updates…"),
      duration: 0,
    });
  }

  try {
    const [currentVersion, update] = await Promise.all([
      getVersion().catch(() => undefined),
      check({ timeout: UPDATE_CHECK_TIMEOUT_MS }),
    ]);

    setCachedUpdate(update);

    if (update) {
      log.info("Update available", {
        currentVersion: update.currentVersion || currentVersion,
        version: update.version,
      });
    }

    notifyCheckSuccess(update, currentVersion, notify);
    return update;
  } catch (error) {
    notifyCheckFailure(error, notify);
    return getCachedUpdate();
  } finally {
    pendingCheck = null;
  }
}

export async function checkForAppUpdates(
  options: CheckForAppUpdatesOptions = {}
): Promise<Update | null> {
  const { notify = false, force = false } = options;

  if (pendingCheck) return pendingCheck;
  if (shouldReuseRecentResult(force)) return getCachedUpdate();

  pendingCheck = runUpdateCheck(notify);
  return pendingCheck;
}

export async function checkForUpdatesManually(): Promise<Update | null> {
  return checkForAppUpdates({ notify: true, force: true });
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Tracks cumulative download progress so the toast reflects real percentage
// (or downloaded size when the server omits Content-Length) instead of a
// static string. `Started`/`Finished` always report; `Progress` is throttled.
function createProgressReporter(): (event: DownloadEvent) => void {
  let lastReportedAt = 0;
  let downloaded = 0;
  let total: number | null = null;

  const describe = (event: DownloadEvent): string => {
    switch (event.event) {
      case "Started":
        return total
          ? i18n.t(
              "common:update.downloadingWithSize",
              "Downloading update ({{size}})…",
              { size: formatBytes(total) }
            )
          : i18n.t("common:update.downloadingEllipsis", "Downloading update…");
      case "Progress": {
        if (!total) {
          return i18n.t(
            "common:update.downloadingDownloaded",
            "Downloading update… {{downloaded}}",
            { downloaded: formatBytes(downloaded) }
          );
        }
        const percent = Math.min(100, Math.round((downloaded / total) * 100));
        return i18n.t(
          "common:update.downloadingPercent",
          "Downloading update… {{percent}}%",
          { percent }
        );
      }
      case "Finished":
        return i18n.t("common:update.installingEllipsis", "Installing update…");
    }
  };

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
      now - lastReportedAt >= INSTALL_PROGRESS_MESSAGE_MIN_INTERVAL_MS;
    if (!shouldReport) return;

    lastReportedAt = now;
    Message.info({
      id: INSTALL_TOAST_ID,
      content: describe(event),
      duration: event.event === "Finished" ? 1500 : 2200,
    });
  };
}

export async function installAvailableAppUpdate(): Promise<void> {
  const update = getCachedUpdate() ?? (await checkForUpdatesManually());
  if (!update || store().get(isAppUpdateInstallingAtom)) return;

  store().set(isAppUpdateInstallingAtom, true);

  try {
    Message.info({
      id: INSTALL_TOAST_ID,
      title: i18n.t("common:update.installing", "Installing update"),
      content: i18n.t(
        "common:update.preparingVersion",
        "Preparing to download v{{version}}…",
        { version: update.version }
      ),
      duration: 0,
    });

    await update.downloadAndInstall(createProgressReporter(), {
      timeout: UPDATE_DOWNLOAD_TIMEOUT_MS,
    });

    Message.success({
      id: INSTALL_TOAST_ID,
      title: i18n.t("common:update.installed", "Update installed"),
      content: i18n.t(
        "common:update.restarting",
        "Restarting ORGII to finish the update."
      ),
      duration: 2500,
    });

    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (error) {
    Message.error({
      id: INSTALL_TOAST_ID,
      title: i18n.t("common:update.installFailed", "Update install failed"),
      content: getInstallErrorMessage(error),
      duration: 0,
      cancel: {
        label: i18n.t("common:actions.retry", "Retry"),
        onClick: () => void installAvailableAppUpdate(),
        closeOnClick: false,
      },
    });
    log.error("Update install failed", error);
  } finally {
    store().set(isAppUpdateInstallingAtom, false);
  }
}

export function useAvailableAppUpdate(): Update | null {
  return useAtomValue(availableAppUpdateAtom);
}

export function useIsAppUpdateInstalling(): boolean {
  return useAtomValue(isAppUpdateInstallingAtom);
}

export const AppUpdater: React.FC = () => {
  const pollForUpdates = React.useCallback(async () => {
    await checkForAppUpdates();
  }, []);

  useVisiblePolling({
    enabled: true,
    intervalMs: UPDATE_CHECK_INTERVAL_MS,
    poll: pollForUpdates,
    immediate: false,
  });

  useEffect(() => {
    const startupTimer = window.setTimeout(() => {
      void checkForAppUpdates();
    }, STARTUP_CHECK_DELAY_MS);

    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") void checkForAppUpdates();
    };

    window.addEventListener("focus", checkWhenVisible);
    return () => {
      window.clearTimeout(startupTimer);
      window.removeEventListener("focus", checkWhenVisible);
    };
  }, []);

  return null;
};
