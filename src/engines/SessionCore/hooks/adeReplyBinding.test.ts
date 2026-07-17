import { describe, expect, it } from "vitest";

import { ACTION_ID } from "@src/ActionSystem/actionIds";

import {
  extractInvokingSessionId,
  resolveTrustedDispatchParams,
} from "./adeReplyBinding";

describe("extractInvokingSessionId", () => {
  it("reads a string invokingSessionId from the envelope", () => {
    expect(extractInvokingSessionId({ invokingSessionId: "ls-owner" })).toBe(
      "ls-owner"
    );
  });

  it("reads an empty string as an empty string", () => {
    expect(extractInvokingSessionId({ invokingSessionId: "" })).toBe("");
  });

  it("returns undefined when absent or non-string", () => {
    expect(extractInvokingSessionId({})).toBeUndefined();
    expect(extractInvokingSessionId({ invokingSessionId: 42 })).toBeUndefined();
  });
});

describe("resolveTrustedDispatchParams", () => {
  it("overwrites an agent-supplied localSessionId with the trusted envelope id", () => {
    const spoofed = {
      commentId: "b-1",
      body: "forged",
      localSessionId: "ls-victim",
    };
    const resolved = resolveTrustedDispatchParams(
      ACTION_ID.SESSION_REPLY_COMMENT,
      spoofed,
      "ls-owner"
    );
    expect(resolved.localSessionId).toBe("ls-owner");
    expect(resolved.commentId).toBe("b-1");
    expect(resolved.body).toBe("forged");
  });

  it("forces localSessionId empty when the envelope carries no trusted id (raw control_orgii dispatch)", () => {
    const spoofed = {
      commentId: "b-1",
      body: "forged",
      localSessionId: "ls-victim",
    };
    expect(
      resolveTrustedDispatchParams(
        ACTION_ID.SESSION_REPLY_COMMENT,
        spoofed,
        undefined
      ).localSessionId
    ).toBe("");
    expect(
      resolveTrustedDispatchParams(ACTION_ID.SESSION_REPLY_COMMENT, spoofed, "")
        .localSessionId
    ).toBe("");
  });

  it("does not add a localSessionId to non-reply actions", () => {
    const params = { foo: "bar" };
    const resolved = resolveTrustedDispatchParams(
      ACTION_ID.GUI_EXECUTE,
      params,
      "ls-owner"
    );
    expect(resolved).toBe(params);
    expect(resolved.localSessionId).toBeUndefined();
  });
});
