import { describe, expect, it } from "vitest";

import type { ConversationRootLocator } from "@src/engines/SessionCore/conversations/conversationTypes";

import { SubmitValidationError } from "../useInputArea/types";
import {
  buildCanonicalConversationDispatch,
  canonicalConversationTargetOrThrow,
} from "./useConversationSubmitRouter";

const root: ConversationRootLocator = {
  authority: "imported-history",
  authorityScope: ["codex_app"],
  conversationId: "codexapp-session-1",
};

describe("canonicalConversationTargetOrThrow", () => {
  it("allows an ordinary session to use its existing direct dispatcher", () => {
    expect(canonicalConversationTargetOrThrow(null, null)).toBeNull();
  });

  it("never routes a canonical source through the legacy direct dispatcher", () => {
    expect(() => canonicalConversationTargetOrThrow(root, null)).toThrow(
      SubmitValidationError
    );
  });

  it("returns the selected canonical runtime", () => {
    const target = {
      cliAgentType: "codex",
      accountId: "openai",
      model: "gpt-test",
      workspaceRepoPath: "/repo",
    } as const;
    expect(canonicalConversationTargetOrThrow(root, target)).toBe(target);
  });
});

describe("buildCanonicalConversationDispatch", () => {
  const target = {
    cliAgentType: "codex" as const,
    accountId: "openai-1",
    model: "gpt-5.6-sol",
  };

  it("carries the current root and runtime for a local canonical retry", () => {
    expect(
      buildCanonicalConversationDispatch({
        root: {
          authority: "local-session",
          authorityScope: [],
          conversationId: "s-1",
        },
        selectedTarget: target,
        auth: null,
      })
    ).toEqual({
      kind: "canonical_conversation",
      root: {
        authority: "local-session",
        authorityScope: [],
        conversationId: "s-1",
      },
      target,
    });
  });

  it("binds a Cloud retry to the signed-in identity and returns null without it", () => {
    const cloudRoot: ConversationRootLocator = {
      authority: "org2-cloud",
      authorityScope: ["https://cloud.example", "org-1"],
      conversationId: "s-1",
    };
    expect(
      buildCanonicalConversationDispatch({
        root: cloudRoot,
        selectedTarget: target,
        auth: null,
      })
    ).toBeNull();
    expect(
      buildCanonicalConversationDispatch({
        root: cloudRoot,
        selectedTarget: target,
        auth: {
          kind: "org2_cloud",
          supabaseUrl: "https://cloud.example",
          supabaseAnonKey: "anon",
          userId: "user-1",
          accessToken: "token",
          refreshToken: "refresh",
          expiresAt: 0,
        } as never,
      })?.dispatchIdentityKey
    ).toBe("https://cloud.example|user-1");
  });

  it("returns null while no canonical runtime is selected", () => {
    expect(
      buildCanonicalConversationDispatch({
        root: {
          authority: "local-session",
          authorityScope: [],
          conversationId: "s-1",
        },
        selectedTarget: null,
        auth: null,
      })
    ).toBeNull();
    expect(
      buildCanonicalConversationDispatch({
        root: null,
        selectedTarget: target,
        auth: null,
      })
    ).toBeNull();
  });
});
