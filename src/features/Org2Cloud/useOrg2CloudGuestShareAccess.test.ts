import { describe, expect, it } from "vitest";

import type { Session } from "@src/store/session/sessionAtom/types";

import { Org2CloudShareError } from "./org2CloudSharesClient";
import {
  guestShareCapabilities,
  isDefinitiveGuestShareRevocation,
} from "./useOrg2CloudGuestShareAccess";

function session(
  sessionId: string,
  shareToken?: string,
  shareEndpointUrl?: string
): Session {
  return {
    session_id: sessionId,
    status: "completed",
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    name: sessionId,
    ...(shareToken
      ? {
          importedFrom: {
            orgId: "org-1",
            sourceSessionId: "source-1",
            ownerMemberId: "owner-1",
            epoch: 1,
            seq: 0,
            count: 1,
            shareToken,
            shareEndpointUrl,
          },
        }
      : {}),
  } as Session;
}

describe("guestShareCapabilities", () => {
  it("returns only durable guest imports and preserves endpoint provenance", () => {
    expect(
      guestShareCapabilities([
        session("native"),
        session("guest", "token-1", "https://cloud.example.com"),
      ])
    ).toEqual([
      {
        sessionId: "guest",
        shareToken: "token-1",
        shareEndpointUrl: "https://cloud.example.com",
      },
    ]);
  });
});

describe("isDefinitiveGuestShareRevocation", () => {
  it("evicts only the opaque capability rejection", () => {
    expect(
      isDefinitiveGuestShareRevocation(
        new Org2CloudShareError("ORG2_UNAUTHORIZED", 403)
      )
    ).toBe(true);
    expect(isDefinitiveGuestShareRevocation(new TypeError("offline"))).toBe(
      false
    );
    expect(
      isDefinitiveGuestShareRevocation(
        new Org2CloudShareError("server exploded", 500)
      )
    ).toBe(false);
  });
});
