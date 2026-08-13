import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  makeChatItem,
  makeSessionEvent,
} from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";
import { namespaceCopyEventId } from "@src/features/TeamCollaboration/copyEventId";

import { SharedConversationSenderProvider } from "./SharedConversationSenderContext";
import UserChatItem from "./UserChatItem";

function renderMessage(id: string): string {
  const sessionId = "agentsession-local";
  const event = makeSessionEvent({
    id,
    sessionId,
    source: "user",
    actionType: "raw",
    functionName: "user_message",
    displayText: "Hello from the conversation owner",
    displayVariant: "message",
  });

  return renderToStaticMarkup(
    createElement(
      SharedConversationSenderProvider,
      {
        value: {
          displayName: "Ada Lovelace",
          avatarUrl: "https://example.com/ada.png",
        },
      },
      createElement(UserChatItem, { chatItem: makeChatItem(event) })
    )
  );
}

describe("UserChatItem shared sender presentation", () => {
  it("shows the owner avatar beside a copied remote message", () => {
    const sessionId = "agentsession-local";
    const markup = renderMessage(
      namespaceCopyEventId(sessionId, "user-message-remote")
    );

    expect(markup).toContain('data-message-side="left"');
    expect(markup).toContain('data-testid="shared-message-sender-avatar"');
    expect(markup).toContain('title="Ada Lovelace"');
    expect(markup).toContain('src="https://example.com/ada.png"');
    expect(markup).toContain("background-color:var(--color-fill-2)");
  });

  it("does not show a remote sender avatar for a local message", () => {
    const markup = renderMessage("user-message-local");

    expect(markup).toContain('data-message-side="right"');
    expect(markup).not.toContain("shared-message-sender-avatar");
  });
});
