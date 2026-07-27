import React, { useEffect, useMemo } from "react";

import { createLogger } from "@src/hooks/logger";
import { loadSidebarSessionById } from "@src/store/session";
import type { SessionSidebarRevealRequest } from "@src/store/ui/sidebarAtom";

import type { WorkstationSidebarKey } from "./types";
import { buildCloudOrgSelectorValue } from "./useSidebarOrgScope";

const logger = createLogger("WorkstationSidebarReveal");

interface UseWorkstationSidebarRevealParams {
  activeSessionId: string;
  request: SessionSidebarRevealRequest | null;
  clearRequest: (requestId: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setActiveSidebarKey: React.Dispatch<
    React.SetStateAction<WorkstationSidebarKey>
  >;
  setWorkItemsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedOrgId: (orgId: string) => void;
  setSidebarSearchQueries: React.Dispatch<
    React.SetStateAction<Record<WorkstationSidebarKey, string>>
  >;
  setExpandedSubagentParentIds: React.Dispatch<
    React.SetStateAction<Set<string>>
  >;
}

export function useWorkstationSidebarReveal({
  activeSessionId,
  request,
  clearRequest,
  setSidebarCollapsed,
  setActiveSidebarKey,
  setWorkItemsOpen,
  setSelectedOrgId,
  setSidebarSearchQueries,
  setExpandedSubagentParentIds,
}: UseWorkstationSidebarRevealParams): {
  activeRequest: SessionSidebarRevealRequest | null;
  revealedSessionIds: ReadonlySet<string>;
} {
  const activatedRequestIdRef = React.useRef<number | null>(null);
  const activeRequest = request?.sessionId === activeSessionId ? request : null;

  useEffect(() => {
    if (!request) {
      activatedRequestIdRef.current = null;
      return;
    }
    if (request.sessionId === activeSessionId) {
      activatedRequestIdRef.current = request.requestId;
      return;
    }
    if (activatedRequestIdRef.current === request.requestId) {
      clearRequest(request.requestId);
      activatedRequestIdRef.current = null;
    }
  }, [activeSessionId, clearRequest, request]);

  const revealedSessionIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeRequest?.sessionId) ids.add(activeRequest.sessionId);
    if (activeRequest?.parentSessionId) ids.add(activeRequest.parentSessionId);
    return ids;
  }, [activeRequest]);

  useEffect(() => {
    if (!request) return;

    setSidebarCollapsed(false);
    const parentSessionId = request.parentSessionId ?? request.sessionId;
    const revealFrame = window.requestAnimationFrame(() => {
      setActiveSidebarKey("workstation");
      setWorkItemsOpen(false);
      if (request.cloudOrgId) {
        setSelectedOrgId(buildCloudOrgSelectorValue(request.cloudOrgId));
      }
      setSidebarSearchQueries((currentQueries) =>
        currentQueries.workstation
          ? { ...currentQueries, workstation: "" }
          : currentQueries
      );
      if (request.parentSessionId) {
        setExpandedSubagentParentIds((previousIds) => {
          if (previousIds.has(parentSessionId)) return previousIds;
          const nextIds = new Set(previousIds);
          nextIds.add(parentSessionId);
          return nextIds;
        });
      }
    });

    for (const sessionId of new Set([parentSessionId, request.sessionId])) {
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
    request,
    setActiveSidebarKey,
    setExpandedSubagentParentIds,
    setSelectedOrgId,
    setSidebarCollapsed,
    setSidebarSearchQueries,
    setWorkItemsOpen,
  ]);

  return { activeRequest, revealedSessionIds };
}
