import { describe, expect, it } from "vitest";

import { createApiAuthFailure } from "./authFailure";

describe("createApiAuthFailure", () => {
  it.each([
    ["main", "legacy_main"],
    ["agent", "agent_runtime"],
    ["hostedService", "hosted_service_legacy"],
  ] as const)(
    "keeps %s authentication failures in their realm",
    (target, realm) => {
      expect(createApiAuthFailure(target, 401)).toEqual({
        realm,
        sessionId: null,
        target,
        status: 401,
        reason: "unauthorized",
      });
    }
  );

  it("distinguishes expired credentials from authorization denial", () => {
    expect(
      createApiAuthFailure("hostedService", 403, "Expired token").reason
    ).toBe("credential_expired");
    expect(createApiAuthFailure("agent", 403, "Role missing").reason).toBe(
      "forbidden"
    );
  });

  it("binds a hosted failure to the session that started the request", () => {
    expect(
      createApiAuthFailure(
        "hostedService",
        401,
        "Expired token",
        "00000000-0000-4000-8000-000000000001"
      ).sessionId
    ).toBe("00000000-0000-4000-8000-000000000001");
  });
});
