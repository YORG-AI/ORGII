// @vitest-environment jsdom
import React, { useState } from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SessionJourneyControls,
  resolveDurableJourneyMessageId,
} from "./SessionJourneyControls";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  snapshot: vi.fn(),
  forkCompare: vi.fn(),
  closeFork: vi.fn(),
  retryReview: vi.fn(),
  startTask: vi.fn(),
  checkpoint: vi.fn(),
  finishTask: vi.fn(),
  startFork: vi.fn(),
  confirm: vi.fn(),
  discard: vi.fn(),
  returnToParent: vi.fn(),
  onJump: vi.fn(),
}));

vi.mock("@src/api/tauri/sessionJourney", () => ({ sessionJourneyApi: api }));

const snapshot = {
  session_id: "session-a",
  revision: 7,
  active_branch_id: "fork-a",
  active_task_id: "task-a",
  tasks: {
    "task-a": {
      id: "task-a",
      name: "验证关闭",
      branch_id: "fork-a",
      state: "active",
      start_sequence: 3,
      finish_sequence: null,
      outcome: null,
    },
  },
  checkpoints: {},
  branches: {
    "fork-a": {
      id: "fork-a",
      parent_branch_id: "main",
      parent_anchor_message_id: "anchor-1",
      anchor_sequence: 3,
      state: "active",
      handoff_capsule: null,
    },
  },
  reviews: {
    "review-a": {
      id: "review-a",
      fork_id: "fork-a",
      state: "failed",
      annotation: "审核暂时失败",
      source_start_sequence: 3,
      source_end_sequence: 6,
      promoted_fact_ids: [],
    },
  },
};

async function click(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent?.trim().startsWith(text)
  );
  expect(button, `button ${text}`).toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

function Harness() {
  const [panel, setPanel] = useState<React.ReactNode | null>(null);
  return (
    <div>
      <SessionJourneyControls
        sessionId="session-a"
        messageId="message-6"
        onDockedReviewPanelChange={setPanel}
        onJumpToMessage={api.onJump}
      />
      <div className="work-station-shell__secondary-panel" data-testid="dock">
        {panel}
      </div>
    </div>
  );
}

function DirectForkHarness({ messageId }: { messageId?: string | null }) {
  return <SessionJourneyControls sessionId="session-a" messageId={messageId} />;
}

describe("SessionJourneyControls rendered behavior", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
    Object.values(api).forEach((mock) => mock.mockReset());
    api.snapshot.mockResolvedValue({ snapshot });
    api.forkCompare.mockResolvedValue({ groups: [] });
    api.closeFork.mockResolvedValue({ job_id: "job", state: "queued" });
    api.retryReview.mockResolvedValue({ revision: 8 });
    api.discard.mockResolvedValue({ parent_anchor_message_id: "anchor-1" });
    api.returnToParent.mockResolvedValue({
      parent_anchor_message_id: "anchor-1",
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      // `reload` commits after both snapshot promises resolve. Flush that
      // microtask before asserting real rendered controls.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("normalizes only the known live user-event prefix", () => {
    expect(resolveDurableJourneyMessageId("user-message-durable-7")).toBe(
      "durable-7"
    );
    expect(resolveDurableJourneyMessageId("durable-7")).toBe("durable-7");
    expect(resolveDurableJourneyMessageId("assistant-message-7")).toBe(
      "assistant-message-7"
    );
    expect(resolveDurableJourneyMessageId("user-message-")).toBeNull();
  });

  it("keeps direct Fork available without a hydrated visual anchor", async () => {
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(<DirectForkHarness messageId={null} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const fork = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent?.trim().startsWith("分叉")
    ) as HTMLButtonElement | undefined;
    expect(fork?.disabled).toBe(false);
    await click(container, "分叉");
    expect(document.body.textContent).toContain("最近一条已持久化的用户消息");
    const input = document.body.querySelector("input") as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      valueSetter?.call(input, "直接分叉");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(document.body, "确认");
    await act(async () => {});
    expect(api.startFork).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: "直接分叉" })
    );
    expect(api.startFork.mock.calls[0]?.[0]).not.toHaveProperty(
      "anchorMessageId"
    );
  });

  it("sends durable IDs to strict lifecycle actions from a live user event", async () => {
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(<DirectForkHarness messageId="user-message-durable-6" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await click(container, "分叉");
    const input = document.body.querySelector("input") as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      valueSetter?.call(input, "带锚点分叉");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(document.body, "确认");
    await act(async () => {});
    expect(api.startFork).toHaveBeenCalledWith(
      expect.objectContaining({ anchorMessageId: "durable-6" })
    );
  });

  it("closes a fork through the durable close command and retries a failed review", async () => {
    await click(container, "关闭分叉");
    await click(document.body, "确认");
    await act(async () => {});
    expect(api.closeFork).toHaveBeenCalledWith(
      expect.objectContaining({ forkId: "fork-a", messageId: "message-6" }),
      expect.any(String)
    );

    await click(container, "审核");
    await click(container, "重试审核");
    await act(async () => {});
    expect(api.retryReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: "review-a",
      })
    );
  });

  it("jumps to the exact parent anchor after discard and return", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await click(container, "审核");
    await click(container, "丢弃");
    await act(async () => {});
    expect(api.onJump).toHaveBeenLastCalledWith("anchor-1");

    api.onJump.mockClear();
    await click(container, "返回主干");
    await act(async () => {});
    expect(api.onJump).toHaveBeenLastCalledWith("anchor-1");
  });

  it("docks in the WorkStation pane, floats, hides, and reopens", async () => {
    await click(container, "审核");
    const dock = container.querySelector('[data-testid="dock"]');
    expect(
      dock?.querySelector('[data-testid="journey-review-panel"]')
    ).toBeTruthy();
    expect(
      dock?.querySelector('[data-testid="journey-review-panel"]')?.className
    ).not.toContain("fixed");

    await click(container, "浮动");
    expect(
      dock?.querySelector('[data-testid="journey-review-panel"]')
    ).toBeFalsy();
    expect(
      container.querySelector('[data-testid="journey-review-panel"]')?.className
    ).toContain("fixed");

    await click(container, "隐藏");
    expect(
      container.querySelector('[data-testid="journey-review-panel"]')
    ).toBeFalsy();
    await click(container, "审核");
    expect(
      dock?.querySelector('[data-testid="journey-review-panel"]')
    ).toBeTruthy();
  });

  it("offers recovery from durable active Journey state", async () => {
    expect(document.body.textContent).toContain("恢复会话旅程");
    await click(document.body, "继续当前会话");
    expect(document.body.textContent).not.toContain("恢复会话旅程");
  });
});
