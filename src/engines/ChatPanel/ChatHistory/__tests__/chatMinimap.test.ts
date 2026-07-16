import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ChatMinimap,
  buildChatMinimapItems,
  buildChatMinimapItemsFromSession,
  buildChatMinimapJumpRequest,
  resolveChatMinimapActiveMarkerIndex,
} from "../index";

describe("buildChatMinimapItems", () => {
  it("忽略 display group，按真实展示消息序列扫描 user/agent 轮次", () => {
    const headers = [
      { event: { role: "user", created_at: "header-should-not-win" } },
    ] as never;
    const items = [
      { event: { role: "user", created_at: "10:00" } },
      { event: { role: "assistant", timestamp: "10:01" } },
      { event: { role: "assistant", timestamp: "10:02" } },
      { event: { role: "user", created_at: "10:05" } },
      { event: { role: "assistant", timestamp: "10:06" } },
    ] as never;
    const itemCount = 5;

    expect(buildChatMinimapItems(items, [itemCount], headers)).toMatchObject([
      {
        flatIndex: 0,
        endFlatIndex: 0,
        turnNumber: 1,
        kind: "user",
        timeLabel: "10:00",
      },
      {
        flatIndex: 1,
        endFlatIndex: 2,
        turnNumber: 1,
        kind: "agent",
        timeLabel: "10:01",
      },
      {
        flatIndex: 3,
        endFlatIndex: 3,
        turnNumber: 2,
        kind: "user",
        timeLabel: "10:05",
      },
      {
        flatIndex: 4,
        endFlatIndex: 4,
        turnNumber: 2,
        kind: "agent",
        timeLabel: "10:06",
      },
    ]);
  });

  it("从完整 optimizedChatHistory 建全 session 小地图，并映射到可滚动 flat index", () => {
    const sessionItems = [
      { event: { role: "user", created_at: "u1" } },
      { event: { role: "assistant", timestamp: "a1" } },
      { event: { role: "user", created_at: "u2" } },
      { event: { role: "assistant", timestamp: "a2-1" } },
      { event: { role: "assistant", timestamp: "a2-2" } },
    ] as never;
    const originalToFlatIndex = new Map([
      [0, 0],
      [1, 1],
      [2, 8],
      [3, 9],
      [4, 10],
    ]);

    const minimapItems = buildChatMinimapItemsFromSession(
      sessionItems,
      originalToFlatIndex
    );

    expect(minimapItems).toMatchObject([
      { flatIndex: 0, turnNumber: 1, kind: "user", timeLabel: "u1" },
      { flatIndex: 1, turnNumber: 1, kind: "agent", timeLabel: "a1" },
      { flatIndex: 8, turnNumber: 2, kind: "user", timeLabel: "u2" },
      {
        flatIndex: 9,
        endFlatIndex: 10,
        turnNumber: 2,
        kind: "agent",
        timeLabel: "a2-1",
      },
    ]);
  });

  it("当前页只有 1 轮时，小地图仍使用全 session flatItems 展示所有轮次", () => {
    const fullSessionItems = [
      { event: { role: "user", created_at: "u1" } },
      { event: { role: "assistant", timestamp: "a1" } },
      { event: { role: "user", created_at: "u2" } },
      { event: { role: "assistant", timestamp: "a2" } },
      { event: { role: "user", created_at: "u3" } },
      { event: { role: "assistant", timestamp: "a3" } },
    ] as never;
    const currentPageItems = [
      { event: { role: "user", created_at: "u2" } },
      { event: { role: "assistant", timestamp: "a2" } },
    ] as never;

    const fullSessionMinimapItems = buildChatMinimapItems(fullSessionItems);
    const currentPageMinimapItems = buildChatMinimapItems(currentPageItems);

    expect(currentPageMinimapItems).toHaveLength(2);
    expect(fullSessionMinimapItems).toHaveLength(6);
    expect(fullSessionMinimapItems.map((item) => item.timeLabel)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
      "u3",
      "a3",
    ]);
    expect(fullSessionMinimapItems.map((item) => item.flatIndex)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });

  it("长对话含连续 user、一轮多 agent、无 agent 回复时，标记数量按轮次约等于 turns×2", () => {
    const items: {
      event: {
        role?: string;
        type?: string;
        created_at?: string;
        timestamp?: string;
      };
    }[] = [];
    for (let turn = 1; turn <= 15; turn += 1) {
      items.push({ event: { role: "user", created_at: `u${turn}` } });
      if (turn === 5) continue;
      items.push({ event: { role: "assistant", timestamp: `a${turn}-1` } });
      if (turn % 3 === 0) {
        items.push({ event: { role: "assistant", timestamp: `a${turn}-2` } });
      }
      if (turn === 7) {
        items.push({ event: { role: "user", created_at: "u7b" } });
      }
    }

    expect(items.length).toBeGreaterThanOrEqual(30);
    const minimapItems = buildChatMinimapItems(
      items as never,
      [2, items.length - 2],
      []
    );

    expect(minimapItems.filter((item) => item.kind === "user")).toHaveLength(
      16
    );
    expect(minimapItems.filter((item) => item.kind === "agent")).toHaveLength(
      14
    );
    expect(minimapItems).toHaveLength(30);
    expect(
      minimapItems.find(
        (item) => item.turnNumber === 5 && item.kind === "agent"
      )
    ).toBeUndefined();
    expect(minimapItems.find((item) => item.timeLabel === "u7b")).toMatchObject(
      {
        kind: "user",
        turnNumber: 8,
      }
    );
  });

  it("兼容真实展示项中 role/time 位于顶层、message、event 的结构变体", () => {
    const minimapItems = buildChatMinimapItems([
      { role: "user", createdAt: "u-top" },
      { message: { role: "assistant", timestamp: "a-message" } },
      { event: { source: "user", createdAt: "u-event" } },
      {
        type: "activity",
        event: { actionType: "tool_call", createdAt: "tool-event" },
      },
    ] as never);

    expect(minimapItems).toMatchObject([
      { flatIndex: 0, turnNumber: 1, kind: "user", timeLabel: "u-top" },
      { flatIndex: 1, turnNumber: 1, kind: "agent", timeLabel: "a-message" },
      { flatIndex: 2, turnNumber: 2, kind: "user", timeLabel: "u-event" },
      { flatIndex: 3, turnNumber: 2, kind: "agent", timeLabel: "tool-event" },
    ]);
  });

  it("displayFlatItems 不为空且只缺 event.role 时仍能生成小地图标记", () => {
    const minimapItems = buildChatMinimapItems([
      { source: "user", timestamp: "u1" },
      { type: "activity", event: { actionType: "tool_call", createdAt: "t1" } },
    ] as never);

    expect(minimapItems.length).toBeGreaterThan(0);
    expect(minimapItems.map((item) => item.kind)).toEqual(["user", "agent"]);
  });

  it("把视口锚点映射到唯一所属段，避免多个红色 active 标记", () => {
    const minimapItems = buildChatMinimapItems([
      { event: { role: "user", created_at: "10:00" } },
      { event: { role: "assistant", timestamp: "10:01" } },
      { event: { role: "assistant", timestamp: "10:02" } },
      { event: { role: "user", created_at: "10:05" } },
      { event: { role: "assistant", timestamp: "10:06" } },
      { event: { role: "assistant", timestamp: "10:07" } },
    ] as never);

    expect(resolveChatMinimapActiveMarkerIndex(minimapItems, 0)).toBe(0);
    expect(resolveChatMinimapActiveMarkerIndex(minimapItems, 2)).toBe(1);
    expect(resolveChatMinimapActiveMarkerIndex(minimapItems, 3)).toBe(2);
    expect(resolveChatMinimapActiveMarkerIndex(minimapItems, 5)).toBe(3);
    expect(resolveChatMinimapActiveMarkerIndex(minimapItems, Number.NaN)).toBe(
      3
    );
    expect(new Set(minimapItems.map((item) => item.markerIndex)).size).toBe(
      minimapItems.length
    );
  });

  it("点击跳转请求使用标记目标展示 flat index 且居中对齐", () => {
    const [userItem, agentItem] = buildChatMinimapItems([
      { event: { role: "user", created_at: "10:00" } },
      { event: { role: "assistant", timestamp: "10:01" } },
    ] as never);

    expect(buildChatMinimapJumpRequest(userItem.flatIndex)).toEqual({
      index: 0,
      align: "center",
      behavior: "smooth",
      targetLineAlign: "center-line",
    });
    expect(buildChatMinimapJumpRequest(agentItem.flatIndex)).toEqual({
      index: 1,
      align: "center",
      behavior: "smooth",
      targetLineAlign: "center-line",
    });
    expect(buildChatMinimapJumpRequest(7)).toEqual({
      index: 7,
      align: "center",
      behavior: "smooth",
      targetLineAlign: "center-line",
    });
  });

  it("同一轮多条 agent 时，agent 标记点击目标是 agent 起始 flatIndex", () => {
    const minimapItems = buildChatMinimapItems([
      { event: { role: "user", created_at: "u1" } },
      { event: { role: "assistant", timestamp: "a1-1" } },
      { event: { role: "assistant", timestamp: "a1-2" } },
    ] as never);
    const onJump = vi.fn();
    const html = renderToStaticMarkup(
      React.createElement(ChatMinimap, {
        items: minimapItems,
        activeMarkerIndex: -1,
        onJump,
      })
    );

    expect(minimapItems).toMatchObject([
      { kind: "user", flatIndex: 0, endFlatIndex: 0 },
      { kind: "agent", flatIndex: 1, endFlatIndex: 2 },
    ]);
    expect(html).toContain('data-jump-index="1"');
    onJump(minimapItems[1].flatIndex);
    expect(onJump).toHaveBeenCalledWith(1);
  });

  it("给定非空 items 时渲染小地图容器和多个标记", () => {
    const minimapItems = buildChatMinimapItems([
      { event: { role: "user", created_at: "10:00" } },
      { event: { role: "assistant", timestamp: "10:01" } },
      { event: { role: "user", created_at: "10:05" } },
    ] as never);

    const html = renderToStaticMarkup(
      React.createElement(ChatMinimap, {
        items: minimapItems,
        activeMarkerIndex: 1,
        onJump: vi.fn(),
      })
    );

    expect(html).toContain('data-testid="chat-minimap"');
    expect(html.match(/data-testid="chat-minimap-marker"/g)).toHaveLength(3);
    expect(html).toContain('data-minimap-count="3"');
  });

  it("flatIndex 重合时 active 仍只返回一个唯一 marker", () => {
    const minimapItems = buildChatMinimapItemsFromSession(
      [
        { event: { role: "user", created_at: "u1" } },
        { event: { role: "assistant", timestamp: "a1" } },
      ] as never,
      new Map([
        [0, 0],
        [1, 0],
      ])
    );

    expect(minimapItems.map((item) => item.flatIndex)).toEqual([0, 0]);
    expect(minimapItems.map((item) => item.markerIndex)).toEqual([0, 1]);
    const activeMarkerIndex = resolveChatMinimapActiveMarkerIndex(
      minimapItems,
      0
    );
    expect(activeMarkerIndex).toBe(0);
    expect(
      minimapItems.filter((item) => item.markerIndex === activeMarkerIndex)
    ).toHaveLength(1);
  });

  it("active 标记常显轮次编号，并暴露 kind/active 与莫兰迪色 style", () => {
    const minimapItems = buildChatMinimapItems([
      { event: { role: "user", created_at: "10:00" } },
      { event: { role: "assistant", timestamp: "10:01" } },
    ] as never);

    const html = renderToStaticMarkup(
      React.createElement(ChatMinimap, {
        items: minimapItems,
        activeMarkerIndex: 1,
        onJump: vi.fn(),
      })
    );

    expect(html).toContain('data-kind="user"');
    expect(html).toContain('data-kind="agent"');
    expect(html).toContain('data-active="true"');
    expect(html).toContain('data-active-label="true"');
    expect(html).toContain("min-w-5 whitespace-nowrap");
    expect(html).toContain("w-14");
    expect(html).toContain(">#1</span>");
    expect(html).toContain("background-color:#B56B6B");
    expect(html).toContain("background-color:#7A9E9F");
  });
});
