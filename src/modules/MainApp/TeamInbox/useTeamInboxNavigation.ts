import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";

import {
  enrichedWorkItemToUI,
  projectApi,
  standaloneWorkItemDataToEnriched,
} from "@src/api/http/project";
import { createLogger } from "@src/hooks/logger";
import {
  openOrFocusSessionInChatPanelTabAtom,
  openWorkItemInChatPanelTabAtom,
  requestChatPanelWorkItemActionAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { sessionsAtom } from "@src/store/session";

import type { TeamInboxNavigationIntent } from "./domain";

const log = createLogger("TeamInboxNavigation");

export function useTeamInboxNavigation(): (
  intent: TeamInboxNavigationIntent
) => void {
  const sessions = useAtomValue(sessionsAtom);
  const openSession = useSetAtom(openOrFocusSessionInChatPanelTabAtom);
  const openWorkItem = useSetAtom(openWorkItemInChatPanelTabAtom);
  const requestWorkItemAction = useSetAtom(requestChatPanelWorkItemActionAtom);

  return useCallback(
    (intent: TeamInboxNavigationIntent) => {
      if (
        intent.kind === "open_session" ||
        intent.kind === "open_session_comment"
      ) {
        const session = sessions.find(
          (candidate) => candidate.session_id === intent.sessionId
        );
        openSession({
          sessionId: intent.sessionId,
          sessionName: session?.name,
          repoPath: session?.repoPath,
        });
        if (intent.kind === "open_session_comment") {
          window.requestAnimationFrame(() => {
            document
              .getElementById(intent.anchor ?? `comment-${intent.commentId}`)
              ?.scrollIntoView({ block: "center", behavior: "smooth" });
          });
        }
        return;
      }

      const openResolvedWorkItem = (
        workItem: Awaited<ReturnType<typeof projectApi.readStandaloneWorkItem>>,
        project?: Awaited<ReturnType<typeof projectApi.readProject>>
      ) => {
        const shortId = workItem.frontmatter.short_id;
        openWorkItem({
          workItem: enrichedWorkItemToUI(
            standaloneWorkItemDataToEnriched(workItem)
          ),
          shortId,
          projectId: project?.meta.id ?? "",
          projectSlug: project?.slug ?? "",
          projectName: project?.meta.name ?? "Standalone",
          orgId: project?.meta.org_id,
        });
        if (intent.action) {
          requestWorkItemAction({
            workItemShortId: shortId,
            action: intent.action,
          });
        }
      };

      if (!intent.projectId) {
        void projectApi
          .readStandaloneWorkItem(intent.workItemId)
          .then((workItem) => openResolvedWorkItem(workItem))
          .catch((error: unknown) => {
            log.warn("Failed to open standalone Team Inbox Work Item", error);
          });
        return;
      }

      void Promise.all([
        projectApi.readProject(intent.projectId),
        projectApi.readWorkItem(intent.projectId, intent.workItemId),
      ])
        .then(([project, workItem]) => openResolvedWorkItem(workItem, project))
        .catch((error: unknown) => {
          log.warn("Failed to open project Team Inbox Work Item", error);
        });
    },
    [openSession, openWorkItem, requestWorkItemAction, sessions]
  );
}
