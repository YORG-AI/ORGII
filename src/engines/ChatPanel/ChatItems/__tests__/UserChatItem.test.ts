import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CONVERSATION_SENDER_ARG,
  type ConversationViewerState,
} from "@src/engines/SessionCore/conversations/conversationSenderMetadata";
import {
  makeChatItem,
  makeSessionEvent,
} from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";
import { namespaceCopyEventId } from "@src/features/TeamCollaboration/copyEventId";
import type { Session } from "@src/store/session";

import { ConversationSenderMetadataProvider } from "../ConversationSenderMetadataContext";
import { ParentAgentSenderProvider } from "../ParentAgentSenderContext";
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
      ConversationSenderMetadataProvider,
      {
        value: {
          viewer: { status: "known", userId: "viewer-user" },
          resolveSender: () => ({
            userId: "ada-user",
            displayName: "Ada Lovelace",
            avatarUrl: "https://example.com/ada.png",
          }),
        },
      },
      createElement(UserChatItem, { chatItem: makeChatItem(event) })
    )
  );
}

describe("UserChatItem shared sender presentation", () => {
  it("renders a timestamp and the turn's provider-recorded model in its hover row", () => {
    const event = makeSessionEvent({
      id: "user-message-metadata",
      sessionId: "agentsession-local",
      source: "user",
      actionType: "raw",
      functionName: "user_message",
      displayText: "Hello from the conversation owner",
      displayVariant: "message",
      createdAt: "2026-09-06T01:09:00.000Z",
    });

    const markup = renderToStaticMarkup(
      createElement(UserChatItem, {
        chatItem: makeChatItem(event),
        modelId: "gpt-5.3-codex-high",
        onEditSubmit: () => undefined,
      })
    );

    expect(markup).toContain('data-testid="chat-message-timestamp"');
    expect(markup).toContain('dateTime="2026-09-06T01:09:00.000Z"');
    expect(markup).toContain('data-testid="chat-message-model"');
    expect(markup).toContain("GPT 5.3 Codex · High");
  });

  it("shows the owner avatar beside a copied remote message", () => {
    const sessionId = "agentsession-local";
    const markup = renderMessage(
      namespaceCopyEventId(sessionId, "user-message-remote")
    );

    expect(markup).toContain('data-message-side="left"');
    expect(markup).toContain('data-testid="shared-message-sender-avatar"');
    expect(markup).toContain('title="Ada Lovelace"');
    expect(markup).toContain('src="https://example.com/ada.png"');
    // Same 24px circle the shared PersonAvatar draws everywhere else, rather
    // than a locally styled one-off.
    expect(markup).toContain("width:24px;height:24px");
    expect(markup).toContain(
      "inline-flex shrink-0 overflow-hidden rounded-full"
    );
  });

  it("does not show a remote sender avatar for a local message", () => {
    const markup = renderMessage("user-message-local");

    expect(markup).toContain('data-message-side="right"');
    expect(markup).not.toContain("shared-message-sender-avatar");
    expect(markup).not.toContain("Ada Lovelace");
  });

  it("keeps the viewer's stamped plane row on the right without an alias", () => {
    const event = makeSessionEvent({
      id: "convplane-self",
      sessionId: "agentsession-local",
      source: "user",
      actionType: "raw",
      functionName: "user_message",
      displayText: "Optimistic self message",
      displayVariant: "message",
      args: {
        [CONVERSATION_SENDER_ARG]: {
          userId: "viewer-user",
          displayName: "Viewer Name",
        },
      },
    });
    const markup = renderToStaticMarkup(
      createElement(
        ConversationSenderMetadataProvider,
        {
          value: {
            viewer: { status: "known", userId: "viewer-user" },
            resolveSender: (_event, stamp) => stamp,
          },
        },
        createElement(UserChatItem, { chatItem: makeChatItem(event) })
      )
    );

    expect(markup).toContain('data-message-side="right"');
    expect(markup).not.toContain("Viewer Name");
    expect(markup).not.toContain("shared-message-sender-avatar");
  });

  it("resolves a known remote account without inventing a fallback label", () => {
    const event = makeSessionEvent({
      id: "convplane-remote",
      sessionId: "agentsession-local",
      source: "user",
      actionType: "raw",
      functionName: "user_message",
      displayText: "Remote account message",
      displayVariant: "message",
      args: {
        [CONVERSATION_SENDER_ARG]: { userId: "remote-user" },
      },
    });
    const markup = renderToStaticMarkup(
      createElement(
        ConversationSenderMetadataProvider,
        {
          value: {
            viewer: { status: "known", userId: "viewer-user" },
            resolveSender: (_event, stamp) =>
              stamp?.userId === "remote-user"
                ? {
                    userId: stamp.userId,
                    displayName: "Grace Hopper",
                    avatarUrl: "https://example.com/grace.png",
                  }
                : stamp,
          },
        },
        createElement(UserChatItem, { chatItem: makeChatItem(event) })
      )
    );

    expect(markup).toContain('data-message-side="left"');
    expect(markup).toContain("Grace Hopper");
    expect(markup).toContain('src="https://example.com/grace.png"');
    expect(markup).not.toContain("Shared user");
  });
  it("does not render a message-level copy control", () => {
    const markup = renderMessage("user-message-without-footer");

    expect(markup).not.toContain('data-icon="copy"');
  });

  it("keeps a stamped local self twin on the right before and after auth hydration", () => {
    const event = makeSessionEvent({
      id: "user-message-local-self",
      sessionId: "agentsession-local",
      source: "user",
      actionType: "raw",
      functionName: "user_message",
      displayText: "Local self while auth hydrates",
      displayVariant: "message",
      args: {
        [CONVERSATION_SENDER_ARG]: {
          userId: "viewer-user",
          displayName: "Viewer Name",
        },
      },
    });
    const renderWithViewer = (viewer: ConversationViewerState) =>
      renderToStaticMarkup(
        createElement(
          ConversationSenderMetadataProvider,
          {
            value: {
              viewer,
              resolveSender: (_event, stamp) => stamp,
            },
          },
          createElement(UserChatItem, { chatItem: makeChatItem(event) })
        )
      );

    const loading = renderWithViewer({ status: "loading" });
    const hydrated = renderWithViewer({
      status: "known",
      userId: "viewer-user",
    });
    for (const markup of [loading, hydrated]) {
      expect(markup).toContain('data-message-side="right"');
      expect(markup).not.toContain("shared-message-sender-avatar");
      expect(markup).not.toContain("Shared user");
    }
  });

  it("keeps stamped remote provenance left while auth hydrates without inventing a name", () => {
    const sessionId = "agentsession-local";
    const event = makeSessionEvent({
      id: namespaceCopyEventId(sessionId, "user-message-remote-stamped"),
      sessionId,
      source: "user",
      actionType: "raw",
      functionName: "user_message",
      displayText: "Remote while auth hydrates",
      displayVariant: "message",
      args: {
        [CONVERSATION_SENDER_ARG]: { userId: "remote-user" },
      },
    });
    const renderWithViewer = (viewer: ConversationViewerState) =>
      renderToStaticMarkup(
        createElement(
          ConversationSenderMetadataProvider,
          {
            value: {
              viewer,
              resolveSender: (_event, stamp) => stamp,
            },
          },
          createElement(UserChatItem, { chatItem: makeChatItem(event) })
        )
      );

    const loading = renderWithViewer({ status: "loading" });
    const hydrated = renderWithViewer({
      status: "known",
      userId: "viewer-user",
    });
    for (const markup of [loading, hydrated]) {
      expect(markup).toContain('data-message-side="left"');
      expect(markup).toContain("Remote while auth hydrates");
      expect(markup).not.toContain("shared-message-sender-avatar");
      expect(markup).not.toContain("Shared user");
    }
  });

  it("does not invent a Shared user while remote provenance hydrates", () => {
    const sessionId = "agentsession-local";
    const event = makeSessionEvent({
      id: namespaceCopyEventId(sessionId, "user-message-remote"),
      sessionId,
      source: "user",
      actionType: "raw",
      functionName: "user_message",
      displayText: "Loading provenance",
      displayVariant: "message",
    });
    const markup = renderToStaticMarkup(
      createElement(UserChatItem, { chatItem: makeChatItem(event) })
    );

    expect(markup).toContain('data-message-side="left"');
    expect(markup).toContain("Loading provenance");
    expect(markup).not.toContain("Shared user");
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

describe("UserChatItem delivery failure", () => {
  it("renders the underlying provider error beside the failed message", () => {
    const event = makeSessionEvent({
      id: "user-message-failed",
      sessionId: "agentsession-local",
      source: "user",
      actionType: "raw",
      functionName: "user_message",
      displayText: "Continue this conversation",
      displayVariant: "message",
      displayStatus: "failed",
      result: {
        deliveryStatus: "failed",
        deliveryError:
          "provider-native transcript is not a semantic prefix of the canonical conversation",
      },
    });

    const markup = renderToStaticMarkup(
      createElement(UserChatItem, { chatItem: makeChatItem(event) })
    );

    expect(markup).toContain('data-testid="chat-message-delivery-failed"');
    expect(markup).toContain(
      "provider-native transcript is not a semantic prefix of the canonical conversation"
    );
  });
});

describe("UserChatItem parent-agent attribution", () => {
  const parentSession = {
    session_id: "agentsession-root",
    name: "Key trading VM launch",
  } as Session;

  function renderTurn(
    sessionId: string,
    parentAgentSender: {
      parentSessionId: string;
      parentSession: Session | undefined;
    } | null,
    result?: Record<string, unknown>
  ): string {
    return renderToStaticMarkup(
      createElement(
        ParentAgentSenderProvider,
        { value: parentAgentSender },
        createElement(UserChatItem, {
          chatItem: makeChatItem(
            makeSessionEvent({
              id: "user-message-dispatch",
              sessionId,
              source: "user",
              actionType: "raw",
              functionName: "user_message",
              displayText: "Translate UI strings into ko, de and es.",
              displayVariant: "message",
              ...(result ? { result } : {}),
            })
          ),
        })
      )
    );
  }

  it("puts a subagent dispatch on the parent's side with its identity icon", () => {
    const markup = renderTurn("agentsession-root:subagent:translator", {
      parentSessionId: "agentsession-root",
      parentSession,
    });

    expect(markup).toContain('data-message-side="left"');
    expect(markup).toContain('data-testid="parent-agent-sender-avatar"');
    expect(markup).toContain('title="Key trading VM launch"');
    expect(markup).toContain("flex h-6 w-6 items-center justify-center");
    // The viewer's own avatar must not stand in for the parent agent.
    expect(markup).not.toContain("shared-message-sender-avatar");
  });

  it("names the parent generically until the parent session hydrates", () => {
    const markup = renderTurn("agentsession-root:subagent:translator", {
      parentSessionId: "agentsession-root",
      parentSession: undefined,
    });

    expect(markup).toContain('data-testid="parent-agent-sender-avatar"');
    expect(markup).not.toContain("Key trading VM launch");
  });

  it("keeps a turn in an ordinary session on the viewer's side", () => {
    const markup = renderTurn("agentsession-solo", null);

    expect(markup).toContain('data-message-side="right"');
    expect(markup).not.toContain("parent-agent-sender-avatar");
  });

  it("leaves a message the viewer typed into a subagent session as theirs", () => {
    // Composer sends carry a turn-intent id; the parent's dispatch does not.
    const markup = renderTurn(
      "agentsession-root:subagent:translator",
      { parentSessionId: "agentsession-root", parentSession },
      {
        type: "user",
        message: { role: "user", content: "Also do fr" },
        turnIntentId: "tii-typed-by-hand",
      }
    );

    expect(markup).toContain('data-message-side="right"');
    expect(markup).not.toContain("parent-agent-sender-avatar");
  });
});
