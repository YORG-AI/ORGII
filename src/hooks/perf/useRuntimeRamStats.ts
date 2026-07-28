import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { eventsAtom } from "@src/engines/SessionCore/core/atoms";
import { derivedSnapshotAtom } from "@src/engines/SessionCore/core/atoms/events";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { getLoadedPayloadStats } from "@src/engines/SessionCore/payloads";
import { getLoadedTurnRegistryStats } from "@src/engines/SessionCore/turns/loadedTurnRegistry";
import { getHydratedEventStats } from "@src/engines/Simulator/apps/core/fullEventHydrationRegistry";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import { screenshotCacheStatsAtom } from "@src/store/workstation/browser/browserAutomationAtom";

import {
  SIDEBAR_MEMORY_KIND,
  estimateRuntimeValueBytes,
  getChatRenderedTreeMemoryStats,
  getCodeMirrorMemoryStats,
  getFileTreeMemoryStats,
  getSidebarMemoryStatsByKind,
} from "./runtimeMemoryStats";

const FPS_SAMPLE_MS = 650;

export interface RuntimeRamPartRow {
  key: string;
  label: string;
  value: string;
  bytes: number;
  detail?: string;
}

interface FpsSample {
  fps: number | null;
  frameCount: number;
}

export interface UseRuntimeRamStatsResult {
  rows: RuntimeRamPartRow[];
  fpsValue: string;
  fpsSample: FpsSample;
  isSamplingFps: boolean;
  refresh: () => void;
}

export function formatRuntimeBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 10) return `${megabytes.toFixed(0)} MB`;
  return `${megabytes.toFixed(1)} MB`;
}

function formatTopEntryLabels(
  topEntries: Array<{ label: string; bytes: number }>,
  maxEntries = 2
): string {
  return topEntries
    .slice(0, maxEntries)
    .map((entry) => `${entry.label} ${formatRuntimeBytes(entry.bytes)}`)
    .join(" · ");
}

function sampleFps(durationMs: number): Promise<FpsSample> {
  if (typeof window === "undefined" || !window.requestAnimationFrame) {
    return Promise.resolve({ fps: null, frameCount: 0 });
  }

  return new Promise((resolve) => {
    let frameCount = 0;
    let startedAt = 0;
    let finished = false;

    const finish = (timestamp: number) => {
      if (finished) return;
      finished = true;
      const elapsedMs = Math.max(1, timestamp - startedAt);
      resolve({
        fps: (frameCount * 1000) / elapsedMs,
        frameCount,
      });
    };

    const tick = (timestamp: number) => {
      if (!startedAt) startedAt = timestamp;
      frameCount += 1;
      if (timestamp - startedAt >= durationMs) {
        finish(timestamp);
        return;
      }
      window.requestAnimationFrame(tick);
    };

    window.requestAnimationFrame(tick);
  });
}

export function useRuntimeRamStats(enabled: boolean): UseRuntimeRamStatsResult {
  const { t } = useTranslation();
  const events = useAtomValue(eventsAtom);
  const snapshot = useAtomValue(derivedSnapshotAtom);
  const sessions = useAtomValue(sessionsAtom);
  const screenshotStats = useAtomValue(screenshotCacheStatsAtom);
  const [fpsSample, setFpsSample] = useState<FpsSample>({
    fps: null,
    frameCount: 0,
  });
  const [isSamplingFps, setIsSamplingFps] = useState(false);
  const [refreshSerial, setRefreshSerial] = useState(0);
  const sampleGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      sampleGenerationRef.current += 1;
    };
  }, []);

  const refresh = useCallback(() => {
    setRefreshSerial((prev) => prev + 1);
    const generation = sampleGenerationRef.current + 1;
    sampleGenerationRef.current = generation;
    setIsSamplingFps(true);
    void sampleFps(FPS_SAMPLE_MS).then((sample) => {
      if (!mountedRef.current || sampleGenerationRef.current !== generation) {
        return;
      }
      setFpsSample(sample);
      setIsSamplingFps(false);
    });
  }, []);

  useEffect(() => {
    if (!enabled) {
      sampleGenerationRef.current += 1;
      const frameId = window.requestAnimationFrame(() =>
        setIsSamplingFps(false)
      );
      return () => window.cancelAnimationFrame(frameId);
    }
    const frameId = window.requestAnimationFrame(() => refresh());
    return () => window.cancelAnimationFrame(frameId);
  }, [enabled, refresh]);

  const rows = useMemo<RuntimeRamPartRow[]>(() => {
    void refreshSerial;
    const payloadStats = getLoadedPayloadStats();
    const eventStoreStats = eventStoreProxy.getMemoryStats();
    const hydratedEventStats = getHydratedEventStats();
    const turnStats = getLoadedTurnRegistryStats();
    const fileTreeStats = getFileTreeMemoryStats();
    const codeMirrorStats = getCodeMirrorMemoryStats();
    const chatRenderedTreeStats = getChatRenderedTreeMemoryStats();
    const sidebarStats = getSidebarMemoryStatsByKind();
    const sessionStoreBytes = estimateRuntimeValueBytes(sessions);
    const snapshotEventCount =
      snapshot && "eventCount" in snapshot
        ? snapshot.eventCount
        : events.length;
    const currentSessionBytes = snapshot
      ? estimateRuntimeValueBytes(snapshot)
      : estimateRuntimeValueBytes(events);

    return [
      {
        key: "payloads",
        label: t("layoutSettings.ramPayloads"),
        value: formatRuntimeBytes(payloadStats.bytes),
        bytes: payloadStats.bytes,
      },
      {
        key: "screenshots",
        label: t("layoutSettings.ramScreenshots"),
        value: formatRuntimeBytes(screenshotStats.totalBytes),
        bytes: screenshotStats.totalBytes,
      },
      {
        key: "snapshots",
        label: t("layoutSettings.ramSnapshots"),
        value: formatRuntimeBytes(eventStoreStats.bytes),
        bytes: eventStoreStats.bytes,
        detail: `${t("layoutSettings.ramCountOnly", {
          count: eventStoreStats.cachedEvents,
        })} · ${t("layoutSettings.ramSnapshotDetail", {
          sessions: eventStoreStats.cachedSessions,
          normalized: eventStoreStats.normalizedSessions,
        })}`,
      },
      {
        key: "currentSession",
        label: t("layoutSettings.ramCurrentSession"),
        value: formatRuntimeBytes(currentSessionBytes),
        bytes: currentSessionBytes,
        detail: `${t("layoutSettings.ramCountOnly", {
          count: events.length,
        })} · ${t("layoutSettings.ramCurrentSessionDetail", {
          count: snapshotEventCount,
        })}`,
      },
      {
        key: "hydratedEvents",
        label: t("layoutSettings.ramHydratedEvents"),
        value: formatRuntimeBytes(hydratedEventStats.bytes),
        bytes: hydratedEventStats.bytes,
        detail: `${t("layoutSettings.ramCountOnly", {
          count: hydratedEventStats.entries,
        })} · ${t("layoutSettings.ramHydratedEventsDetail")}`,
      },
      {
        key: "turnBodies",
        label: t("layoutSettings.ramTurnBodies"),
        value: formatRuntimeBytes(turnStats.bytes),
        bytes: turnStats.bytes,
        detail: `${t("layoutSettings.ramCountOnly", {
          count: turnStats.loadedTurns,
        })} · ${t("layoutSettings.ramTurnBodiesDetail", {
          sessions: turnStats.sessions,
          pending: turnStats.pendingLoads,
        })}`,
      },
      {
        key: "chatRenderedTree",
        label: t("layoutSettings.ramChatRenderedTree"),
        value: formatRuntimeBytes(chatRenderedTreeStats.bytes),
        bytes: chatRenderedTreeStats.bytes,
        detail: t("layoutSettings.ramCountOnly", {
          count: chatRenderedTreeStats.items,
        }),
      },
      {
        key: "sessionStore",
        label: t("layoutSettings.ramSessionStore"),
        value: formatRuntimeBytes(sessionStoreBytes),
        bytes: sessionStoreBytes,
        detail: t("layoutSettings.ramCountOnly", {
          count: sessions.length,
        }),
      },
      {
        key: "sessionSidebar",
        label: t("layoutSettings.ramSessionSidebar"),
        value: formatRuntimeBytes(
          sidebarStats[SIDEBAR_MEMORY_KIND.SESSION].bytes
        ),
        bytes: sidebarStats[SIDEBAR_MEMORY_KIND.SESSION].bytes,
        detail: t("layoutSettings.ramCountOnly", {
          count: sidebarStats[SIDEBAR_MEMORY_KIND.SESSION].items,
        }),
      },
      {
        key: "secondLevelSidebars",
        label: t("layoutSettings.ramSecondLevelSidebars"),
        value: formatRuntimeBytes(
          sidebarStats[SIDEBAR_MEMORY_KIND.SECOND_LEVEL].bytes
        ),
        bytes: sidebarStats[SIDEBAR_MEMORY_KIND.SECOND_LEVEL].bytes,
        detail: formatTopEntryLabels(
          sidebarStats[SIDEBAR_MEMORY_KIND.SECOND_LEVEL].topEntries,
          3
        ),
      },
      {
        key: "settingsSidebar",
        label: t("layoutSettings.ramSettingsSidebar"),
        value: formatRuntimeBytes(
          sidebarStats[SIDEBAR_MEMORY_KIND.SETTINGS].bytes
        ),
        bytes: sidebarStats[SIDEBAR_MEMORY_KIND.SETTINGS].bytes,
        detail: t("layoutSettings.ramCountOnly", {
          count: sidebarStats[SIDEBAR_MEMORY_KIND.SETTINGS].items,
        }),
      },
      {
        key: "fileTrees",
        label: t("layoutSettings.ramFileTrees"),
        value: formatRuntimeBytes(fileTreeStats.bytes),
        bytes: fileTreeStats.bytes,
      },
      {
        key: "codeMirrors",
        label: t("layoutSettings.ramCodeMirrors"),
        value: formatRuntimeBytes(codeMirrorStats.bytes),
        bytes: codeMirrorStats.bytes,
        detail: formatTopEntryLabels(codeMirrorStats.topEntries, 3),
      },
    ];
  }, [
    events,
    refreshSerial,
    screenshotStats.totalBytes,
    sessions,
    snapshot,
    t,
  ]);

  const fpsValue = isSamplingFps
    ? t("layoutSettings.ramSampling")
    : fpsSample.fps === null
      ? t("layoutSettings.ramNotAvailable")
      : `${Math.round(fpsSample.fps)} FPS`;

  return {
    rows,
    fpsValue,
    fpsSample,
    isSamplingFps,
    refresh,
  };
}
