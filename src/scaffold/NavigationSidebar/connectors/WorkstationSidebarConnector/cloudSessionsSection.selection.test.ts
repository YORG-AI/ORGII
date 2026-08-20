import { describe, expect, it } from "vitest";

import { resolveCloudDownloadMenuItemId } from "./cloudSessionsSection.selection";

const PENDING_PLAY = {
  rowId: "remote-row-1",
  orgId: "org-1",
  iconId: "codex",
  pendingEvents: 953,
  etaMs: 20_000,
  kind: "replay" as const,
};

describe("resolveCloudDownloadMenuItemId", () => {
  it("selects the exact remote sidebar row before local import", () => {
    expect(resolveCloudDownloadMenuItemId("org-1", PENDING_PLAY)).toBe(
      "cloudremote-org-1|remote-row-1"
    );
  });

  it("keeps the remote row selected while its transcript downloads", () => {
    expect(
      resolveCloudDownloadMenuItemId("org-1", {
        rowId: "remote-row-1",
        orgId: "org-1",
      })
    ).toBe("cloudremote-org-1|remote-row-1");
  });

  it("does not highlight the row in another organization", () => {
    expect(resolveCloudDownloadMenuItemId("org-2", PENDING_PLAY)).toBeNull();
  });
});
