import { describe, expect, it } from "vitest";

import {
  readIdentitySnapshot,
  replaceIdentitySnapshot,
} from "./identitySnapshotAtom";
import type { IdentitySnapshot } from "./identityTypes";

function snapshot(revision: number, subject: string): IdentitySnapshot {
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";
  return {
    revision,
    sessions: [
      {
        sessionId,
        realm: "org2_cloud",
        issuer: "https://cloud.example.test",
        subject,
        scopes: [],
        status: "offline_degraded",
        generation: 1,
      },
    ],
    activeSessions: { org2_cloud: sessionId },
    flows: [],
    secureStoreStatus: "available",
  };
}

describe("identity snapshot mirror", () => {
  it("never lets an older snapshot replace a newer Broker revision", () => {
    const baseRevision = readIdentitySnapshot().revision + 10;
    expect(replaceIdentitySnapshot(snapshot(baseRevision, "new"))).toBe(true);
    expect(replaceIdentitySnapshot(snapshot(baseRevision - 1, "old"))).toBe(
      false
    );
    expect(readIdentitySnapshot().sessions[0]?.subject).toBe("new");
  });
});
