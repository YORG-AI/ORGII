import { describe, expect, it } from "vitest";

import {
  resolveWorkspaceChatControlSessionId,
  resolveWorkspaceChatEffectiveSessionId,
  shouldRestoreWorkspaceStoppedMessage,
} from "./useWorkspaceChat";

describe("resolveWorkspaceChatControlSessionId", () => {
  it("targets the hidden native runner without changing the canonical message session", () => {
    const canonicalSessionId = "codexapp-source";

    expect(
      resolveWorkspaceChatControlSessionId(
        "cliagent-native-runner",
        canonicalSessionId
      )
    ).toBe("cliagent-native-runner");
    expect(canonicalSessionId).toBe("codexapp-source");
  });

  it("falls back to the ordinary session when there is no runner", () => {
    expect(
      resolveWorkspaceChatControlSessionId(null, "cliagent-ordinary")
    ).toBe("cliagent-ordinary");
  });
});

describe("resolveWorkspaceChatEffectiveSessionId", () => {
  it("preserves SideChat's explicit Stop scope without creating an implicit message target", () => {
    expect(
      resolveWorkspaceChatEffectiveSessionId(
        "cliagent-side-chat",
        true,
        "cliagent-unrelated-active",
        "cliagent-unrelated-pipeline"
      )
    ).toBe("cliagent-side-chat");
    expect(
      resolveWorkspaceChatEffectiveSessionId(
        null,
        true,
        "cliagent-unrelated-active",
        "cliagent-unrelated-pipeline"
      )
    ).toBeNull();
  });
});

describe("shouldRestoreWorkspaceStoppedMessage", () => {
  it("keeps ordinary Stop restore but skips a canonical hidden runner", () => {
    expect(shouldRestoreWorkspaceStoppedMessage(null)).toBe(true);
    expect(shouldRestoreWorkspaceStoppedMessage("cliagent-native-runner")).toBe(
      false
    );
  });
});
