import { describe, expect, it } from "vitest";

import {
  IdentitySnapshotSchema,
  getActiveIdentitySession,
} from "./identityTypes";

describe("IdentitySnapshot wire contract", () => {
  it("parses the Broker DTO and resolves the realm's active session", () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const snapshot = IdentitySnapshotSchema.parse({
      revision: 4,
      sessions: [
        {
          sessionId,
          realm: "org2_cloud",
          issuer: "https://cloud.example.test",
          subject: "user-1",
          displayName: "Ada",
          scopes: [],
          status: "offline_degraded",
          generation: 2,
        },
      ],
      activeSessions: { org2_cloud: sessionId },
      flows: [],
      secureStoreStatus: "available",
    });

    expect(getActiveIdentitySession(snapshot, "org2_cloud")?.subject).toBe(
      "user-1"
    );
  });

  it("rejects a malformed active session identifier", () => {
    expect(() =>
      IdentitySnapshotSchema.parse({
        revision: 1,
        sessions: [],
        activeSessions: { org2_cloud: "not-a-session-id" },
        flows: [],
        secureStoreStatus: "available",
      })
    ).toThrow();
  });

  it("rejects secret-bearing or unknown public snapshot fields", () => {
    expect(() =>
      IdentitySnapshotSchema.parse({
        revision: 1,
        sessions: [],
        activeSessions: {},
        flows: [],
        secureStoreStatus: "available",
        refreshToken: "must-never-cross-this-boundary",
      })
    ).toThrow();
  });
});
