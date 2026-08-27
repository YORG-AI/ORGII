import { SESSION_CONFIG } from "@src/config/sessionCreatorConfig";
import type { ChatPanelTab } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { Session } from "@src/store/session";
import { WORK_MANAGEMENT_SECTION } from "@src/store/workstation";
import { stripPillReferences } from "@src/util/session/stripPillReferences";

export interface ChatPanelTabDisplayLabels {
  newSession: string;
  runtime: string;
  organization: string;
  teamInbox: string;
  workManagement: {
    kanban: string;
    work: string;
  };
  sessionFallback: string;
  channelFallback: string;
}

function resolveWorkManagementTabTitle(
  tab: ChatPanelTab,
  labels: ChatPanelTabDisplayLabels["workManagement"]
): string {
  switch (tab.managementSection) {
    case WORK_MANAGEMENT_SECTION.PROJECTS:
    case WORK_MANAGEMENT_SECTION.GITHUB_ISSUES:
    case WORK_MANAGEMENT_SECTION.GITHUB_PRS:
      return labels.work;
    case WORK_MANAGEMENT_SECTION.KANBAN:
    default:
      return labels.kanban;
  }
}

/** Resolve a pill label only from that tab's identity and linked entity. */
export function resolveChatPanelTabDisplayTitle(
  tab: ChatPanelTab,
  session: Session | null | undefined,
  labels: ChatPanelTabDisplayLabels
): string {
  switch (tab.type) {
    case "start-page":
      return labels.newSession;
    case "runtime":
      return labels.runtime;
    case "team-inbox":
      return labels.teamInbox;
    case "work-management":
      return resolveWorkManagementTabTitle(tab, labels.workManagement);
    case "session": {
      const sessionName =
        session?.name && session.name !== SESSION_CONFIG.DEFAULT_SESSION_NAME
          ? session.name
          : undefined;
      return (
        sessionName ||
        stripPillReferences(session?.user_input || "") ||
        (tab.title === "Launchpad" ? labels.sessionFallback : tab.title)
      );
    }
    case "terminal":
      return tab.title;
    case "workspace":
      // The workspace name is stamped onto the tab at open time.
      return tab.title;
    case "organization":
      return tab.title || labels.organization;
    case "channel":
      // Bare name: the pill already renders a #/lock icon, and a private
      // channel with a lock icon must not carry a "#" glyph. The fallback
      // only covers a payload-less persisted row.
      return tab.channel ? tab.channel.name : labels.channelFallback;
    case "work-item":
    case "github-issue":
    case "github-pr":
    case "project":
    case "explore":
    case "run-group":
      // Each of these tabs stamps its entity / surface name onto `tab.title`
      // at open time, so the stored title is the correct pill label. A run
      // group's title is the opening words of its shared prompt.
      return tab.title;
  }
}
