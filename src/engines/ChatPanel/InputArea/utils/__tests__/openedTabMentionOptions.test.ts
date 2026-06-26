import { describe, expect, it, vi } from "vitest";

import type { WorkStationTab } from "@src/store/workstation/tabs";

import { getOpenedTabMentionOptions } from "../../openedTabMentionOptions";

vi.mock("@src/components/TerminalInteractive/bufferCache", () => ({
  hasNonEmptyTerminalBuffer: vi.fn(() => true),
}));

function makeTab(overrides: Partial<WorkStationTab>): WorkStationTab {
  return {
    id: "tab-id",
    type: "file",
    title: "Tab",
    icon: "file",
    closable: true,
    data: {},
    ...overrides,
  } as WorkStationTab;
}

describe("getOpenedTabMentionOptions", () => {
  it("deduplicates tabs that point to the same mention target", () => {
    const options = getOpenedTabMentionOptions([
      makeTab({
        id: "file-tab-1",
        title: "index.tsx",
        type: "file",
        data: { filePath: "/repo/src/index.tsx" },
      }),
      makeTab({
        id: "file-tab-2",
        title: "index.tsx copy",
        type: "git-diff",
        data: { filePath: "/repo/src/index.tsx" },
      }),
      makeTab({
        id: "session-tab-1",
        title: "Agent session",
        type: "chat-session",
        data: { sessionId: "sdeagent-123" },
      }),
      makeTab({
        id: "session-tab-2",
        title: "Agent session duplicate",
        type: "chat-session",
        data: { sessionId: "sdeagent-123" },
      }),
    ]);

    expect(options).toHaveLength(2);
    expect(options.map((option) => option.id)).toEqual([
      "workstation-tab:file-tab-1",
      "workstation-tab:session-tab-1",
    ]);
    expect(options.map((option) => option.selectValue)).toEqual([
      "/repo/src/index.tsx",
      "sdeagent-123",
    ]);
  });

  it("returns browser-session tabs as browser mention options", () => {
    const options = getOpenedTabMentionOptions([
      makeTab({
        id: "browser:session-1",
        title: "Example",
        type: "browser-session",
        data: { sessionId: "session-1", url: "https://example.com/docs" },
      }),
    ]);

    expect(options).toEqual([
      {
        id: "workstation-tab:browser:session-1",
        label: "Example",
        description: "https://example.com/docs",
        groupLabel: "Open tabs",
        selectType: "browser",
        selectValue: "session-1",
        selectDisplayName: "Example",
      },
    ]);
  });
});
