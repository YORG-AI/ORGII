// @vitest-environment jsdom
import React, { useState } from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionJourneyControls } from "./SessionJourneyControls";

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

function click(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent?.trim() === text
  );
  expect(button, `button ${text}`).toBeTruthy();
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function Harness() {
  const [panel, setPanel] = useState<React.ReactNode | null>(null);
  return (
    <div>
      <SessionJourneyControls
        sessionId="session-a"
        messageId="message-6"
        forkCloseProvenance={{ modelId: "m", accountId: "a", protocol: "p" }}
        onDockedReviewPanelChange={setPanel}
      />
      <div className="work-station-shell__secondary-panel" data-testid="dock">
        {panel}
      </div>
    </div>
  );
}

describe("SessionJourneyControls rendered behavior", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.useFakeTimers();
    Object.values(api).forEach((mock) => mock.mockReset());
    api.snapshot.mockResolvedValue({ snapshot });
    api.forkCompare.mockResolvedValue({ groups: [] });
    api.closeFork.mockResolvedValue({ job_id: "job", state: "queued" });
    api.retryReview.mockResolvedValue({ revision: 8 });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
      await vi.runAllTimersAsync();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("closes a fork through the durable close command and retries a failed review", async () => {
    click(container, "关闭分叉");
    click(document.body, "确认");
    await act(async () => {});
    expect(api.closeFork).toHaveBeenCalledWith(
      expect.objectContaining({ forkId: "fork-a", messageId: "message-6" }),
      expect.any(String),
      { modelId: "m", accountId: "a", protocol: "p" }
    );

    click(container, "审核");
    click(container, "重试审核");
    await act(async () => {});
    expect(api.retryReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: "review-a",
        jobId: "review-job:review-a",
      })
    );
  });

  it("docks in the WorkStation pane, floats, hides, and reopens", () => {
    click(container, "审核");
    const dock = container.querySelector('[data-testid="dock"]');
    expect(
      dock?.querySelector('[data-testid="journey-review-panel"]')
    ).toBeTruthy();
    expect(dock?.className).toContain("work-station-shell__secondary-panel");

    click(container, "浮动");
    expect(
      dock?.querySelector('[data-testid="journey-review-panel"]')
    ).toBeFalsy();
    expect(
      container.querySelector('[data-testid="journey-review-panel"]')?.className
    ).toContain("fixed");

    click(container, "隐藏");
    expect(
      container.querySelector('[data-testid="journey-review-panel"]')
    ).toBeFalsy();
    click(container, "审核");
    expect(
      dock?.querySelector('[data-testid="journey-review-panel"]')
    ).toBeTruthy();
  });
});
