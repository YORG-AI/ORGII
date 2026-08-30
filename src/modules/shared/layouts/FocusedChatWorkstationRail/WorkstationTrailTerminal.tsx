/**
 * WorkstationTrailTerminal
 *
 * The trail's terminal: a short panel docked directly under the trail
 * surface, in the trail's own column and on an identical surface. It is not
 * a floating window — it cannot be dragged, it collapses to its header row,
 * and it widens the trail track to `MINI_TERMINAL_TRAIL_WIDTH` when opened.
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
import React, { Suspense, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  type AddSessionOptions,
  type UseTerminalStateReturn,
  getTerminalDisplayTitle,
} from "@src/engines/TerminalCore/types";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Delete02Icon,
  HugeiconsIcon,
} from "@src/icons";
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
  editorAddTerminalSessionAtom,
  initializedTerminalIdsAtom,
  markTerminalInitializedAtom,
  renameTerminalSessionAtom,
  terminalSessionsAtom,
  updateTerminalSessionInfoAtom,
} from "@src/store/workstation/codeEditor/terminal";

import {
  DetailTabStrip,
  type DetailTabStripItem,
  WorkstationTrailHeader,
  WorkstationTrailIconButton,
  WorkstationTrailSurface,
} from "../blocks";

// Lazy: pulls TerminalCore (xterm + addons) only once the trail terminal is
// actually opened, so the focused chat does not pay for it by default.
const TerminalCore = React.lazy(() => import("@src/engines/TerminalCore"));

/** Expanded panel height. Collapsed, the surface is just its header row. */
export const WORKSTATION_TRAIL_TERMINAL_HEIGHT_PX = 260;

export function WorkstationTrailTerminal() {
  const { t } = useTranslation();
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
  const addWorkstationSession = useSetAtom(editorAddTerminalSessionAtom);
  const openMiniTerminal = useSetAtom(openMiniTerminalAtom);
  const closeMiniTerminal = useSetAtom(closeMiniTerminalAtom);
  const closeMiniTerminalSession = useSetAtom(closeMiniTerminalSessionAtom);

  const sessions = useMemo(
    () => allSessions.filter((session) => claimedIds.includes(session.id)),
    [allSessions, claimedIds]
  );

  const handleAddSession = useCallback(
    (options?: AddSessionOptions) => {
      const sessionId = addWorkstationSession({
        cwd: repoPath || undefined,
        ...options,
      });
      if (sessionId) openMiniTerminal(sessionId);
      return sessionId;
    },
    [addWorkstationSession, openMiniTerminal, repoPath]
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

  const terminalTabs = useMemo<DetailTabStripItem[]>(
    () =>
      sessions.map((session) => ({
        key: session.id,
        label: getTerminalDisplayTitle(session),
      })),
    [sessions]
  );

  const activeSession = terminalState.activeSession;
  const activeTitle = activeSession
    ? getTerminalDisplayTitle(activeSession)
    : t("common:tabs.terminal");
  const showTabs = !collapsed && sessions.length > 1;
  // The strip already names every terminal; repeating the active one in the
  // header title would say it twice.
  const title = showTabs ? t("common:tabs.terminal") : activeTitle;
  // Only mount once the Workstation pane has actually let go of the session.
  const terminalMountable = activeId != null && suppressedIds.has(activeId);

  return (
    <WorkstationTrailSurface
      as="aside"
      aria-label={t("common:git.rail.showMiniTerminals")}
      className="group/workstation-trail-terminal mt-1 hidden shrink-0 @[1100px]/focusedchat:flex"
      style={
        collapsed
          ? undefined
          : {
              height: WORKSTATION_TRAIL_TERMINAL_HEIGHT_PX,
              // Never let the terminal swallow the whole trail column on a
              // short window — the trail above it stays readable.
              maxHeight: "60%",
            }
      }
      data-workstation-trail-terminal
    >
      <WorkstationTrailHeader
        title={title}
        titleActions={
          <WorkstationTrailIconButton
            onClick={() => setCollapsed(!collapsed)}
            aria-label={t(
              collapsed ? "common:actions.expand" : "common:actions.collapse"
            )}
            aria-expanded={!collapsed}
          >
            <HugeiconsIcon
              icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
              data-icon={collapsed ? "chevron-right" : "chevron-down"}
              size={14}
              strokeWidth={1.75}
            />
          </WorkstationTrailIconButton>
        }
        actions={
          <div className="flex items-center">
            <WorkstationTrailIconButton
              onClick={() => handleAddSession()}
              aria-label={t("common:git.rail.newMiniTerminal")}
              title={t("common:git.rail.newMiniTerminal")}
            >
              <HugeiconsIcon
                icon={Add01Icon}
                data-icon="plus"
                size={14}
                strokeWidth={1.75}
              />
            </WorkstationTrailIconButton>
            <WorkstationTrailIconButton
              onClick={closeMiniTerminal}
              aria-label={t("common:git.rail.hideMiniTerminal")}
              title={t("common:git.rail.hideMiniTerminal")}
            >
              <HugeiconsIcon
                icon={Cancel01Icon}
                data-icon="x"
                size={14}
                strokeWidth={1.75}
              />
            </WorkstationTrailIconButton>
          </div>
        }
      />
      {showTabs ? (
        // Same strip the pull-request detail header uses, in its compact
        // header variant: one tab per claimed terminal, and a trailing
        // control that kills the terminal the strip is showing.
        <DetailTabStrip
          activeTab={activeId ?? ""}
          ariaLabel={t("common:git.rail.showMiniTerminals")}
          className="mb-1 px-1"
          idPrefix="workstation-trail-terminal"
          onChange={setActiveId}
          tabs={terminalTabs}
          variant="header"
          trailing={
            activeId ? (
              <WorkstationTrailIconButton
                onClick={() => closeMiniTerminalSession(activeId)}
                aria-label={t("common:git.rail.closeItem", {
                  label: activeTitle,
                })}
                title={t("common:git.rail.closeItem", { label: activeTitle })}
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  data-icon="trash"
                  size={14}
                  strokeWidth={1.75}
                />
              </WorkstationTrailIconButton>
            ) : null
          }
        />
      ) : null}
      {/* Kept mounted while collapsed: unmounting would drop the xterm this
          panel is the only host for, leaving the claimed PTY unattached. */}
      <div
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
              visible={!collapsed}
            />
          ) : null}
        </Suspense>
      </div>
    </WorkstationTrailSurface>
  );
}

WorkstationTrailTerminal.displayName = "WorkstationTrailTerminal";
