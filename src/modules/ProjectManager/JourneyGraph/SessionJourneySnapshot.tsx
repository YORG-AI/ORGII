import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  type JourneySnapshot,
  sessionJourneyApi,
} from "@src/api/tauri/sessionJourney";
import {
  Flag01Icon,
  GitForkIcon,
  HugeiconsIcon,
  ListChecksIcon,
  Location01Icon,
} from "@src/icons";
import { requestJourneyMessageJump } from "@src/modules/WorkStation/Chat/Journey/journeyMessageJump";

const taskStateLabel = (state: string) =>
  ({
    active: "进行中",
    finished: "已结束",
    pending: "待开始",
    pending_next_user: "等待下一条用户消息",
  })[state] ?? state;
const outcomeLabel = (outcome: string) =>
  ({
    completed: "完成",
    partially_completed: "部分完成",
    paused: "暂停",
    abandoned: "放弃",
    redirected: "转向",
  })[outcome] ?? outcome;
const forkStateLabel = (state: string) =>
  ({
    active: "进行中",
    closing: "审核中",
    close_failed: "关闭失败",
    closed: "已关闭",
    discarded: "已丢弃",
  })[state] ?? state;
const reviewStateLabel = (state: string) =>
  ({
    queued: "等待审核",
    ready: "可审核",
    confirmed: "已确认",
    discarded: "已丢弃",
    failed: "审核失败",
  })[state] ?? state;

export const SessionJourneySnapshot: React.FC<{
  sessionId: string;
  selectedTaskId?: string;
  selectedForkId?: string;
  selectedAnchorMessageId?: string;
}> = ({
  sessionId,
  selectedTaskId,
  selectedForkId,
  selectedAnchorMessageId,
}) => {
  const [snapshot, setSnapshot] = useState<{
    sessionId: string;
    value: JourneySnapshot;
  } | null>(null);
  const [error, setError] = useState<{
    sessionId: string;
    value: string;
  } | null>(null);
  const requestGenerationRef = useRef(0);
  const reload = useCallback(async () => {
    const generation = ++requestGenerationRef.current;
    try {
      const response = await sessionJourneyApi.snapshot(sessionId);
      if (generation !== requestGenerationRef.current) return;
      setSnapshot({ sessionId, value: response.snapshot });
      setError(null);
    } catch (reason) {
      if (generation !== requestGenerationRef.current) return;
      setError({ sessionId, value: String(reason) });
    }
  }, [sessionId]);
  useEffect(() => {
    // Invalidate previous requests before scheduling the new session fetch.
    requestGenerationRef.current += 1;
    const timer = window.setTimeout(() => void reload(), 0);
    return () => {
      window.clearTimeout(timer);
      requestGenerationRef.current += 1;
    };
  }, [sessionId, reload]);
  const currentSnapshot =
    snapshot?.sessionId === sessionId ? snapshot.value : null;
  const currentError = error?.sessionId === sessionId ? error.value : null;
  if (currentError)
    return (
      <p className="p-3 text-xs text-warning-6">
        旅程快照不可用：{currentError}
      </p>
    );
  if (!currentSnapshot)
    return <p className="p-3 text-xs text-text-3">正在加载会话旅程...</p>;
  return (
    <section
      className="border-b border-border-2 p-3"
      data-testid="session-journey-snapshot"
    >
      <div className="mb-2 flex items-center gap-2">
        <strong className="text-sm text-text-1">会话旅程</strong>
        <span className="text-xs text-text-3">
          修订 {currentSnapshot.revision}
        </span>
      </div>
      {selectedAnchorMessageId && (
        <p
          className="mb-2 text-xs text-text-3"
          data-testid="session-journey-selected-anchor"
        >
          精确回溯锚点：{selectedAnchorMessageId}
        </p>
      )}
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {Object.values(currentSnapshot.tasks).map((task) => (
          <div
            className={`border p-2 text-xs ${task.id === selectedTaskId ? "border-primary-6 bg-primary-1" : "border-border-2"}`}
            key={task.id}
          >
            <HugeiconsIcon
              icon={Flag01Icon}
              data-icon="flag"
              size={14}
              className="mb-1 text-primary-6"
            />
            <strong>{task.name}</strong>
            <p className="mt-1 text-text-3">
              {taskStateLabel(task.state)}
              {task.outcome ? ` · ${outcomeLabel(task.outcome)}` : ""}
            </p>
          </div>
        ))}
        {Object.values(currentSnapshot.branches)
          .filter((fork) => fork.id !== fork.parent_branch_id)
          .map((fork) => (
            <div
              className={`border p-2 text-xs ${fork.id === selectedForkId ? "border-primary-6 bg-primary-1" : "border-border-2"}`}
              key={fork.id}
            >
              <HugeiconsIcon
                icon={GitForkIcon}
                data-icon="git-fork"
                size={14}
                className="mb-1 text-success-6"
              />
              <strong>{fork.id}</strong>
              <p className="mt-1 text-text-3">
                锚点 {fork.anchor_sequence} · {forkStateLabel(fork.state)}
              </p>
            </div>
          ))}
        {Object.values(currentSnapshot.checkpoints).map((checkpoint) => (
          <button
            type="button"
            className="border border-border-2 p-2 text-left text-xs hover:bg-fill-2"
            key={checkpoint.id}
            onClick={() =>
              requestJourneyMessageJump(sessionId, checkpoint.message_id)
            }
          >
            <HugeiconsIcon
              icon={Location01Icon}
              data-icon="map-pin"
              size={14}
              className="mb-1 text-warning-6"
            />
            <strong>{checkpoint.name}</strong>
            <p className="mt-1 text-text-3">
              跳到精确消息 #{checkpoint.sequence}
            </p>
          </button>
        ))}
        {Object.values(currentSnapshot.reviews).map((review) => (
          <div className="border border-border-2 p-2 text-xs" key={review.id}>
            <HugeiconsIcon
              icon={ListChecksIcon}
              data-icon="list-checks"
              size={14}
              className="mb-1 text-text-2"
            />
            <strong>审核</strong>
            <p className="mt-1 text-text-3">
              {reviewStateLabel(review.state)} · {review.fork_id}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
};
