import { describe, expect, it } from "vitest";

import { buildCloudRemoteItemId } from "@src/features/Org2Cloud/cloudRemoteItemId";
import {
  CLOUD_MY_SESSIONS_SECTION_ID,
  CLOUD_TEAM_SESSIONS_SECTION_ID,
} from "@src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/cloudScopedMenuItems";

import {
  mapWebRosterStatusToCloudFetchState,
  resolveWebCloudSessionMenuItemId,
  splitWebCloudSessionRows,
} from "../useWebCloudSessionsSection";

describe("mapWebRosterStatusToCloudFetchState", () => {
  it("maps empty loading roster to loading", () => {
    expect(mapWebRosterStatusToCloudFetchState("loading", false)).toBe(
      "loading"
    );
  });

  it("maps refresh-with-cache to ready", () => {
    expect(mapWebRosterStatusToCloudFetchState("loading", true)).toBe("ready");
  });

  it("maps hard error without cache to error", () => {
    expect(mapWebRosterStatusToCloudFetchState("error", false)).toBe("error");
  });
});

describe("resolveWebCloudSessionMenuItemId", () => {
  it("uses the same cloudremote id scheme as desktop", () => {
    expect(
      resolveWebCloudSessionMenuItemId({ orgId: "org-1", id: "session-1" })
    ).toBe(buildCloudRemoteItemId("org-1", "session-1"));
  });

  it("returns undefined when no session is active", () => {
    expect(resolveWebCloudSessionMenuItemId(null)).toBeUndefined();
  });
});

describe("splitWebCloudSessionRows", () => {
  it("routes viewer-owned rows to My sessions and others to Team sessions", () => {
    const rows = [
      { ownerUserId: "user-1", id: "a" },
      { ownerUserId: "user-2", id: "b" },
      { ownerUserId: "user-1", id: "c" },
    ];
    expect(splitWebCloudSessionRows(rows, "user-1")).toEqual({
      ownRows: [
        { ownerUserId: "user-1", id: "a" },
        { ownerUserId: "user-1", id: "c" },
      ],
      teamRows: [{ ownerUserId: "user-2", id: "b" }],
    });
  });
});

describe("web cloud sidebar section ids", () => {
  it("keeps the desktop Team Sessions section id", () => {
    expect(CLOUD_TEAM_SESSIONS_SECTION_ID).toBe("cloud-team-sessions");
  });

  it("keeps the desktop My Sessions section id", () => {
    expect(CLOUD_MY_SESSIONS_SECTION_ID).toBe("cloud-my-sessions");
  });
});
