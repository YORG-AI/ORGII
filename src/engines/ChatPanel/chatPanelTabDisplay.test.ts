import { describe, expect, it } from "vitest";

import type { ChatPanelTab } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { Session } from "@src/store/session";
import { WORK_MANAGEMENT_SECTION } from "@src/store/workstation";

import {
  type ChatPanelTabDisplayLabels,
  resolveChatPanelTabDisplayTitle,
} from "./chatPanelTabDisplay";

const labels: ChatPanelTabDisplayLabels = {
  newSession: "New session",
  runtime: "Runtime",
  organization: "Manage ORG",
  teamInbox: "Inbox",
  workManagement: {
    kanban: "Kanban",
    work: "Work Items",
  },
  sessionFallback: "Chat",
  channelFallback: "Channels",
};

function tab(
  type: ChatPanelTab["type"],
  title = "Launchpad",
  managementSection?: ChatPanelTab["managementSection"]
): ChatPanelTab {
  return { id: `tab-${type}`, type, title, managementSection };
}

describe("resolveChatPanelTabDisplayTitle", () => {
  it("uses the localized Runtime title", () => {
    expect(resolveChatPanelTabDisplayTitle(tab("runtime"), null, labels)).toBe(
      "Runtime"
    );
  });

  it("renders a channel tab as its bare name from its payload", () => {
    expect(
      resolveChatPanelTabDisplayTitle(
        {
          ...tab("channel", "#code-review"),
          channel: {
            scope: "local",
            channelId: "chan-1",
            name: "code-review",
          },
        },
        null,
        labels
      )
    ).toBe("code-review");
  });

  it("falls back to the Channels label for a payload-less channel tab", () => {
    expect(
      resolveChatPanelTabDisplayTitle(tab("channel", "#gone"), null, labels)
    ).toBe("Channels");
  });

  it("uses the same localized Inbox title as the sidebar", () => {
    expect(
      resolveChatPanelTabDisplayTitle(tab("team-inbox"), null, labels)
    ).toBe("Inbox");
  });

  it("keeps Work datasets under one localized tab title", () => {
    expect(
      resolveChatPanelTabDisplayTitle(tab("work-management"), null, labels)
    ).toBe("Kanban");
    expect(
      resolveChatPanelTabDisplayTitle(
        tab("work-management", "Ignored", WORK_MANAGEMENT_SECTION.PROJECTS),
        null,
        labels
      )
    ).toBe("Work Items");
    expect(
      resolveChatPanelTabDisplayTitle(
        tab(
          "work-management",
          "Ignored",
          WORK_MANAGEMENT_SECTION.GITHUB_ISSUES
        ),
        null,
        labels
      )
    ).toBe("Work Items");
    expect(
      resolveChatPanelTabDisplayTitle(
        tab("work-management", "Ignored", WORK_MANAGEMENT_SECTION.GITHUB_PRS),
        null,
        labels
      )
    ).toBe("Work Items");
  });

  it("uses the localized New session label for the start page", () => {
    expect(
      resolveChatPanelTabDisplayTitle(tab("start-page"), null, labels)
    ).toBe("New session");
  });

  it("shows the workspace name for a workspace tab", () => {
    expect(
      resolveChatPanelTabDisplayTitle(
        tab("workspace", "orgii-web"),
        null,
        labels
      )
    ).toBe("orgii-web");
  });

  it("keeps organization management distinct from Launchpad", () => {
    expect(
      resolveChatPanelTabDisplayTitle(
        tab("organization", "Manage ORG"),
        null,
        labels
      )
    ).toBe("Manage ORG");
  });

  it("uses the linked session instead of a leaked Launchpad title", () => {
    const session = {
      session_id: "session-1",
      name: "Fix tab naming",
      status: "completed",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    } as Session;

    expect(
      resolveChatPanelTabDisplayTitle(tab("session"), session, labels)
    ).toBe("Fix tab naming");
    expect(resolveChatPanelTabDisplayTitle(tab("session"), null, labels)).toBe(
      "Chat"
    );
  });
});
