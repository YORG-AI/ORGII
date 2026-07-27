import { describe, expect, it } from "vitest";

import {
  buildCloudSessionMetadata,
  isCloudPushCandidate,
} from "./org2CloudSyncEngine";
import { SCOPE_KEY, SESSION } from "./org2CloudSyncEngine.testUtils";

describe("buildCloudSessionMetadata", () => {
  it("mirrors the toRemoteMetadata shape with the cloud user as owner", () => {
    const metadata = buildCloudSessionMetadata(
      SESSION,
      "corg-1",
      "user-1",
      "Me",
      SCOPE_KEY,
      { accessMode: "full_replay", visibility: "org" },
      "https://example.com/me.png"
    );
    expect(metadata.id).toBe("corg-1:user-1:session-1");
    expect(metadata.orgId).toBe("corg-1");
    expect(metadata.ownerMemberId).toBe("user-1");
    expect(metadata.ownerAvatarUrl).toBe("https://example.com/me.png");
    expect(metadata.repoScopeKey).toBe(SCOPE_KEY);
    expect(metadata.accessMode).toBe("full_replay");
    expect(metadata.replayLevel).toBe("replay");
    expect(metadata.visibility).toBe("org");
  });

  it("carries the ladder outcome onto the wire (metadata_only + restricted)", () => {
    const metadata = buildCloudSessionMetadata(
      SESSION,
      "corg-1",
      "user-1",
      "Me",
      SCOPE_KEY,
      { accessMode: "metadata_only", visibility: "restricted" }
    );
    expect(metadata.accessMode).toBe("metadata_only");
    expect(metadata.replayLevel).toBe("metadata");
    expect(metadata.visibility).toBe("restricted");
  });
});

describe("isCloudPushCandidate", () => {
  it("excludes only imported teammate copies; the user's own external history is shareable", () => {
    expect(isCloudPushCandidate(SESSION)).toBe(true);
    // Imported teammate copy (pulled from the cloud) — excluded (echo-loop).
    expect(
      isCloudPushCandidate({
        ...SESSION,
        importedFrom: { orgId: "x" } as never,
      })
    ).toBe(false);
    // The user's OWN external history (no importedFrom) is now shareable.
    expect(
      isCloudPushCandidate({ ...SESSION, category: "external_history" })
    ).toBe(true);
    // External history that is ALSO an imported copy stays excluded.
    expect(
      isCloudPushCandidate({
        ...SESSION,
        category: "external_history",
        importedFrom: { orgId: "x" } as never,
      })
    ).toBe(false);
  });
});
