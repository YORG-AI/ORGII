import { isTauri } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { createLogger } from "@src/hooks/logger";
import { useSettingValue } from "@src/hooks/settings";
import { startVisibilityAwarePoller } from "@src/shared/scheduling/visibilityAwarePoller";
import { sessionsAtom } from "@src/store/session/sessionAtom";
import type { Session } from "@src/store/session/sessionAtom";
import { settingsLoadedAtom } from "@src/store/settings/settingsAtom";
import { workspaceFoldersAtom } from "@src/store/ui/workspaceFoldersAtom";
import type { WorkspaceFolder } from "@src/types/workspace";

import { createDiagnosticsUsageSnapshot } from "./aggregate";
import { discardRuntimeDiagnosticsCounters } from "./runtimeCounters";
import {
  diagnosticsInitialize,
  diagnosticsSubmitUsageSnapshot,
} from "./rustBridge";
import { DIAGNOSTICS_LEVEL } from "./types";
import type { DiagnosticsLevel, DiagnosticsServiceConfig } from "./types";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const LAST_FLUSH_STORAGE_KEY = "orgii:diagnostics:lastFlushAt";
const logger = createLogger("DiagnosticsBootstrap");

function discardRuntimeDiagnostics(): void {
  discardRuntimeDiagnosticsCounters();
}

function reportDiagnosticsFailure(operation: string, error: unknown): void {
  logger.warn(`${operation} failed`, error);
}

function normalizeDiagnosticsLevel(value: unknown): DiagnosticsLevel {
  if (
    value === DIAGNOSTICS_LEVEL.OFF ||
    value === DIAGNOSTICS_LEVEL.PERFORMANCE_ONLY ||
    value === DIAGNOSTICS_LEVEL.DEFAULT
  ) {
    return value;
  }
  return DIAGNOSTICS_LEVEL.DEFAULT;
}

function readLastFlushAt(): number {
  const stored = window.localStorage.getItem(LAST_FLUSH_STORAGE_KEY);
  if (!stored) return 0;
  const parsed = Number(stored);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function writeLastFlushAt(timestamp: number): void {
  window.localStorage.setItem(LAST_FLUSH_STORAGE_KEY, String(timestamp));
}

function shouldFlushNow(intervalMs: number, nowMs: number): boolean {
  return nowMs - readLastFlushAt() >= intervalMs;
}

async function isDiagnosticsCadenceOwner(): Promise<boolean> {
  if (!isTauri()) return true;

  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().label === "main";
  } catch {
    // A Tauri window whose identity cannot be proven must not start another
    // app-wide scheduler; the main window can retry on the next bootstrap.
    return false;
  }
}

export function useDiagnosticsBootstrap(): void {
  const settingsLoaded = useAtomValue(settingsLoadedAtom);
  const diagnosticsLevelSetting = useSettingValue("privacy.diagnosticsLevel");
  const uploadIntervalHours = useSettingValue(
    "privacy.diagnosticsUploadIntervalHours"
  );
  const offlineMode = useSettingValue("privacy.offlineMode");
  const sessions = useAtomValue(sessionsAtom);
  const workspaceFolders = useAtomValue(workspaceFoldersAtom);
  const schedulerGenerationRef = useRef(0);
  const sessionsRef = useRef<Session[]>(sessions);
  const workspaceFoldersRef = useRef<WorkspaceFolder[]>(workspaceFolders);

  const diagnosticsLevel = normalizeDiagnosticsLevel(diagnosticsLevelSetting);
  const intervalMs = Math.max(uploadIntervalHours, 1) * HOUR_MS;
  const serviceConfig = useMemo<DiagnosticsServiceConfig>(
    () => ({
      diagnosticsLevel,
      offlineMode,
    }),
    [diagnosticsLevel, offlineMode]
  );

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    workspaceFoldersRef.current = workspaceFolders;
  }, [workspaceFolders]);

  const collectAndSubmitSnapshot = useCallback(
    async (isCurrent: () => boolean) => {
      if (!isCurrent()) return;
      if (offlineMode) {
        discardRuntimeDiagnostics();
        return;
      }
      const nowMs = Date.now();
      if (!shouldFlushNow(intervalMs, nowMs)) {
        return;
      }

      const snapshot = await createDiagnosticsUsageSnapshot({
        diagnosticsLevel,
        sessions: sessionsRef.current,
        workspaceFolders: workspaceFoldersRef.current,
      });
      if (!snapshot || !isCurrent()) return;

      const submitted = await diagnosticsSubmitUsageSnapshot(snapshot);
      if (submitted && isCurrent()) {
        writeLastFlushAt(Date.now());
      }
    },
    [diagnosticsLevel, intervalMs, offlineMode]
  );

  useEffect(() => {
    if (!settingsLoaded) return;

    const generation = ++schedulerGenerationRef.current;
    let cancelled = false;
    let stopScheduler: (() => void) | undefined;
    const isCurrent = () =>
      !cancelled && schedulerGenerationRef.current === generation;

    const initialize = async () => {
      if (!(await isDiagnosticsCadenceOwner()) || !isCurrent()) return;

      const initialized = await diagnosticsInitialize(serviceConfig);
      if (!initialized || !isCurrent()) return;
      if (offlineMode) {
        discardRuntimeDiagnostics();
        return;
      }

      stopScheduler = startVisibilityAwarePoller(
        document,
        async () => {
          try {
            await collectAndSubmitSnapshot(isCurrent);
          } catch (error) {
            reportDiagnosticsFailure("Scheduled snapshot pass", error);
          }
        },
        intervalMs
      );
    };

    void initialize().catch((error: unknown) => {
      reportDiagnosticsFailure("Service initialization", error);
    });

    return () => {
      cancelled = true;
      stopScheduler?.();
    };
  }, [
    collectAndSubmitSnapshot,
    intervalMs,
    offlineMode,
    serviceConfig,
    settingsLoaded,
  ]);
}
