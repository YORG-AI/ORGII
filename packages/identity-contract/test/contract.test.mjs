import assert from "node:assert/strict";
import test from "node:test";

import {
  IDENTITY_CONTRACT_VERSION,
  IdentitySnapshotSchema,
} from "../dist/index.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

test("publishes the strict v1 non-secret snapshot contract", () => {
  assert.equal(IDENTITY_CONTRACT_VERSION, 1);
  const snapshot = IdentitySnapshotSchema.parse({
    revision: 42,
    sessions: [
      {
        sessionId: SESSION_ID,
        realm: "org2_cloud",
        issuer: "https://project.supabase.co",
        subject: SESSION_ID,
        primaryEmail: "person@example.test",
        scopes: ["openid", "email"],
        expiresAtUnix: 2_000_000_000,
        status: "ready",
        generation: 42,
      },
    ],
    activeSessions: { org2_cloud: SESSION_ID },
    flows: [],
    secureStoreStatus: "available",
  });

  assert.equal(snapshot.sessions[0]?.subject, SESSION_ID);
});

test("rejects unknown credential-shaped fields at the public boundary", () => {
  assert.throws(() =>
    IdentitySnapshotSchema.parse({
      revision: 0,
      sessions: [],
      activeSessions: {},
      flows: [],
      secureStoreStatus: "unavailable",
      refreshToken: "must-not-cross-the-wire",
    }),
  );
});
