import { Provider } from "jotai";
import React from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { chatPanelTabsAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { useTeamInboxNavigation } from "../useTeamInboxNavigation";

const mocks = vi.hoisted(() => ({
  openCloudConversationRoot: vi.fn(),
}));

vi.mock("@src/features/Org2Cloud/useOpenCloudSessionReference", () => ({
  useOpenCloudConversationRoot: () => mocks.openCloudConversationRoot,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("useTeamInboxNavigation", () => {
  beforeEach(() => {
    mocks.openCloudConversationRoot.mockReset();
  });

  it("routes a cloud Team Chat mention through canonical replay instead of opening its remote native UUID locally", () => {
    const store = createInstrumentedStore();
    let navigate: ReturnType<typeof useTeamInboxNavigation> | undefined;

    function HookProbe(): null {
      // Test probe: server rendering captures the stable navigation callback.
      // eslint-disable-next-line react-hooks/globals -- the probe never mounts or re-renders
      navigate = useTeamInboxNavigation();
      return null;
    }

    renderToString(
      React.createElement(Provider, { store }, React.createElement(HookProbe))
    );

    navigate?.({
      kind: "open_session_comment",
      orgId: "org-1",
      sessionId: "5d0c4ea3-remote-claude-uuid",
      commentId: "comment-1",
      threadId: "thread-1",
    });

    expect(mocks.openCloudConversationRoot).toHaveBeenCalledOnce();
    expect(mocks.openCloudConversationRoot).toHaveBeenCalledWith({
      orgId: "org-1",
      rootSessionId: "5d0c4ea3-remote-claude-uuid",
    });
    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.some(
          (tab) =>
            tab.type === "session" &&
            tab.sessionId === "5d0c4ea3-remote-claude-uuid"
        )
    ).toBe(false);
  });
});
