import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useVisiblePolling } from "@src/hooks/async";
import { useSettingValue } from "@src/hooks/settings";
import { sessionsAtom } from "@src/store/session/sessionAtom";
import type { Session } from "@src/store/session/sessionAtom";
import { settingsLoadedAtom } from "@src/store/settings/settingsAtom";
import { workspaceFoldersAtom } from "@src/store/ui/workspaceFoldersAtom";
import type { WorkspaceFolder } from "@src/types/workspace";

import { createDiagnosticsUsageSnapshot } from "./aggregate";
import {
  diagnosticsConfigure,
  diagnosticsFlushNow,
  diagnosticsRecordUsageSnapshot,
  diagnosticsStart,
} from "./rustBridge";
import { DIAGNOSTICS_LEVEL } from "./types";
import type { DiagnosticsLevel, DiagnosticsServiceConfig } from "./types";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const LAST_FLUSH_STORAGE_KEY = "orgii:diagnostics:lastFlushAt";

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

export function useDiagnosticsBootstrap(): void {
  const settingsLoaded = useAtomValue(settingsLoadedAtom);
  const diagnosticsLevelSetting = useSettingValue("privacy.diagnosticsLevel");
  const uploadIntervalHours = useSettingValue(
    "privacy.diagnosticsUploadIntervalHours"
  );
  const offlineMode = useSettingValue("privacy.offlineMode");
  const sessions = useAtomValue(sessionsAtom);
  const workspaceFolders = useAtomValue(workspaceFoldersAtom);
  const startedRef = useRef(false);
  const runningRef = useRef(false);
  const sessionsRef = useRef<Session[]>(sessions);
  const workspaceFoldersRef = useRef<WorkspaceFolder[]>(workspaceFolders);

  const diagnosticsLevel = normalizeDiagnosticsLevel(diagnosticsLevelSetting);
  const intervalMs = Math.max(uploadIntervalHours, 1) * HOUR_MS;
  const serviceConfig = useMemo<DiagnosticsServiceConfig>(
    () => ({
      diagnosticsLevel,
      offlineMode,
      uploadIntervalHours,
    }),
    [diagnosticsLevel, offlineMode, uploadIntervalHours]
  );

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    workspaceFoldersRef.current = workspaceFolders;
  }, [workspaceFolders]);

  useEffect(() => {
    if (!settingsLoaded) return;

    let cancelled = false;
    const configureService = async () => {
      if (!startedRef.current) {
        const started = await diagnosticsStart(serviceConfig);
        if (cancelled) return;
        startedRef.current = started;
        if (started) return;
      }

      await diagnosticsConfigure(serviceConfig);
    };

    void configureService();

    return () => {
      cancelled = true;
    };
  }, [serviceConfig, settingsLoaded]);

  const collectAndSendSnapshot = useCallback(
    async (signalOrForce?: AbortSignal | boolean) => {
      const signal =
        typeof signalOrForce === "object" ? signalOrForce : undefined;
      const force = signalOrForce === true;
      if (runningRef.current) return;
      if (!settingsLoaded || offlineMode) {
        return;
      }

      const nowMs = Date.now();
      if (!force && !shouldFlushNow(intervalMs, nowMs)) {
        return;
      }

      runningRef.current = true;
      try {
        const snapshot = await createDiagnosticsUsageSnapshot({
          diagnosticsLevel,
          sessions: sessionsRef.current,
          workspaceFolders: workspaceFoldersRef.current,
        });
        if (signal?.aborted) return;
        if (snapshot) {
          await diagnosticsRecordUsageSnapshot(snapshot);
        }
        if (signal?.aborted) return;
        writeLastFlushAt(nowMs);
        await diagnosticsFlushNow();
      } finally {
        runningRef.current = false;
      }
    },
    [diagnosticsLevel, intervalMs, offlineMode, settingsLoaded]
  );

  useVisiblePolling({
    enabled: settingsLoaded && !offlineMode,
    intervalMs,
    poll: collectAndSendSnapshot,
  });
}
