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
      new SessionCommentDeliveryError(
        "local-comment-1",
        { body: "hello" },
        new Error("offline")
      )
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

  it("rejects before inserting an anonymous unretryable row", async () => {
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
    ).rejects.toBeInstanceOf(SubmitValidationError);
    expect(mocks.addComment).not.toHaveBeenCalled();
  });
});
