import { describe, expect, it } from "vitest";

import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import {
  applyCloudReplaySharePolicy,
  assertCloudReplayPublished,
  restoreCloudReplaySharePolicy,
} from "./sharePreparation";

describe("cloud replay-share preparation", () => {
  it("promotes only the target session and restores its exact prior override", () => {
    const initial = {
      "org-1": {
        defaultMode: "off" as const,
        sessionModes: {
          other: "metadata_only" as const,
          target: "off" as const,
        },
        sessionVisibility: { target: "restricted" as const },
      },
    };

    const { next, snapshot } = applyCloudReplaySharePolicy(
      initial,
      "org-1",
      "target"
    );
    expect(next["org-1"].sessionModes).toEqual({
      other: "metadata_only",
      target: "full_replay",
    });
    expect(next["org-1"].sessionVisibility).toEqual({
      target: "restricted",
    });

    const concurrentlyChanged = {
      ...next,
      "org-1": {
        ...next["org-1"],
        sessionModes: {
          ...next["org-1"].sessionModes,
          concurrent: "full_replay" as const,
        },
      },
    };
    expect(
      restoreCloudReplaySharePolicy(
        concurrentlyChanged,
        "org-1",
        "target",
        snapshot
      )["org-1"].sessionModes
    ).toEqual({
      other: "metadata_only",
      target: "off",
      concurrent: "full_replay",
    });
  });

  it("restores org-default inheritance instead of inventing an override", () => {
    const initial = {
      "org-1": {
        defaultMode: "metadata_only" as const,
        sessionModes: {},
        sessionVisibility: {},
      },
    };
    const { next, snapshot } = applyCloudReplaySharePolicy(
      initial,
      "org-1",
      "target"
    );
    expect(next["org-1"].sessionModes.target).toBe("full_replay");
    expect(
      restoreCloudReplaySharePolicy(next, "org-1", "target", snapshot)["org-1"]
        .sessionModes
    ).toEqual({});
  });

  it("does not clobber a newer target-session policy choice", () => {
    const initial = {
      "org-1": {
        defaultMode: "off" as const,
        sessionModes: { target: "metadata_only" as const },
        sessionVisibility: {},
      },
    };
    const { next, snapshot } = applyCloudReplaySharePolicy(
      initial,
      "org-1",
      "target"
    );
    const changedWhilePublishing = {
      ...next,
      "org-1": {
        ...next["org-1"],
        sessionModes: {
          ...next["org-1"].sessionModes,
          target: "off" as const,
        },
      },
    };

    expect(
      restoreCloudReplaySharePolicy(
        changedWhilePublishing,
        "org-1",
        "target",
        snapshot
      )
    ).toBe(changedWhilePublishing);
  });

  it("accepts only a server-confirmed full replay row", () => {
    const row = {
      sourceSessionId: "target",
      ownerUserId: "owner-1",
      accessMode: "full_replay",
      eventsEpoch: 1,
      eventsCount: 0,
    } as RemoteTeammateSessionMetadata;
    expect(() =>
      assertCloudReplayPublished([row], "target", "owner-1")
    ).not.toThrow();
    expect(() =>
      assertCloudReplayPublished([row], "target", "other-owner")
    ).toThrow(/not confirmed/);
    expect(() =>
      assertCloudReplayPublished(
        [{ ...row, accessMode: "metadata_only" }],
        "target",
        "owner-1"
      )
    ).toThrow(/not confirmed/);
    expect(() =>
      assertCloudReplayPublished(
        [{ ...row, eventsCount: undefined }],
        "target",
        "owner-1"
      )
    ).toThrow(/not confirmed/);
    expect(() => assertCloudReplayPublished([], "target", "owner-1")).toThrow(
      /not confirmed/
    );
  });
});
