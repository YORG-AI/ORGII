import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

import { projectApi, workItemDataToUI } from "@src/api/http/project";
import { ROUTES } from "@src/config/routes";
import { createLogger } from "@src/hooks/logger";
import {
  openOrFocusSessionInChatPanelTabAtom,
  openWorkItemInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { sessionsAtom } from "@src/store/session";
import { activeStationChatVisibleAtom } from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";

const log = createLogger("RoutineResultNavigation");
const EMPTY_RELATION_MAPS = {
  labelMap: new Map(),
  memberMap: new Map(),
};

export interface RoutineResultTarget {
  sessionId?: string;
  workItemId?: string;
  projectSlug?: string;
}

/** Open a durable Routine result in My Station. */
export function useRoutineResultNavigation(): (
  target: RoutineResultTarget
) => Promise<void> {
  const navigate = useNavigate();
  const sessions = useAtomValue(sessionsAtom);
  const openSession = useSetAtom(openOrFocusSessionInChatPanelTabAtom);
  const openWorkItem = useSetAtom(openWorkItemInChatPanelTabAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);

  return useCallback(
    async (target: RoutineResultTarget) => {
      setStationMode("my-station");
      setStationChatVisible("my-station", true);

      if (target.sessionId) {
        const session = sessions.find(
          (candidate) => candidate.session_id === target.sessionId
        );
        openSession({
          sessionId: target.sessionId,
          sessionName: session?.name,
          repoPath: session?.repoPath,
        });
        navigate(ROUTES.workStation.base.path);
        return;
      }

      if (!target.workItemId) return;

      try {
        if (target.projectSlug) {
          const [projectResult, workItemResult] = await Promise.allSettled([
            projectApi.readProject(target.projectSlug),
            projectApi.readWorkItem(target.projectSlug, target.workItemId),
          ]);
          if (workItemResult.status === "rejected") {
            throw workItemResult.reason;
          }
          const project =
            projectResult.status === "fulfilled"
              ? projectResult.value
              : undefined;
          openWorkItem({
            workItem: workItemDataToUI(
              workItemResult.value,
              EMPTY_RELATION_MAPS
            ),
            shortId: workItemResult.value.frontmatter.short_id,
            projectId: project?.meta.id ?? target.projectSlug,
            projectSlug: project?.slug ?? target.projectSlug,
            projectName: project?.meta.name ?? target.projectSlug,
            orgId: project?.meta.org_id,
          });
          navigate(ROUTES.workStation.base.path);
          return;
        }

        const workItem = await projectApi.readStandaloneWorkItem(
          target.workItemId
        );
        openWorkItem({
          workItem: workItemDataToUI(workItem, EMPTY_RELATION_MAPS),
          shortId: workItem.frontmatter.short_id,
          projectId: "",
          projectSlug: "",
          projectName: "Standalone Work Items",
        });
        navigate(ROUTES.workStation.base.path);
      } catch (error) {
        log.warn("Failed to open Routine result", error);
        throw error;
      }
    },
    [
      navigate,
      openSession,
      openWorkItem,
      sessions,
      setStationChatVisible,
      setStationMode,
    ]
  );
}
