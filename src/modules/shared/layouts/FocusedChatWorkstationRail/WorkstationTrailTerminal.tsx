/**
 * WorkstationTrailTerminal
 *
 * The trail's terminal: a short panel docked directly under the trail
 * surface, in the trail's own column and on an identical surface. It is not
 * a floating window — it cannot be dragged, it collapses to its header row,
 * and its expanded width/height can be resized from the bottom-left corner.
 *
 * # Reuses the Workstation terminal, does not clone it
 *
 * The panel renders the same `TerminalCore` / `TerminalView` / PTY pipeline
 * the Workstation terminal pane uses, over the same
 * `store/workstation/codeEditor/terminal` sessions. It scopes a synthetic
 * `UseTerminalStateReturn` down to the sessions it has claimed — the shape
 * `ChatPanelTerminalContent` already uses for chat pane terminal tabs.
 *
 * While a session is claimed the Workstation pane suppresses its mount, so a
 * PTY never has two xterm writers. The terminal is therefore only rendered
 * once suppression is actually in force for the active session, and stays
 * mounted behind `display: none` while collapsed so the PTY keeps its view.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { Suspense, useCallback, useId, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  type AddSessionOptions,
  type UseTerminalStateReturn,
  getTerminalDisplayTitle,
} from "@src/engines/TerminalCore/types";
import { selectedRepoPathAtom } from "@src/store/repo";
import {
  closeMiniTerminalAtom,
  closeMiniTerminalSessionAtom,
  miniTerminalActiveIdAtom,
  miniTerminalClaimedIdsAtom,
  miniTerminalCollapsedAtom,
  miniTerminalSuppressedIdsAtom,
  openMiniTerminalAtom,
  setMiniTerminalActiveIdAtom,
} from "@src/store/ui/miniTerminalAtom";
import {
  initializedTerminalIdsAtom,
  markTerminalInitializedAtom,
  renameTerminalSessionAtom,
  terminalSessionsAtom,
  updateTerminalSessionInfoAtom,
} from "@src/store/workstation/codeEditor/terminal";

import { WorkstationTrailSurface } from "../blocks";
import { TrailPanelResizeHandle } from "./TrailPanelResizeHandle";
import {
  type TrailTerminalTab,
  WorkstationTrailTerminalHeader,
} from "./WorkstationTrailTerminalHeader";
import {
  TRAIL_TERMINAL_SIZE_LIMITS,
  type TrailPanelSize,
} from "./trailPanelSize";

// Lazy: pulls TerminalCore (xterm + addons) only once the trail terminal is
// actually opened, so the focused chat does not pay for it by default.
const TerminalCore = React.lazy(() => import("@src/engines/TerminalCore"));

interface WorkstationTrailTerminalProps {
  width: number;
  height: number;
  onResize: (size: TrailPanelSize) => void;
  onResizeEnd: (size: TrailPanelSize) => void;
  onResizingChange: (resizing: boolean) => void;
}

export function WorkstationTrailTerminal({
  width,
  height,
  onResize,
  onResizeEnd,
  onResizingChange,
}: WorkstationTrailTerminalProps) {
  const { t } = useTranslation();
  const panelId = useId();
  const claimedIds = useAtomValue(miniTerminalClaimedIdsAtom);
  const activeId = useAtomValue(miniTerminalActiveIdAtom);
  const suppressedIds = useAtomValue(miniTerminalSuppressedIdsAtom);
  const collapsed = useAtomValue(miniTerminalCollapsedAtom);
  const allSessions = useAtomValue(terminalSessionsAtom);
  const initializedIds = useAtomValue(initializedTerminalIdsAtom);
  const repoPath = useAtomValue(selectedRepoPathAtom);

  const setCollapsed = useSetAtom(miniTerminalCollapsedAtom);
  const setActiveId = useSetAtom(setMiniTerminalActiveIdAtom);
  const markInitialized = useSetAtom(markTerminalInitializedAtom);
  const updateInfo = useSetAtom(updateTerminalSessionInfoAtom);
  const renameSession = useSetAtom(renameTerminalSessionAtom);
  const openMiniTerminal = useSetAtom(openMiniTerminalAtom);
  const closeMiniTerminal = useSetAtom(closeMiniTerminalAtom);
  const closeMiniTerminalSession = useSetAtom(closeMiniTerminalSessionAtom);

  const sessions = useMemo(
    () => allSessions.filter((session) => claimedIds.includes(session.id)),
    [allSessions, claimedIds]
  );

  const handleAddSession = useCallback(
    (options?: AddSessionOptions) => openMiniTerminal(null, options) ?? "",
    [openMiniTerminal]
  );

  // Scoped runtime: the real Workstation sessions, narrowed to this panel's
  // claims and its own active tab, so `TerminalCore` mounts exactly the
  // sessions the Workstation pane is currently suppressing.
  const terminalState = useMemo<UseTerminalStateReturn>(
    () => ({
      sessions,
      activeSessionId: activeId ?? "",
      activeSession: sessions.find((session) => session.id === activeId),
      initializedSessions: initializedIds,
      addSession: handleAddSession,
      closeSession: (sessionId: string) => closeMiniTerminalSession(sessionId),
      setActiveSession: (sessionId: string) => setActiveId(sessionId),
      markSessionInitialized: (sessionId: string) => markInitialized(sessionId),
      updateSessionInfo: (sessionId, info) => updateInfo({ sessionId, info }),
      renameSession: (sessionId: string, title: string) =>
        renameSession({ sessionId, title }),
    }),
    [
      activeId,
      closeMiniTerminalSession,
      handleAddSession,
      initializedIds,
      markInitialized,
      renameSession,
      sessions,
      setActiveId,
      updateInfo,
    ]
  );

  const terminalTabs = useMemo<TrailTerminalTab[]>(
    () =>
      sessions.map((session) => ({
        key: session.id,
        label: getTerminalDisplayTitle(session),
      })),
    [sessions]
  );

  // Only mount once the Workstation pane has actually let go of the session.
  const terminalMountable = activeId != null && suppressedIds.has(activeId);

  return (
    <WorkstationTrailSurface
      as="aside"
      aria-label={t("common:git.rail.showMiniTerminals")}
      className={`group/workstation-trail-terminal relative mt-1 ml-auto hidden min-h-0 ${collapsed ? "shrink-0" : "pb-5"} @[1100px]/focusedchat:flex`}
      style={
        collapsed
          ? undefined
          : {
              width,
              height,
            }
      }
      data-workstation-trail-terminal
      data-workstation-trail-panel
    >
      <WorkstationTrailTerminalHeader
        activeId={activeId}
        collapsed={collapsed}
        panelId={panelId}
        tabs={terminalTabs}
        onSelect={setActiveId}
        onToggleCollapsed={() => setCollapsed(!collapsed)}
        onAdd={() => handleAddSession()}
        onHide={closeMiniTerminal}
        onStop={closeMiniTerminalSession}
      />
      {/* Kept mounted while collapsed: unmounting would drop the xterm this
          panel is the only host for, leaving the claimed PTY unattached. */}
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={
          !collapsed && activeId ? `${panelId}-tab-${activeId}` : undefined
        }
        className={
          collapsed
            ? "hidden"
            : "flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg"
        }
      >
        <Suspense fallback={null}>
          {terminalMountable ? (
            <TerminalCore
              terminalState={terminalState}
              repoPath={repoPath || undefined}
              backgroundColor="var(--cm-editor-background)"
              fontSize={12}
              visible={!collapsed}
            />
          ) : null}
        </Suspense>
      </div>
      {!collapsed ? (
        <TrailPanelResizeHandle
          label={t("common:git.rail.resizeTerminal")}
          min={{
            width: TRAIL_TERMINAL_SIZE_LIMITS.minWidth,
            height: TRAIL_TERMINAL_SIZE_LIMITS.minHeight,
          }}
          max={{
            width: TRAIL_TERMINAL_SIZE_LIMITS.maxWidth,
            height: TRAIL_TERMINAL_SIZE_LIMITS.maxHeight,
          }}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
          onResizingChange={onResizingChange}
        />
      ) : null}
    </WorkstationTrailSurface>
  );
}

WorkstationTrailTerminal.displayName = "WorkstationTrailTerminal";
