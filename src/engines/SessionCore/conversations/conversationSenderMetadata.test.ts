import { describe, expect, it } from "vitest";

import {
  CONVERSATION_SENDER_ARG,
  conversationSenderStampOf,
  resolveConversationSenderRelationship,
  resolveConversationViewerState,
} from "./conversationSenderMetadata";

describe("conversationSenderStampOf", () => {
  it("normalizes a valid provider-neutral sender stamp", () => {
    expect(
      conversationSenderStampOf({
        args: {
          [CONVERSATION_SENDER_ARG]: {
            userId: "  user-1  ",
            displayName: "  Ada Lovelace  ",
            avatarUrl: "  https://example.com/ada.png  ",
          },
        },
      })
    ).toEqual({
      userId: "user-1",
      displayName: "Ada Lovelace",
      avatarUrl: "https://example.com/ada.png",
    });
  });

  it("keeps a stable account id while omitting blank presentation fields", () => {
    expect(
      conversationSenderStampOf({
        args: {
          [CONVERSATION_SENDER_ARG]: {
            userId: "user-2",
            displayName: "   ",
            avatarUrl: "",
          },
        },
      })
    ).toEqual({ userId: "user-2" });
  });

  it("rejects unstamped and malformed metadata", () => {
    expect(conversationSenderStampOf({ args: {} })).toBeNull();
    expect(
      conversationSenderStampOf({
        args: {
          [CONVERSATION_SENDER_ARG]: {
            userId: " ",
            displayName: "Invented user",
          },
        },
      })
    ).toBeNull();
  });
});

describe("conversation viewer ownership", () => {
  it("keeps pre-hydration ownership unresolved instead of treating null as logout", () => {
    const viewer = resolveConversationViewerState(null, false);

    expect(viewer).toEqual({ status: "loading" });
    expect(
      resolveConversationSenderRelationship({ userId: "viewer" }, viewer)
    ).toBe("unresolved");
    expect(
      resolveConversationSenderRelationship({ userId: "remote" }, viewer)
    ).toBe("unresolved");
  });

  it("compares stamps only after the viewer identity hydrates", () => {
    const viewer = resolveConversationViewerState(" viewer ", false);

    expect(viewer).toEqual({ status: "known", userId: "viewer" });
    expect(
      resolveConversationSenderRelationship({ userId: "viewer" }, viewer)
    ).toBe("viewer");
    expect(
      resolveConversationSenderRelationship({ userId: "remote" }, viewer)
    ).toBe("other");
  });

  it("distinguishes a completed signed-out state from loading", () => {
    const viewer = resolveConversationViewerState(null, true);

    expect(viewer).toEqual({ status: "signed_out" });
    expect(
      resolveConversationSenderRelationship({ userId: "remote" }, viewer)
    ).toBe("other");
    expect(resolveConversationSenderRelationship(null, viewer)).toBe(
      "unstamped"
    );
  });
});
