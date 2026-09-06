// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SubmitRetainedDeliveryError,
  SubmitValidationError,
} from "@src/engines/ChatPanel/hooks/useInputArea/types";
import { type SmokeRoot, createSmokeRoot } from "@src/test/reactSmokeHarness";

import { SessionCommentDeliveryError } from "../org2CloudSessionCommentsAtom";
import {
  useConversationComposerMode,
  useConversationSubmitOverride,
} from "./useConversationComposer";

const mocks = vi.hoisted(() => ({
  addComment: vi.fn(),
  viewerUserId: "user-1" as string | null,
}));

vi.mock("../SessionComments/SessionCommentsContext", () => ({
  useSessionCommentsContext: () => ({
    target: { orgId: "org-1", sessionId: "session-1" },
    viewerUserId: mocks.viewerUserId,
    mentionableMembers: [],
    addComment: mocks.addComment,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

interface Api {
  submit: ReturnType<typeof useConversationSubmitOverride>;
  setMode: ReturnType<typeof useConversationComposerMode>[1];
}

let api: Api;
function Harness({ onReady }: { onReady: (value: Api) => void }) {
  const [, setMode] = useConversationComposerMode("session-1");
  const submit = useConversationSubmitOverride("session-1");
  useEffect(() => onReady({ submit, setMode }), [onReady, setMode, submit]);
  return null;
}

describe("Team Chat composer delivery ownership", () => {
  let root: SmokeRoot;

  beforeEach(() => {
    mocks.addComment.mockReset();
    mocks.viewerUserId = "user-1";
  });

  afterEach(async () => root.unmount());

  it("marks transport failures as retained so the editor is not restored", async () => {
    mocks.addComment.mockRejectedValueOnce(
      new SessionCommentDeliveryError("local-comment-1", new Error("offline"))
    );
    root = createSmokeRoot();
    await root.render(
      createElement(Harness, {
        onReady: (value) => {
          api = value;
        },
      })
    );
    await act(async () => api.setMode("team_chat"));

    await expect(
      api.submit({ displayText: "hello", agentContent: "hello" })
    ).rejects.toBeInstanceOf(SubmitRetainedDeliveryError);
    expect(mocks.addComment).toHaveBeenCalledWith({ body: "hello" });
  });

  it("does not claim ownership when no failed row was retained", async () => {
    const error = new Error("preflight failed");
    mocks.addComment.mockRejectedValueOnce(error);
    root = createSmokeRoot();
    await root.render(
      createElement(Harness, {
        onReady: (value) => {
          api = value;
        },
      })
    );
    await act(async () => api.setMode("team_chat"));

    await expect(
      api.submit({ displayText: "hello", agentContent: "hello" })
    ).rejects.toBe(error);
  });

  it("never enters team chat for a signed-out viewer, so no anonymous row is inserted", async () => {
    mocks.viewerUserId = null;
    root = createSmokeRoot();
    await root.render(
      createElement(Harness, {
        onReady: (value) => {
          api = value;
        },
      })
    );
    await act(async () => api.setMode("team_chat"));

    await expect(
      api.submit({ displayText: "hello", agentContent: "hello" })
    ).resolves.toBe(false);
    expect(mocks.addComment).not.toHaveBeenCalled();
  });

  it("rejects an unsupported attachment before any row is inserted", async () => {
    root = createSmokeRoot();
    await root.render(
      createElement(Harness, {
        onReady: (value) => {
          api = value;
        },
      })
    );
    await act(async () => api.setMode("team_chat"));

    await expect(
      api.submit({
        displayText: "hello",
        agentContent: "hello",
        imageDataUrls: ["data:image/png;base64,AAA"],
      })
    ).rejects.toBeInstanceOf(SubmitValidationError);
    expect(mocks.addComment).not.toHaveBeenCalled();
  });

  it("rejects a stale Agent pill instead of silently sending it as Team Chat", async () => {
    root = createSmokeRoot();
    await root.render(
      createElement(Harness, {
        onReady: (value) => {
          api = value;
        },
      })
    );
    await act(async () => api.setMode("team_chat"));

    await expect(
      api.submit({
        displayText: "@Reviewer please review",
        agentContent: "@Reviewer please review",
        composerSnapshot: {
          parts: [
            {
              kind: "pill",
              attrs: {
                filePath: "agent://reviewer",
                fileName: "Reviewer",
                isFolder: false,
                iconType: "member",
                lineStart: null,
                lineEnd: null,
              },
            },
            { kind: "text", text: " please review" },
          ],
        },
      })
    ).rejects.toBeInstanceOf(SubmitValidationError);
    expect(mocks.addComment).not.toHaveBeenCalled();
  });
});
