import {
  ChevronLeft,
  Flag,
  GitFork,
  MapPin,
  PanelLeft,
  Play,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import {
  type ForkCompareResponse,
  type JourneyReview,
  type JourneySnapshot,
  type TaskOutcome,
  sessionJourneyApi,
} from "@src/api/tauri/sessionJourney";
import Button from "@src/components/Button";
import Modal from "@src/scaffold/ModalSystem";

import {
  REVIEW_PANEL_STORAGE_KEY,
  type ReviewPanelMode,
  activeTask,
  hasRecoverableJourney,
  isRevisionConflict,
  visibleReviews,
} from "./sessionJourneyModel";

const outcomeOptions: Array<{ value: TaskOutcome; label: string }> = [
  { value: "completed", label: "完成" },
  { value: "partially_completed", label: "部分完成" },
  { value: "paused", label: "暂停" },
  { value: "abandoned", label: "放弃" },
  { value: "redirected", label: "转向" },
];

const makeId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

/**
 * Live user events are emitted as `user-message-{durable id}` while hydrated
 * transcript rows already use the durable `agent_messages.id`. Journey
 * commands address the durable row, so normalize only at this boundary. Do
 * not alter the global SessionEvent identity: stream reconciliation relies on
 * the prefixed live id.
 */
export const resolveDurableJourneyMessageId = (
  messageId: string | null | undefined
): string | null => {
  if (!messageId) return null;
  // Optimistic bubbles are excluded at their source via
  // `isSyntheticUserInputEvent` in ChatView. Do not reject by `user-input-*`
  // prefix here: CLI persistence can legitimately emit a durable message ID
  // with that prefix, and strict Journey actions must preserve it exactly.
  const liveUserEventPrefix = "user-message-";
  return messageId.startsWith(liveUserEventPrefix)
    ? messageId.slice(liveUserEventPrefix.length) || null
    : messageId;
};

export const SessionJourneyControls: React.FC<{
  sessionId: string | null;
  messageId?: string | null;
  onJumpToMessage?: (messageId: string) => void;
  /** Docked content is rendered by the Communication WorkStation secondary pane. */
  onDockedReviewPanelChange?: (panel: React.ReactNode | null) => void;
}> = ({ sessionId, messageId, onJumpToMessage, onDockedReviewPanelChange }) => {
  const [snapshot, setSnapshot] = useState<JourneySnapshot | null>(null);
  const [comparison, setComparison] = useState<ForkCompareResponse | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    "task" | "checkpoint" | "finish" | "fork" | "closeFork" | null
  >(null);
  const [name, setName] = useState("");
  const [position, setPosition] = useState<"最近用户消息" | "下一条用户消息">(
    "最近用户消息"
  );
  const [outcome, setOutcome] = useState<TaskOutcome>("completed");
  const [showRecovery, setShowRecovery] = useState(false);
  const [panelMode, setPanelMode] = useState<ReviewPanelMode>(
    () =>
      (localStorage.getItem(REVIEW_PANEL_STORAGE_KEY) as ReviewPanelMode) ||
      "hidden"
  );
  const reload = useCallback(async () => {
    if (!sessionId) {
      setSnapshot(null);
      setComparison(null);
      return;
    }
    try {
      const [response, forkComparison] = await Promise.all([
        sessionJourneyApi.snapshot(sessionId),
        sessionJourneyApi.forkCompare(sessionId),
      ]);
      setSnapshot(response.snapshot);
      setComparison(forkComparison);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }, [sessionId]);
  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);
  useEffect(() => {
    if (
      snapshot &&
      hasRecoverableJourney(snapshot) &&
      sessionStorage.getItem(`orgii-journey-recovery:${sessionId}`) !== "seen"
    )
      queueMicrotask(() => setShowRecovery(true));
  }, [sessionId, snapshot]);
  useEffect(() => {
    if (panelMode !== "hidden") {
      const timer = window.setInterval(() => void reload(), 5000);
      return () => window.clearInterval(timer);
    }
  }, [panelMode, reload]);
  const setMode = (mode: ReviewPanelMode) => {
    localStorage.setItem(REVIEW_PANEL_STORAGE_KEY, mode);
    setPanelMode(mode);
  };
  const mutate = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
      setDialog(null);
      setName("");
      await reload();
    } catch (reason) {
      if (isRevisionConflict(reason)) await reload();
      setError(String(reason));
    }
  };
  const task = activeTask(snapshot);
  const reviews = useMemo(() => visibleReviews(snapshot), [snapshot]);
  const revision = snapshot?.revision ?? 0;
  const durableMessageId = resolveDurableJourneyMessageId(messageId);
  const needsExplicitAnchor = !durableMessageId;
  useEffect(() => {
    if (!onDockedReviewPanelChange) return;
    onDockedReviewPanelChange(
      panelMode === "dock" ? (
        <ReviewPanel
          mode={panelMode}
          reviews={reviews}
          snapshot={snapshot}
          comparison={comparison}
          sessionId={sessionId ?? ""}
          selectedEvidenceMessageId={durableMessageId}
          onMode={setMode}
          onReload={reload}
          onJump={onJumpToMessage}
        />
      ) : null
    );
    return () => onDockedReviewPanelChange(null);
  }, [
    comparison,
    durableMessageId,
    onDockedReviewPanelChange,
    onJumpToMessage,
    panelMode,
    reload,
    reviews,
    sessionId,
    snapshot,
  ]);
  const action = useMemo(() => {
    if (!sessionId) return null;
    if (dialog === "task")
      return () =>
        sessionJourneyApi.startTask({
          sessionId,
          expectedRevision: revision,
          taskId: makeId("task"),
          name,
          position,
        });
    if (dialog === "checkpoint" && durableMessageId)
      return () =>
        sessionJourneyApi.checkpoint({
          sessionId,
          expectedRevision: revision,
          checkpointId: makeId("checkpoint"),
          name,
          messageId: durableMessageId,
        });
    if (dialog === "finish" && durableMessageId)
      return () =>
        sessionJourneyApi.finishTask({
          sessionId,
          expectedRevision: revision,
          outcome,
          messageId: durableMessageId,
        });
    if (dialog === "closeFork" && durableMessageId)
      return () =>
        sessionJourneyApi.closeFork(
          {
            sessionId,
            expectedRevision: revision,
            forkId: snapshot?.active_branch_id ?? "",
            reviewId: makeId("review"),
            outcome,
            messageId: durableMessageId,
          },
          makeId("review-job")
        );
    if (dialog === "fork")
      return () =>
        sessionJourneyApi.startFork({
          sessionId,
          expectedRevision: revision,
          forkId: makeId("fork"),
          taskId: makeId("task"),
          taskName: name,
          // An omitted anchor is the explicit direct-Fork semantic. The
          // backend resolves only the latest durable user row in the active
          // branch; every other action remains strict and explicit.
          ...(durableMessageId ? { anchorMessageId: durableMessageId } : {}),
        });
    return null;
  }, [
    dialog,
    durableMessageId,
    name,
    outcome,
    position,
    revision,
    sessionId,
    snapshot?.active_branch_id,
  ]);
  if (!sessionId) return null;
  return (
    <>
      <div
        className="flex items-center gap-1"
        data-testid="session-journey-controls"
      >
        {task ? (
          <span
            className="inline-flex max-w-44 items-center gap-1 truncate rounded border border-primary-5 bg-primary-1 px-2 py-1 text-xs text-primary-7"
            title={task.name}
          >
            <Flag size={13} />
            任务：{task.name}
          </span>
        ) : (
          <Button
            size="small"
            appearance="ghost"
            icon={<Play size={14} />}
            onClick={() => setDialog("task")}
          >
            开始任务
          </Button>
        )}
        <Button
          size="small"
          appearance="ghost"
          icon={<GitFork size={14} />}
          onClick={() => setDialog("fork")}
          title={
            durableMessageId
              ? "从当前用户消息创建分叉"
              : "将从当前分支最近一条已持久化的用户消息创建分叉"
          }
        >
          分叉
        </Button>
        {task && (
          <>
            <Button
              size="small"
              appearance="ghost"
              icon={<MapPin size={14} />}
              onClick={() => setDialog("checkpoint")}
              disabled={needsExplicitAnchor}
            >
              检查点
            </Button>
            <Button
              size="small"
              appearance="ghost"
              icon={<X size={14} />}
              onClick={() => setDialog("finish")}
              disabled={needsExplicitAnchor}
            >
              结束
            </Button>
            {snapshot?.active_branch_id !== "main" && (
              <Button
                size="small"
                appearance="ghost"
                icon={<X size={14} />}
                onClick={() => setDialog("closeFork")}
                disabled={needsExplicitAnchor}
                title="结束分叉并进入审核"
              >
                关闭分叉
              </Button>
            )}
          </>
        )}
        <Button
          size="small"
          appearance="ghost"
          icon={<PanelLeft size={14} />}
          onClick={() => setMode(panelMode === "hidden" ? "dock" : "hidden")}
        >
          审核{reviews.length ? ` ${reviews.length}` : ""}
        </Button>
      </div>
      {error && (
        <span className="text-xs text-danger-6" role="alert">
          旅程操作失败：{error}
        </span>
      )}
      <JourneyDialog
        kind={dialog}
        name={name}
        position={position}
        outcome={outcome}
        needsExplicitAnchor={needsExplicitAnchor}
        onClose={() => setDialog(null)}
        onName={setName}
        onPosition={setPosition}
        onOutcome={setOutcome}
        onSubmit={() => action && void mutate(action)}
      />
      <Modal
        visible={showRecovery}
        title="恢复会话旅程"
        footer={
          <div className="flex justify-end gap-2 p-3">
            <Button
              size="small"
              appearance="ghost"
              onClick={() => {
                sessionStorage.setItem(
                  `orgii-journey-recovery:${sessionId}`,
                  "seen"
                );
                setShowRecovery(false);
              }}
            >
              继续当前会话
            </Button>
            <Button
              size="small"
              onClick={() => {
                sessionStorage.setItem(
                  `orgii-journey-recovery:${sessionId}`,
                  "seen"
                );
                setShowRecovery(false);
                setMode("dock");
              }}
            >
              查看 Journey
            </Button>
          </div>
        }
        onClose={() => {
          sessionStorage.setItem(`orgii-journey-recovery:${sessionId}`, "seen");
          setShowRecovery(false);
        }}
      >
        <p className="text-sm text-text-2">
          此会话有未结束的任务或分叉。你可以继续当前会话，或查看 Journey
          后再决定。
        </p>
      </Modal>
      {panelMode !== "hidden" && panelMode !== "dock" && (
        <ReviewPanel
          mode={panelMode}
          reviews={reviews}
          snapshot={snapshot}
          comparison={comparison}
          sessionId={sessionId ?? ""}
          selectedEvidenceMessageId={durableMessageId}
          onMode={setMode}
          onReload={reload}
          onJump={onJumpToMessage}
        />
      )}
    </>
  );
};

const JourneyDialog: React.FC<{
  kind: "task" | "checkpoint" | "finish" | "fork" | "closeFork" | null;
  name: string;
  position: "最近用户消息" | "下一条用户消息";
  outcome: TaskOutcome;
  needsExplicitAnchor: boolean;
  onClose: () => void;
  onName: (value: string) => void;
  onPosition: (value: "最近用户消息" | "下一条用户消息") => void;
  onOutcome: (value: TaskOutcome) => void;
  onSubmit: () => void;
}> = ({
  kind,
  name,
  position,
  outcome,
  needsExplicitAnchor,
  onClose,
  onName,
  onPosition,
  onOutcome,
  onSubmit,
}) => (
  <Modal
    visible={kind !== null}
    title={
      kind === "task"
        ? "开始任务"
        : kind === "checkpoint"
          ? "创建检查点"
          : kind === "fork"
            ? "创建分叉任务"
            : kind === "closeFork"
              ? "关闭分叉并进入审核"
              : "结束任务"
    }
    okText="确认"
    cancelText="取消"
    onClose={onClose}
    onCancel={onClose}
    onOk={onSubmit}
    okButtonProps={{
      disabled:
        (kind !== "finish" && kind !== "closeFork" && !name.trim()) ||
        ((kind === "checkpoint" || kind === "finish" || kind === "closeFork") &&
          needsExplicitAnchor),
    }}
  >
    {kind === "task" || kind === "checkpoint" || kind === "fork" ? (
      <label className="block text-sm text-text-2">
        名称
        <input
          autoFocus
          value={name}
          onChange={(event) => onName(event.target.value)}
          className="mt-2 w-full rounded border border-border-2 bg-bg-1 px-2 py-1.5 text-text-1"
        />
      </label>
    ) : null}
    {kind === "task" ? (
      <label className="mt-3 block text-sm text-text-2">
        起点
        <select
          value={position}
          onChange={(event) =>
            onPosition(event.target.value as "最近用户消息" | "下一条用户消息")
          }
          className="mt-2 w-full rounded border border-border-2 bg-bg-1 px-2 py-1.5 text-text-1"
        >
          <option value="最近用户消息">从最近一条用户消息开始</option>
          <option value="下一条用户消息">从下一条用户消息开始</option>
        </select>
      </label>
    ) : null}
    {kind === "finish" || kind === "closeFork" ? (
      <label className="block text-sm text-text-2">
        结果
        <select
          value={outcome}
          onChange={(event) => onOutcome(event.target.value as TaskOutcome)}
          className="mt-2 w-full rounded border border-border-2 bg-bg-1 px-2 py-1.5 text-text-1"
        >
          {outcomeOptions.map((item) => (
            <option value={item.value} key={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
    ) : null}
    {kind === "closeFork" ? (
      <p className="mt-3 text-xs text-text-3">
        关闭后将以所选精确消息为结尾，并进入后台审核。
      </p>
    ) : null}
    {kind === "fork" && needsExplicitAnchor ? (
      <p className="mt-3 text-xs text-text-3">
        将使用当前分支最近一条已持久化的用户消息作为精确分叉锚点。
      </p>
    ) : null}
    {(kind === "checkpoint" || kind === "finish" || kind === "closeFork") &&
    needsExplicitAnchor ? (
      <p className="mt-3 text-xs text-warning-6">
        请先在消息列表中选择精确消息锚点。
      </p>
    ) : null}
  </Modal>
);

const ReviewPanel: React.FC<{
  mode: ReviewPanelMode;
  reviews: ReturnType<typeof visibleReviews>;
  snapshot: JourneySnapshot | null;
  comparison: ForkCompareResponse | null;
  sessionId: string;
  selectedEvidenceMessageId: string | null;
  onMode: (mode: ReviewPanelMode) => void;
  onReload: () => Promise<void>;
  onJump?: (messageId: string) => void;
}> = ({
  mode,
  reviews,
  snapshot,
  comparison,
  sessionId,
  selectedEvidenceMessageId,
  onMode,
  onReload,
  onJump,
}) => {
  const panelClass =
    mode === "float"
      ? "fixed right-5 top-20 z-50 w-80 shadow-lg"
      : "w-80 shrink-0 border-l border-border-2";
  const mutate = async (operation: () => Promise<unknown>) => {
    await operation();
    await onReload();
  };
  return (
    <aside
      className={`${panelClass} max-h-[calc(100vh-6rem)] overflow-auto bg-bg-1 p-3 text-sm text-text-1`}
      data-testid="journey-review-panel"
    >
      <div className="mb-2 flex items-center gap-1">
        <strong className="flex-1">分叉审核</strong>
        <Button
          size="small"
          appearance="ghost"
          onClick={() => onMode(mode === "dock" ? "float" : "dock")}
        >
          {mode === "dock" ? "浮动" : "吸附"}
        </Button>
        <Button
          size="small"
          appearance="ghost"
          onClick={() => onMode("hidden")}
        >
          隐藏
        </Button>
      </div>
      {!reviews.length && (
        <p className="text-xs text-text-3">当前没有审核记录。</p>
      )}
      {reviews.map((review) => {
        const fork = snapshot?.branches[review.fork_id];
        const capsule = fork?.handoff_capsule;
        return (
          <section
            key={review.id}
            className="mb-2 border-t border-border-2 pt-2"
          >
            <div className="font-medium">{reviewStateLabel(review.state)}</div>
            <p className="mt-1 text-xs text-text-2">
              {capsule?.conclusion ??
                review.annotation ??
                "正在等待上一分叉的提炼结果。"}
            </p>
            {capsule && (
              <>
                <p className="mt-1 text-xs">
                  确认项：{capsule.confirmed_items.join("；") || "无"}
                </p>
                <p className="mt-1 text-xs">
                  未决项：{capsule.open_questions.join("；") || "无"}
                </p>
              </>
            )}
            <p className="mt-1 text-xs text-warning-6">
              “可能无价值”仅为建议，丢弃需明确确认。
            </p>
            <div className="mt-2 flex gap-1">
              {review.state === "ready" && (
                <Button
                  size="small"
                  disabled={!selectedEvidenceMessageId}
                  title={
                    selectedEvidenceMessageId
                      ? "使用当前选中消息作为证据"
                      : "请先在该分叉中选择证据消息"
                  }
                  onClick={() =>
                    void mutate(() =>
                      sessionJourneyApi.confirm({
                        sessionId,
                        expectedRevision: snapshot?.revision ?? 0,
                        reviewId: review.id,
                        factId: makeId("fact"),
                        text:
                          capsule?.conclusion ??
                          review.annotation ??
                          "已确认分叉结论",
                        // The selected message is the evidence anchor. Parent
                        // fork anchors are navigation points, never evidence.
                        evidenceStartMessageId: selectedEvidenceMessageId ?? "",
                        evidenceEndMessageId: selectedEvidenceMessageId ?? "",
                      })
                    )
                  }
                >
                  确认并提升
                </Button>
              )}
              {review.state === "failed" && (
                <Button
                  size="small"
                  appearance="ghost"
                  onClick={() =>
                    void mutate(() =>
                      sessionJourneyApi.retryReview({
                        sessionId,
                        expectedRevision: snapshot?.revision ?? 0,
                        reviewId: review.id,
                      })
                    )
                  }
                >
                  重试审核
                </Button>
              )}
              <Button
                size="small"
                appearance="ghost"
                onClick={() => onJump?.(fork?.parent_anchor_message_id ?? "")}
                disabled={!fork?.parent_anchor_message_id}
              >
                查看锚点
              </Button>
              <Button
                size="small"
                appearance="ghost"
                onClick={() => {
                  if (window.confirm("确认丢弃这个分叉审核吗？"))
                    void mutate(async () => {
                      const result = await sessionJourneyApi.discard({
                        sessionId,
                        expectedRevision: snapshot?.revision ?? 0,
                        reviewId: review.id,
                      });
                      onJump?.(result.parent_anchor_message_id);
                    });
                }}
              >
                丢弃
              </Button>
              <Button
                size="small"
                appearance="ghost"
                icon={<ChevronLeft size={14} />}
                onClick={() =>
                  void mutate(async () => {
                    const result = await sessionJourneyApi.returnToParent({
                      sessionId,
                      expectedRevision: snapshot?.revision ?? 0,
                      reviewId: review.id,
                    });
                    onJump?.(result.parent_anchor_message_id);
                  })
                }
              >
                返回主干
              </Button>
            </div>
          </section>
        );
      })}
      {comparison?.groups.map((group) => (
        <section
          key={`${group.parent_branch_id}:${group.anchor_sequence}`}
          className="border-t border-border-2 pt-2 text-xs"
        >
          <strong>同锚点分叉对比（{group.anchor_sequence}）</strong>
          {group.forks.map((fork) => (
            <p key={fork.branch_id} className="mt-1">
              {fork.branch_name}：{fork.conclusion ?? "尚无结构化结论"}
              {fork.tasks.length
                ? `（${fork.tasks
                    .map(
                      (task) =>
                        `${task.name}：${
                          task.outcome
                            ? journeyOutcomeLabel(task.outcome)
                            : journeyTaskStateLabel(task.state)
                        }`
                    )
                    .join("；")}）`
                : ""}
            </p>
          ))}
        </section>
      ))}
      {Object.values(snapshot?.checkpoints ?? {}).map((checkpoint) => (
        <section
          key={checkpoint.id}
          className="border-t border-border-2 pt-2 text-xs"
        >
          <strong>检查点：{checkpoint.name}</strong>
          <Button
            size="small"
            appearance="ghost"
            className="ml-2"
            onClick={() => onJump?.(checkpoint.message_id)}
          >
            跳转
          </Button>
        </section>
      ))}
    </aside>
  );
};

function journeyTaskStateLabel(state: string) {
  return (
    {
      pending_next_user: "等待下一条用户消息",
      pending: "待开始",
      active: "进行中",
      finished: "已结束",
    }[state] ?? state
  );
}

function journeyOutcomeLabel(outcome: string) {
  return (
    outcomeOptions.find((option) => option.value === outcome)?.label ?? outcome
  );
}

function reviewStateLabel(state: JourneyReview["state"]) {
  switch (state) {
    case "queued":
      return "等待审核";
    case "ready":
      return "可审核";
    case "confirmed":
      return "已确认";
    case "discarded":
      return "已丢弃";
    case "failed":
      return "审核失败";
  }
}
