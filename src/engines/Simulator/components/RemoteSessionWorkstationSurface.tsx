import { Provider, createStore } from "jotai";
import React, { useCallback, useLayoutEffect, useMemo, useState } from "react";

import { ChatSessionContext } from "@src/engines/ChatPanel/ChatSessionContext";
import {
  currentEventIdAtom,
  loadErrorAtom,
  loadStatusAtom,
  replayBarValueAtom,
  replayModeAtom,
  replayTimeRangeAtom,
  sessionIdAtom,
  specsAtom,
} from "@src/engines/SessionCore";
import { derivedSnapshotAtom } from "@src/engines/SessionCore/core/atoms/events";
import type {
  SessionEvent,
  SessionLoadStatus,
} from "@src/engines/SessionCore/core/types";
import { buildRemoteReplaySnapshot } from "@src/engines/SessionCore/replay/remoteReplaySnapshot";
import { StationModePillView } from "@src/modules/WorkStation/shared/StationModePill";
import type { StationMode } from "@src/store/ui/simulatorAtom";

import ActivitySimulator from "../ActivitySimulator";
import { RemoteSessionWorkspaceSurface } from "./RemoteSessionWorkspaceSurface";

export interface RemoteSessionWorkstationSurfaceProps {
  sessionId: string;
  events: SessionEvent[];
  loadStatus: SessionLoadStatus;
  loadError: string | null;
  loadProgress?: {
    loadedEvents: number;
    totalEvents: number | null;
  } | null;
  onRetry?: () => void;
  /** Replay cursor event forwarded to My Station file selection. */
  currentEventId?: string | null;
  /** Inclusive replay cursor on the full event list. */
  replayEndIndex?: number;
}

function createRemoteReplayStore(sessionId: string) {
  const store = createStore();
  store.set(sessionIdAtom, sessionId);
  return store;
}

/**
 * Runs the canonical desktop ActivitySimulator against Cloud events without
 * mutating the desktop/global EventStore. The nested store is one replay
 * sandbox per remote session; the Web replay controller owns the cursor by
 * passing the visible event prefix.
 */
export function RemoteSessionWorkstationSurface({
  sessionId,
  events,
  loadStatus,
  loadError,
  loadProgress = null,
  onRetry,
  currentEventId = null,
  replayEndIndex,
}: RemoteSessionWorkstationSurfaceProps) {
  const replayStore = useMemo(
    () => createRemoteReplayStore(sessionId),
    [sessionId]
  );
  const snapshot = useMemo(
    () => buildRemoteReplaySnapshot(events, { endIndex: replayEndIndex }),
    [events, replayEndIndex]
  );
  const [stationSelection, setStationSelection] = useState<{
    sessionId: string;
    mode: StationMode;
  }>(() => ({ sessionId, mode: "my-station" }));
  const stationMode =
    stationSelection.sessionId === sessionId
      ? stationSelection.mode
      : "my-station";

  const handleStationModeChange = useCallback(
    (mode: StationMode) => {
      setStationSelection({ sessionId, mode });
    },
    [sessionId]
  );

  useLayoutEffect(() => {
    const simulatorEvents = snapshot.sortedSimulatorEvents;
    const firstEvent = simulatorEvents[0] ?? null;
    const lastEvent = simulatorEvents[simulatorEvents.length - 1] ?? null;

    replayStore.set(sessionIdAtom, sessionId);
    replayStore.set(derivedSnapshotAtom, snapshot);
    replayStore.set(specsAtom, []);
    replayStore.set(loadStatusAtom, loadStatus);
    replayStore.set(loadErrorAtom, loadError);
    replayStore.set(
      currentEventIdAtom,
      currentEventId ?? lastEvent?.id ?? null
    );
    replayStore.set(replayModeAtom, "follow");
    replayStore.set(replayBarValueAtom, 200);
    replayStore.set(replayTimeRangeAtom, {
      start: firstEvent?.createdAt ?? "",
      end: lastEvent?.createdAt ?? "",
    });
  }, [currentEventId, loadError, loadStatus, replayStore, sessionId, snapshot]);

  return (
    <Provider store={replayStore}>
      <ChatSessionContext.Provider value={sessionId}>
        <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-workstation-bg">
          <div
            className="flex h-10 shrink-0 items-center gap-2 border-b border-border-2 px-2"
            data-remote-station-header
          >
            <StationModePillView
              stationMode={stationMode}
              onStationModeChange={handleStationModeChange}
            />
            <span className="min-w-0 truncate text-[12px] text-text-3">
              {stationMode === "agent-station"
                ? "Agent replay · Read only"
                : "Session workspace · Read only"}
            </span>
          </div>
          <div className="relative min-h-0 min-w-0 flex-1">
            {stationMode === "agent-station" ? (
              <div
                className="absolute inset-0"
                data-remote-station-panel="agent-station"
              >
                <ActivitySimulator
                  externalReplayControl
                  floatingInputEnabled={false}
                  subagentsEnabled={false}
                />
              </div>
            ) : null}
            {stationMode === "my-station" ? (
              <div
                className="absolute inset-0"
                data-remote-station-panel="my-station"
              >
                <RemoteSessionWorkspaceSurface
                  events={events}
                  loadStatus={loadStatus}
                  loadError={loadError}
                  loadProgress={loadProgress}
                  onRetry={onRetry}
                  currentEventId={currentEventId}
                  replayEndIndex={replayEndIndex}
                />
              </div>
            ) : null}
          </div>
        </div>
      </ChatSessionContext.Provider>
    </Provider>
  );
}
