/**
 * BackgroundTasksApp
 *
 * Simulator app that renders an internal sub-grid of active subagent clips
 * (video-editor model). Receives the cursor-filtered `activeSessions` list
 * and the main replay cursor timestamp from ActivitySimulator. Subscribes to
 * each child's EventStore internally via `useMultiSessionSimulatorEvents`.
 * Each child gets its own IndependentGridCell which by default syncs to the
 * main cursor and can be detached by user actions.
 *
 * Layout: vertical stack (1 column) — 1x1 for one child, 2x1 for two,
 * 2x2 only when four or more.
 */
import React, { useMemo } from "react";

import { IndependentGridCell } from "../../components/GridCell/IndependentGridCell";
import { MultiTaskHeader } from "../../components/MultiTaskHeader";
import { type GridLayout, LAYOUT_OPTIONS } from "../../config";
import { useMultiSessionSimulatorEvents } from "../../hooks/useMultiSessionSimulatorEvents";
import type { SubagentSession } from "../../hooks/useSubagentSessions";
import type { SimulatorAppProps } from "../core/types";

function verticalLayout(count: number): GridLayout {
  if (count <= 1) return "1x1";
  if (count <= 3) return "2x1";
  return "2x2";
}

const AGENT_COLORS = [
  "from-blue-500",
  "from-purple-500",
  "from-green-500",
  "from-orange-500",
] as const;

interface BackgroundTasksAppProps extends SimulatorAppProps {
  activeSessions?: SubagentSession[];
  /** Main replay cursor in epoch ms. Cells sync to this when provided. */
  mainCursorMs?: number | null;
  /** Called when the user clicks the close (X) button in the header. */
  onClose?: () => void;
  /** Called when the user clicks the minimize (PiP) button in the header. */
  onMinimize?: () => void;
}

const BackgroundTasksApp: React.FC<BackgroundTasksAppProps> = ({
  activeSessions = [],
  mainCursorMs = null,
  onClose,
  onMinimize,
}) => {
  const subagentEventsMap = useMultiSessionSimulatorEvents(activeSessions);

  const childEntries = useMemo(() => {
    return activeSessions.map((sub) => ({
      key: sub.key,
      sessionId: sub.sessionId,
      name: sub.name,
      description: sub.description,
      sessionType: sub.sessionType,
      events: subagentEventsMap.get(sub.sessionId) ?? [],
      isSessionLive: sub.endedAtMs === null,
    }));
  }, [activeSessions, subagentEventsMap]);

  const childCount = childEntries.length;
  const layout = verticalLayout(childCount);
  const layoutConfig = LAYOUT_OPTIONS[layout];

  const gridStyle = useMemo(
    () => ({
      display: "grid" as const,
      gridTemplateColumns: `repeat(${layoutConfig.cols}, 1fr)`,
      gridTemplateRows: `repeat(${layoutConfig.rows}, 1fr)`,
      height: "100%",
      width: "100%",
    }),
    [layoutConfig.cols, layoutConfig.rows]
  );

  const lastRowCellCount = ((childCount - 1) % layoutConfig.cols) + 1;
  const lastRowStripClass =
    lastRowCellCount === 1
      ? "[&>*:last-child]:border-b-0!"
      : "[&>*:nth-last-child(-n+2)]:border-b-0!";

  if (childCount === 0) {
    return null;
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <MultiTaskHeader
        taskCount={childCount}
        onClose={onClose}
        onMinimize={onMinimize}
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className={lastRowStripClass} style={gridStyle}>
          {childEntries.map((entry, index) => (
            <IndependentGridCell
              key={entry.key}
              index={index}
              color={AGENT_COLORS[index % AGENT_COLORS.length]}
              title={entry.name}
              subtitle={entry.description || undefined}
              events={entry.events}
              specs={[]}
              sessionType={entry.sessionType}
              threadId={entry.sessionId}
              independentReplay
              externalCursorMs={mainCursorMs}
              isSessionLive={entry.isSessionLive}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

BackgroundTasksApp.displayName = "BackgroundTasksApp";

export default BackgroundTasksApp;
