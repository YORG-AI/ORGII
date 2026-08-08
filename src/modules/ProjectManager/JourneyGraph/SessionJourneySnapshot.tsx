import { Flag, GitFork, ListChecks, MapPin } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";

import {
  type JourneySnapshot,
  sessionJourneyApi,
} from "@src/api/tauri/sessionJourney";
import { requestJourneyMessageJump } from "@src/modules/WorkStation/Chat/Journey/journeyMessageJump";

const taskStateLabel = (state: string) =>
  ({ active: "进行中", finished: "已结束", pending: "待开始" })[state] ?? state;
const outcomeLabel = (outcome: string) =>
  ({
    completed: "完成",
    partially_completed: "部分完成",
    paused: "暂停",
    abandoned: "放弃",
    redirected: "转向",
  })[outcome] ?? outcome;
const forkStateLabel = (state: string) =>
  ({ active: "进行中", closing: "审核中", closed: "已关闭" })[state] ?? state;
const reviewStateLabel = (state: string) =>
  ({
    queued: "等待审核",
    ready: "可审核",
    confirmed: "已确认",
    discarded: "已丢弃",
    failed: "审核失败",
  })[state] ?? state;

export const SessionJourneySnapshot: React.FC<{ sessionId: string }> = ({
  sessionId,
}) => {
  const [snapshot, setSnapshot] = useState<JourneySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const response = await sessionJourneyApi.snapshot(sessionId);
      setSnapshot(response.snapshot);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }, [sessionId]);
  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);
  if (error)
    return (
      <p className="p-3 text-xs text-warning-6">旅程快照不可用：{error}</p>
    );
  if (!snapshot)
    return <p className="p-3 text-xs text-text-3">正在加载会话旅程...</p>;
  return (
    <section
      className="border-b border-border-2 p-3"
      data-testid="session-journey-snapshot"
    >
      <div className="mb-2 flex items-center gap-2">
        <strong className="text-sm text-text-1">会话旅程</strong>
        <span className="text-xs text-text-3">修订 {snapshot.revision}</span>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {Object.values(snapshot.tasks).map((task) => (
          <div className="border border-border-2 p-2 text-xs" key={task.id}>
            <Flag size={14} className="mb-1 text-primary-6" />
            <strong>{task.name}</strong>
            <p className="mt-1 text-text-3">
              {taskStateLabel(task.state)}
              {task.outcome ? ` · ${outcomeLabel(task.outcome)}` : ""}
            </p>
          </div>
        ))}
        {Object.values(snapshot.branches)
          .filter((fork) => fork.id !== fork.parent_branch_id)
          .map((fork) => (
            <div className="border border-border-2 p-2 text-xs" key={fork.id}>
              <GitFork size={14} className="mb-1 text-success-6" />
              <strong>{fork.id}</strong>
              <p className="mt-1 text-text-3">
                锚点 {fork.anchor_sequence} · {forkStateLabel(fork.state)}
              </p>
            </div>
          ))}
        {Object.values(snapshot.checkpoints).map((checkpoint) => (
          <button
            type="button"
            className="border border-border-2 p-2 text-left text-xs hover:bg-fill-2"
            key={checkpoint.id}
            onClick={() =>
              requestJourneyMessageJump(sessionId, checkpoint.message_id)
            }
          >
            <MapPin size={14} className="mb-1 text-warning-6" />
            <strong>{checkpoint.name}</strong>
            <p className="mt-1 text-text-3">
              跳到精确消息 #{checkpoint.sequence}
            </p>
          </button>
        ))}
        {Object.values(snapshot.reviews).map((review) => (
          <div className="border border-border-2 p-2 text-xs" key={review.id}>
            <ListChecks size={14} className="mb-1 text-text-2" />
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
