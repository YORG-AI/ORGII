import { describe, expect, it } from "vitest";

import {
  Org2CloudChannelsError,
  isOrg2ChannelsErrorCode,
} from "./channelsClient";
import { CloudChannelSchema, CloudChannelsListSchema } from "./types";

describe("Org2CloudChannelsError", () => {
  it("extracts a known ORG2_* code as a whole token", () => {
    const error = new Org2CloudChannelsError(
      "ORG2_LAST_MANAGER: cannot remove the last manager",
      409
    );
    expect(error.code).toBe("ORG2_LAST_MANAGER");
    expect(isOrg2ChannelsErrorCode(error, "ORG2_LAST_MANAGER")).toBe(true);
    expect(isOrg2ChannelsErrorCode(error, "ORG2_CONFLICT")).toBe(false);
  });

  it("never substring-matches a longer future code", () => {
    const error = new Org2CloudChannelsError(
      "ORG2_CHANNEL_NOT_FOUND_SOMEDAY", // hypothetical future code
      404
    );
    expect(error.code).toBeNull();
  });

  it("maps an unrecognized message to a null code", () => {
    const error = new Org2CloudChannelsError("boom", 500);
    expect(error.code).toBeNull();
    expect(error.status).toBe(500);
  });
});

describe("channel wire schemas", () => {
  it("parses a full channel row", () => {
    const channel = CloudChannelSchema.parse({
      id: "c1",
      name: "release-notes",
      topic: "review checklist",
      visibility: "private",
      postPolicy: "managers",
      createdBy: "u1",
      createdAt: "2026-07-31T00:00:00Z",
      updatedAt: "2026-07-31T00:00:00Z",
      archivedAt: null,
      messageCount: 3,
      lastMessageAt: null,
      memberCount: 4,
      myRole: "manager",
    });
    expect(channel.visibility).toBe("private");
    expect(channel.myRole).toBe("manager");
  });

  it("degrades unknown enum values instead of failing the listing", () => {
    const channel = CloudChannelSchema.parse({
      id: "c2",
      name: "general",
      visibility: "somekind", // additive future value
      postPolicy: "somekind",
      createdAt: "2026-07-31T00:00:00Z",
      archivedAt: null,
      messageCount: 0,
      memberCount: 1,
      myRole: "somekind",
    });
    expect(channel.visibility).toBe("org");
    expect(channel.postPolicy).toBe("everyone");
    expect(channel.myRole).toBeNull();
  });

  it("defaults an absent channels array", () => {
    expect(CloudChannelsListSchema.parse({}).channels).toEqual([]);
  });
});
