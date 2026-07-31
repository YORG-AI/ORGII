import { describe, expect, it, vi } from "vitest";

import { Org2CloudChannelMessagesError } from "@src/features/Org2Cloud/channels/channelMessagesClient";
import { CHANNEL_MESSAGE_MAX_LENGTH } from "@src/features/Org2Cloud/channels/channelMessagesTypes";
import type {
  LocalChannelMessage,
  LocalChannelMessageResult,
} from "@src/store/ui/localChannelMessagesAtom";

import {
  CHANNEL_POST_ERROR_KEYS,
  CLOUD_CHANNEL_POST_ERROR_KEYS,
  createChannelPostHandler,
  createCloudChannelPostHandler,
  resolveCloudChannelErrorKey,
} from "./channelPostHandler";

const MESSAGE: LocalChannelMessage = {
  id: "msg-1",
  channelId: "chan-1",
  body: "hotfix-branch is ready for review",
  createdAt: "2026-07-31T00:00:00.000Z",
  editedAt: null,
  deletedAt: null,
};

const ACCEPTED: LocalChannelMessageResult = {
  ok: true,
  messages: [MESSAGE],
  message: MESSAGE,
};

function setup(post: (body: string) => LocalChannelMessageResult) {
  const onError = vi.fn();
  const handler = createChannelPostHandler({
    post,
    translate: (key) => key,
    onError,
  });
  return { handler, onError };
}

describe("createChannelPostHandler", () => {
  it("writes the trimmed body and clears the inline error on success", async () => {
    const post = vi.fn(() => ACCEPTED);
    const { handler, onError } = setup(post);

    await expect(
      handler({ displayText: "  rebase onto hotfix-branch  " })
    ).resolves.toBe(true);
    expect(post).toHaveBeenCalledWith("rebase onto hotfix-branch");
    expect(onError).toHaveBeenCalledWith(null);
  });

  it("throws on refusal so InputArea restores the draft, and reports the code", async () => {
    const { handler, onError } = setup(() => ({
      ok: false,
      error: "tooLong",
    }));

    await expect(handler({ displayText: "x".repeat(4001) })).rejects.toThrow(
      CHANNEL_POST_ERROR_KEYS.tooLong
    );
    expect(onError).toHaveBeenCalledWith(CHANNEL_POST_ERROR_KEYS.tooLong);
  });

  it("maps every refusal code to its own localized key", async () => {
    for (const code of ["empty", "tooLong", "quota", "invalid"] as const) {
      const { handler, onError } = setup(() => ({ ok: false, error: code }));
      await expect(handler({ displayText: "anything" })).rejects.toThrow(
        CHANNEL_POST_ERROR_KEYS[code]
      );
      expect(onError).toHaveBeenCalledWith(CHANNEL_POST_ERROR_KEYS[code]);
    }
    // Distinct copy per code — a shared key would hide WHY a post was refused.
    expect(new Set(Object.values(CHANNEL_POST_ERROR_KEYS)).size).toBe(4);
  });

  it("ignores a whitespace-only submit without touching the store", async () => {
    const post = vi.fn(() => ACCEPTED);
    const { handler, onError } = setup(post);

    await expect(handler({ displayText: "   \n  " })).resolves.toBe(true);
    expect(post).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("resolves true so the composer never falls through to the agent path", async () => {
    const { handler } = setup(() => ACCEPTED);

    // `useSubmitMessage` only calls `handleSessChatSubmit` when the override
    // resolves false — a channel has no session to submit to.
    await expect(handler({ displayText: "ship it" })).resolves.toBe(true);
  });
});

function setupCloud(post: (body: string) => Promise<void>) {
  const onError = vi.fn();
  const handler = createCloudChannelPostHandler({
    post,
    translate: (key) => key,
    onError,
  });
  return { handler, onError };
}

function refusal(code: string): Org2CloudChannelMessagesError {
  return new Org2CloudChannelMessagesError(`refused (${code})`, 403);
}

describe("createCloudChannelPostHandler", () => {
  it("posts the trimmed body and clears the inline error on success", async () => {
    const post = vi.fn(async () => undefined);
    const { handler, onError } = setupCloud(post);

    await expect(
      handler({ displayText: "  ship the release notes  " })
    ).resolves.toBe(true);
    expect(post).toHaveBeenCalledWith("ship the release notes");
    expect(onError).toHaveBeenCalledWith(null);
  });

  it("explains a managers-only channel instead of a generic failure", async () => {
    const { handler, onError } = setupCloud(async () => {
      throw refusal("ORG2_CHANNEL_POST_FORBIDDEN");
    });

    await expect(handler({ displayText: "hello" })).rejects.toThrow(
      CLOUD_CHANNEL_POST_ERROR_KEYS.ORG2_CHANNEL_POST_FORBIDDEN
    );
    expect(onError).toHaveBeenCalledWith(
      "cloud.channels.feed.errorPostForbidden"
    );
  });

  it("explains an archived channel instead of a generic failure", async () => {
    const { handler, onError } = setupCloud(async () => {
      throw refusal("ORG2_CHANNEL_ARCHIVED");
    });

    await expect(handler({ displayText: "hello" })).rejects.toThrow(
      CLOUD_CHANNEL_POST_ERROR_KEYS.ORG2_CHANNEL_ARCHIVED
    );
    expect(onError).toHaveBeenCalledWith("cloud.channels.feed.errorArchived");
  });

  it("falls back to the generic post error for anything unmapped", async () => {
    // A transport failure carries no ORG2_* code at all.
    expect(resolveCloudChannelErrorKey(new Error("network down"))).toBe(
      CHANNEL_POST_ERROR_KEYS.invalid
    );
    // ...and so does a future server code this build does not know.
    expect(resolveCloudChannelErrorKey(refusal("ORG2_QUOTA_EXCEEDED"))).toBe(
      CHANNEL_POST_ERROR_KEYS.invalid
    );
  });

  it("refuses an over-long body before spending a round trip", async () => {
    const post = vi.fn(async () => undefined);
    const { handler, onError } = setupCloud(post);

    await expect(
      handler({ displayText: "x".repeat(CHANNEL_MESSAGE_MAX_LENGTH + 1) })
    ).rejects.toThrow(CHANNEL_POST_ERROR_KEYS.tooLong);
    expect(post).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(CHANNEL_POST_ERROR_KEYS.tooLong);
  });

  it("ignores a whitespace-only submit without calling the RPC", async () => {
    const post = vi.fn(async () => undefined);
    const { handler, onError } = setupCloud(post);

    await expect(handler({ displayText: "   \n  " })).resolves.toBe(true);
    expect(post).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
