import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { OptimizedChatItem } from "./chatItemPipeline/types";
import {
  buildTurnToolBundleTypeSummary,
  bundleFlatItemsByGroup,
  bundleGroupItems,
  isBundlableToolChatItem,
} from "./turnToolBundle";

let counter = 0;

function makeEvent(overrides: Partial<SessionEvent>): SessionEvent {
  counter++;
  return {
    id: `event-${counter}`,
    chunk_id: `event-${counter}`,
    sessionId: "session-test",
    createdAt: `2026-06-10T10:00:${String(counter).padStart(2, "0")}Z`,
    functionName: "read_file",
    uiCanonical: "",
    actionType: "tool_call",
    args: {},
    result: {},
    source: "assistant",
    displayText: "",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    ...overrides,
  } as SessionEvent;
}

function item(event: SessionEvent): OptimizedChatItem {
  return { chunk_id: event.id, type: "activity", event };
}

function thinkingItem(): OptimizedChatItem {
  return item(
    makeEvent({
      functionName: "thinking",
      actionType: "llm_thinking",
      displayVariant: "thinking",
      displayText: "Planning next steps",
      result: { thought: "Planning next steps" },
    })
  );
}

function toolItem(): OptimizedChatItem {
  return item(
    makeEvent({
      functionName: "run_shell",
      actionType: "tool_call",
      displayText: "pnpm test",
      args: { command: "pnpm test" },
    })
  );
}

function assistantItem(text: string): OptimizedChatItem {
  return item(
    makeEvent({
      functionName: "assistant_message",
      actionType: "assistant",
      displayText: text,
      displayVariant: "message",
      result: { content: text },
    })
  );
}

function userItem(text: string): OptimizedChatItem {
  return item(
    makeEvent({
      functionName: "user_message",
      actionType: "raw",
      source: "user",
      displayText: text,
      displayVariant: "message",
    })
  );
}

function actionSummaryGroupItem(id: string, eventCount = 1): OptimizedChatItem {
  return {
    chunk_id: id,
    type: "actionSummaryGroup",
    actionSummaryEntries: [
      {
        category: "read",
        events: Array.from({ length: eventCount }, (_, index) =>
          makeEvent({
            functionName: "read_file",
            displayText: `src/file-${index}.ts`,
          })
        ),
      },
    ],
  };
}

describe("turnToolBundle", () => {
  it("bundles consecutive tool blocks into one turnToolBundle item", () => {
    const items = [
      thinkingItem(),
      actionSummaryGroupItem("explore-1"),
      toolItem(),
    ];

    const bundled = bundleGroupItems(items);

    expect(bundled).toHaveLength(1);
    expect(bundled[0]?.type).toBe("turnToolBundle");
    expect(bundled[0]?.turnToolBundleItems).toHaveLength(3);
  });

  it("keeps assistant messages outside the bundle", () => {
    const items = [
      thinkingItem(),
      assistantItem("Here is the answer"),
      toolItem(),
    ];

    const bundled = bundleGroupItems(items);

    expect(bundled).toHaveLength(3);
    expect(bundled[0]?.type).toBe("turnToolBundle");
    expect(bundled[1]?.event?.displayText).toBe("Here is the answer");
    expect(bundled[2]?.type).toBe("turnToolBundle");
  });

  it("does not bundle user messages or thread selectors", () => {
    expect(isBundlableToolChatItem(userItem("hello"))).toBe(false);
    expect(
      isBundlableToolChatItem({
        chunk_id: "thread",
        type: "threadSelector",
        threadSelectorData: {
          roundNumber: 1,
          threads: [],
          threadFirstEventMap: new Map(),
        },
      })
    ).toBe(false);
  });

  it("updates group counts when flattening bundled groups", () => {
    const flatItems = [
      userItem("prompt"),
      thinkingItem(),
      toolItem(),
      assistantItem("Done"),
    ];
    const groupCounts = [4];

    const bundled = bundleFlatItemsByGroup(flatItems, groupCounts);

    expect(bundled.flatItems).toHaveLength(3);
    expect(bundled.groupCounts).toEqual([3]);
    expect(bundled.flatItems[1]?.type).toBe("turnToolBundle");
    expect(bundled.lastAssistantFlatIndexPerItem[2]).toBe(2);
  });

  it("builds a type summary for mixed bundled tool blocks", () => {
    const items = [
      thinkingItem(),
      actionSummaryGroupItem("explore-1", 5),
      toolItem(),
    ];
    const summary = buildTurnToolBundleTypeSummary(items, (key, options) => {
      if (key === "chat.collapseToolBlocksTypes.thinking") return "思考";
      if (key === "chat.collapseToolBlocksTypes.explore") return "探索";
      if (key === "chat.collapseToolBlocksTypes.terminal") return "执行命令";
      if (key === "chat.collapseToolBlocksTypeEntry") {
        return `${options?.label} ×${options?.count}`;
      }
      if (key === "chat.collapseToolBlocksTypeSeparator") return " · ";
      return key;
    });

    expect(summary).toBe("思考 · 探索 ×5 · 执行命令");
  });
});
