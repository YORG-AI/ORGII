import { describe, expect, it } from "vitest";

import type { ConversationRootLocator } from "@src/engines/SessionCore/conversations/conversationTypes";
import type { QueuedMessage } from "@src/store/ui/messageQueueAtom";

import { queuedMessageBelongsToConversationView } from "./useChatViewMessageQueue";

const root: ConversationRootLocator = {
  authority: "org2-cloud",
  authorityScope: ["org-1"],
  conversationId: "root-1",
};

function message(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: "message-1",
    turnIntentId: "turn-1",
    sessionId: "source-session",
    content: "hello",
    displayContent: "hello",
    priority: "next",
    status: "queued",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("queuedMessageBelongsToConversationView", () => {
  it("keeps a canonical queued row visible after the view retargets to a native episode", () => {
    expect(
      queuedMessageBelongsToConversationView(
        message({
          conversationDispatch: {
            kind: "canonical_conversation",
            root,
            target: {
              cliAgentType: "codex",
              accountId: "openai-1",
              workspaceRepoPath: "/repo",
            },
          },
        }),
        {
          pipelineSessionId: "codex-native-episode",
          queueSessionId: "codex-native-episode",
          conversationRoot: root,
        }
      )
    ).toBe(true);
  });

  it("does not leak another conversation's canonical queue rows", () => {
    expect(
      queuedMessageBelongsToConversationView(
        message({
          conversationDispatch: {
            kind: "canonical_conversation",
            root: { ...root, conversationId: "root-2" },
            target: {
              cliAgentType: "codex",
              accountId: "openai-1",
              workspaceRepoPath: "/repo",
            },
          },
        }),
        {
          pipelineSessionId: "codex-native-episode",
          queueSessionId: "codex-native-episode",
          conversationRoot: root,
        }
      )
    ).toBe(false);
  });
});
