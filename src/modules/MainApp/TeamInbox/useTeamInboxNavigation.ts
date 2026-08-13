import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import {
  enrichedWorkItemToUI,
  projectApi,
  standaloneWorkItemDataToEnriched,
} from "@src/api/http/project";
import { createLogger } from "@src/hooks/logger";
import {
  openOrFocusSessionInChatPanelTabAtom,
  openWorkItemInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { sessionsAtom } from "@src/store/session";

import type { TeamInboxNavigationIntent } from "./domain";

const log = createLogger("TeamInboxNavigation");

export function useTeamInboxNavigation(): (
  intent: TeamInboxNavigationIntent
) => void {
  const { t } = useTranslation();
  const sessions = useAtomValue(sessionsAtom);
  const openSession = useSetAtom(openOrFocusSessionInChatPanelTabAtom);
  const openWorkItem = useSetAtom(openWorkItemInChatPanelTabAtom);

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
          projectId: project?.meta.id ?? intent.projectId ?? "",
          projectSlug: project?.slug ?? intent.projectId ?? "",
          projectName:
            project?.meta.name ??
            intent.projectId ??
            t("teamInbox.detail.standaloneProject"),
          orgId: project?.meta.org_id ?? intent.orgId,
        });
      };

      if (!intent.projectId) {
        void projectApi
          .readStandaloneWorkItem(
            intent.workItemId,
            intent.orgId ? { orgId: intent.orgId } : undefined
          )
          .then((workItem) => openResolvedWorkItem(workItem))
          .catch((error: unknown) => {
            log.warn("Failed to open standalone Team Inbox Work Item", error);
          });
        return;
      }

      void Promise.allSettled([
        projectApi.readProject(intent.projectId),
        projectApi.readWorkItem(intent.projectId, intent.workItemId),
      ])
        .then(([projectResult, workItemResult]) => {
          if (workItemResult.status === "rejected") {
            throw workItemResult.reason;
          }
          if (projectResult.status === "rejected") {
            log.warn(
              "Opening Team Inbox Work Item without project metadata",
              projectResult.reason
            );
          }
          openResolvedWorkItem(
            workItemResult.value,
            projectResult.status === "fulfilled"
              ? projectResult.value
              : undefined
          );
        })
        .catch((error: unknown) => {
          log.warn("Failed to open project Team Inbox Work Item", error);
        });
    },
    [openSession, openWorkItem, sessions, t]
  );
}
