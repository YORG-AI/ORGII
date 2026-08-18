import { beforeEach, describe, expect, it } from "vitest";

import { readIdentitySnapshot } from "./identitySnapshotAtom";
import type { IdentitySnapshot } from "./identityTypes";
import {
  SIGN_IN_INTENT_TTL_MS,
  bindBrokerSignInIntent,
  bindLegacySignInIntent,
  clearSignInIntent,
  isAllowedSignInIntent,
  peekSignInIntent,
  resolveSignInIntent,
  stageSignInIntent,
} from "./signInIntent";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const FLOW_ID = "00000000-0000-4000-8000-000000000010";

function readySnapshot(
  revision: number,
  generation: number,
  includeFlow = false
): IdentitySnapshot {
  return {
    revision,
    sessions: [
      {
        sessionId: SESSION_ID,
        realm: "org2_cloud",
        issuer: "https://cloud.example.test",
        subject: "user-1",
        scopes: ["openid"],
        status: "ready",
        generation,
      },
    ],
    activeSessions: { org2_cloud: SESSION_ID },
    flows: includeFlow
      ? [
          {
            flowId: FLOW_ID,
            realm: "org2_cloud",
            phase: "awaiting_callback",
            generation,
          },
        ]
      : [],
    secureStoreStatus: "available",
  };
}

beforeEach(() => clearSignInIntent());

describe("sign-in intent", () => {
  it("accepts only allowlisted, non-secret internal shapes", () => {
    expect(
      isAllowedSignInIntent({
        kind: "resume_route",
        path: "/orgii/workstation?panel=cloud#activity",
      })
    ).toBe(true);
    expect(
      isAllowedSignInIntent({
        kind: "resume_route",
        path: "https://evil.example/steal",
      })
    ).toBe(false);
    expect(
      isAllowedSignInIntent({ kind: "resume_route", path: "//evil.example" })
    ).toBe(false);
    expect(
      isAllowedSignInIntent({
        kind: "accept_invite",
        inviteId: "contains raw spaces",
      })
    ).toBe(false);
  });

  it("waits for its exact Broker flow to finish, then consumes once", () => {
    const ticket = stageSignInIntent({ kind: "create_org" }, 1_000);
    expect(bindBrokerSignInIntent(ticket, FLOW_ID, 7)).toBe(true);
    expect(resolveSignInIntent(readySnapshot(2, 7, true), 1_001)).toBeNull();
    expect(resolveSignInIntent(readySnapshot(3, 6), 1_002)).toBeNull();
    expect(resolveSignInIntent(readySnapshot(4, 7), 1_003)).toEqual({
      kind: "create_org",
    });
    expect(resolveSignInIntent(readySnapshot(5, 7), 1_004)).toBeNull();
  });

  it("expires without resolving and legacy completion requires a newer revision", () => {
    const stagedRevision = readIdentitySnapshot().revision;
    const ticket = stageSignInIntent(
      { kind: "import_share", shareId: "pending-share" },
      2_000
    );
    bindLegacySignInIntent(ticket);
    expect(
      resolveSignInIntent(readySnapshot(stagedRevision, 1), 2_001)
    ).toBeNull();
    expect(peekSignInIntent(2_000 + SIGN_IN_INTENT_TTL_MS)).toBeNull();
  });
});
