/**
 * Resolve one chat-pane tab's label the way its pill does.
 *
 * Shared by the tab strip and the collapsed 40px header, which names the lone
 * surface once the pill it would have duplicated is gone. Keeping the label
 * (and the Launchpad's creator-target override) in one hook is what stops the
 * two rows from drifting apart.
 */
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";

import type { ChatPanelTab } from "@src/store/chatPanel/chatPanelTabsAtom";
import { sessionByIdAtom } from "@src/store/session";
import {
  CHAT_PANEL_CREATE_TARGET,
  chatPanelCreateTargetAtom,
} from "@src/store/ui/chatPanelAtom";

import { resolveChatPanelTabDisplayTitle } from "../chatPanelTabDisplay";

export function useChatPanelTabDisplayTitle(tab: ChatPanelTab): string {
  const { t } = useTranslation(["sessions", "navigation", "projects"]);
  const createTarget = useAtomValue(chatPanelCreateTargetAtom);
  const session = useAtomValue(sessionByIdAtom(tab.sessionId ?? ""));

  const defaultDisplayTitle = resolveChatPanelTabDisplayTitle(tab, session, {
    newSession: t("sessions:chat.startPage.newSession.title"),
    runtime: t("sessions:chat.startPage.tabs.runtime"),
    organization: t("navigation:collaboration.manageOrg"),
    teamInbox: t("navigation:labels.inbox"),
    channelFallback: t("navigation:cloud.channels.title"),
    workManagement: {
      kanban: t("sessions:simulator.tabs.kanban"),
      inbox: t("navigation:labels.inbox"),
      work: t("navigation:labels.workItems"),
    },
    sessionFallback: t("sessions:chat.defaultTitle"),
  });

  if (tab.type !== "start-page") return defaultDisplayTitle;

  switch (createTarget) {
    case CHAT_PANEL_CREATE_TARGET.PROJECT:
      return t("sessions:creator.createTarget.project");
    case CHAT_PANEL_CREATE_TARGET.WORK_ITEM:
      return t("sessions:creator.createTarget.workItem");
    default:
      return defaultDisplayTitle;
  }
}
