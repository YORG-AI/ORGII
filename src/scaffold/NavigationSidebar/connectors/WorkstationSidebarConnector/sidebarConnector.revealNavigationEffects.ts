/**
 * Reveal-navigation side effects for `WorkstationSidebarConnector`
 * (`index.tsx`): when a cross-surface "reveal this session" request lands,
 * un-collapses the sidebar, switches to the Workstation layer, selects the
 * request's cloud org, expands the parent subagent group, and hydrates the
 * target row(s). Separately, once the
 * revealed row's containing section is known (via `revealCandidateMenuItems`),
 * un-collapses that section too.
 */
import { useSetAtom } from "jotai";
import { useEffect, useMemo } from "react";

import { sidebarSelectedOrgIdAtom } from "@src/features/Organizations/sidebarOrgScopeAtom";
import { createLogger } from "@src/hooks/logger";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { loadSidebarSessionById } from "@src/store/session";
import type { SessionSidebarRevealRequest } from "@src/store/ui/sidebarAtom";

import { findSidebarSectionIdForMenuItem } from "../workstationSidebarData";
import type { WorkstationSidebarKey } from "./types";
import { buildCloudOrgSelectorValue } from "./useSidebarOrgScope";

const logger = createLogger("WorkstationSidebar");

interface UseWorkstationSidebarRevealNavigationEffectsParams {
  sessionSidebarRevealRequest: SessionSidebarRevealRequest | null;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setActiveSidebarKey: (key: WorkstationSidebarKey) => void;
  setWorkItemsOpen: (open: boolean) => void;
  setChannelsOpen: (open: boolean) => void;
  setSelectedOrgId: ReturnType<
    typeof useSetAtom<typeof sidebarSelectedOrgIdAtom>
  >;
  setExpandedSubagentParentIds: (
    updater: (previousIds: Set<string>) => Set<string>
  ) => void;
  activeSessionSidebarRevealRequest: SessionSidebarRevealRequest | null;
  revealCandidateMenuItems: NavigationMenuItem[];
  setCollapsedSectionIds: (
    updater: (previousIds: Set<string>) => Set<string>
  ) => void;
}

export function useWorkstationSidebarRevealNavigationEffects({
  sessionSidebarRevealRequest,
  setSidebarCollapsed,
  setActiveSidebarKey,
  setWorkItemsOpen,
  setChannelsOpen,
  setSelectedOrgId,
  setExpandedSubagentParentIds,
  activeSessionSidebarRevealRequest,
  revealCandidateMenuItems,
  setCollapsedSectionIds,
}: UseWorkstationSidebarRevealNavigationEffectsParams): void {
  useEffect(() => {
    if (!sessionSidebarRevealRequest) return;

    setSidebarCollapsed(false);
    const parentSessionId =
      sessionSidebarRevealRequest.parentSessionId ??
      sessionSidebarRevealRequest.sessionId;
    const revealFrame = window.requestAnimationFrame(() => {
      setActiveSidebarKey("workstation");
      setWorkItemsOpen(false);
      setChannelsOpen(false);
      if (sessionSidebarRevealRequest.cloudOrgId) {
        setSelectedOrgId(
          buildCloudOrgSelectorValue(sessionSidebarRevealRequest.cloudOrgId)
        );
      }
      if (sessionSidebarRevealRequest.parentSessionId) {
        setExpandedSubagentParentIds((previousIds) => {
          if (previousIds.has(parentSessionId)) return previousIds;
          const nextIds = new Set(previousIds);
          nextIds.add(parentSessionId);
          return nextIds;
        });
      }
    });

    const sessionIds = new Set([
      parentSessionId,
      sessionSidebarRevealRequest.sessionId,
    ]);
    for (const sessionId of sessionIds) {
      void loadSidebarSessionById(sessionId)
        .then((session) => {
          if (!session) {
            logger.warn(
              `Unable to hydrate sidebar row for session ${sessionId}`
            );
          }
        })
        .catch((error: unknown) => {
          logger.warn(
            `Failed to hydrate sidebar row for session ${sessionId}:`,
            error
          );
        });
    }

    return () => window.cancelAnimationFrame(revealFrame);
  }, [
    sessionSidebarRevealRequest,
    setActiveSidebarKey,
    setChannelsOpen,
    setExpandedSubagentParentIds,
    setSelectedOrgId,
    setSidebarCollapsed,
    setWorkItemsOpen,
  ]);

  const revealedSectionId = useMemo(
    () =>
      activeSessionSidebarRevealRequest
        ? findSidebarSectionIdForMenuItem(
            revealCandidateMenuItems,
            activeSessionSidebarRevealRequest.sidebarItemId ??
              activeSessionSidebarRevealRequest.sessionId
          )
        : null,
    [activeSessionSidebarRevealRequest, revealCandidateMenuItems]
  );
  useEffect(() => {
    if (!revealedSectionId) return;
    const revealFrame = window.requestAnimationFrame(() => {
      setCollapsedSectionIds((previousIds) => {
        if (!previousIds.has(revealedSectionId)) return previousIds;
        const nextIds = new Set(previousIds);
        nextIds.delete(revealedSectionId);
        return nextIds;
      });
    });
    return () => window.cancelAnimationFrame(revealFrame);
  }, [revealedSectionId, setCollapsedSectionIds]);
}
