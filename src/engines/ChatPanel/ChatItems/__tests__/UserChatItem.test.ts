import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  makeChatItem,
  makeSessionEvent,
} from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";
import { namespaceCopyEventId } from "@src/features/TeamCollaboration/copyEventId";

import { SharedConversationSenderProvider } from "../SharedConversationSenderContext";
import UserChatItem from "../UserChatItem";

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

describe("UserChatItem raw prompt affordance", () => {
  function renderUserMessage(
    overrides: Parameters<typeof makeSessionEvent>[0]
  ): string {
    return renderToStaticMarkup(
      createElement(UserChatItem, {
        chatItem: makeChatItem(
          makeSessionEvent({
            id: "user-message-raw",
            sessionId: "agentsession-local",
            source: "user",
            actionType: "raw",
            functionName: "user_message",
            displayVariant: "message",
            ...overrides,
          })
        ),
      })
    );
  }

  it("offers the raw-prompt toggle on a turn that carries wire content", () => {
    const markup = renderUserMessage({
      displayText: "setup-repo [skill:/setup-repo]",
      result: {
        type: "user",
        message: {
          role: "user",
          content:
            "setup-repo [skill:/setup-repo]\n\n---\n**Referenced content (auto-expanded):**\n\nSKILL body",
        },
      },
    });

    expect(markup).toContain('data-testid="chat-message-raw-prompt-toggle"');
    // Closed by default — the panel is portaled only once the user opens it.
    expect(markup).not.toContain('data-testid="chat-message-raw-prompt-panel"');
  });

  it("omits the toggle when the turn has no prompt text to show", () => {
    const markup = renderUserMessage({
      displayText: "",
      args: { cached_files: ["/tmp/screenshot.png"] },
      result: { type: "user", message: { role: "user", content: "   " } },
    });

    expect(markup).toContain("screenshot.png");
    expect(markup).not.toContain(
      'data-testid="chat-message-raw-prompt-toggle"'
    );
  });
});
