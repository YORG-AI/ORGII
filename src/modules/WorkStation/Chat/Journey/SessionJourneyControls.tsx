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
  compareSameAnchorForks,
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

export const SessionJourneyControls: React.FC<{
  sessionId: string | null;
  messageId?: string | null;
  onJumpToMessage?: (messageId: string) => void;
}> = ({ sessionId, messageId, onJumpToMessage }) => {
  const [snapshot, setSnapshot] = useState<JourneySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    "task" | "checkpoint" | "finish" | "fork" | null
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
    if (!sessionId) return setSnapshot(null);
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
  const reviews = visibleReviews(snapshot);
  const revision = snapshot?.revision ?? 0;
  const needsAnchor = !messageId;
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
    if (dialog === "checkpoint" && messageId)
      return () =>
        sessionJourneyApi.checkpoint({
          sessionId,
          expectedRevision: revision,
          checkpointId: makeId("checkpoint"),
          name,
          messageId,
        });
    if (dialog === "finish" && messageId)
      return () =>
        sessionJourneyApi.finishTask({
          sessionId,
          expectedRevision: revision,
          outcome,
          messageId,
        });
    if (dialog === "fork" && messageId)
      return () =>
        sessionJourneyApi.startFork({
          sessionId,
          expectedRevision: revision,
          forkId: makeId("fork"),
          taskId: makeId("task"),
          taskName: name,
          anchorMessageId: messageId,
        });
    return null;
  }, [dialog, messageId, name, outcome, position, revision, sessionId]);
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
          disabled={needsAnchor}
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
              disabled={needsAnchor}
            >
              检查点
            </Button>
            <Button
              size="small"
              appearance="ghost"
              icon={<X size={14} />}
              onClick={() => setDialog("finish")}
              disabled={needsAnchor}
            >
              结束
            </Button>
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
        needsAnchor={needsAnchor}
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
      {panelMode !== "hidden" && (
        <ReviewPanel
          mode={panelMode}
          reviews={reviews}
          snapshot={snapshot}
          sessionId={sessionId}
          onMode={setMode}
          onReload={reload}
          onJump={onJumpToMessage}
        />
      )}
    </>
  );
};

const JourneyDialog: React.FC<{
  kind: "task" | "checkpoint" | "finish" | "fork" | null;
  name: string;
  position: "最近用户消息" | "下一条用户消息";
  outcome: TaskOutcome;
  needsAnchor: boolean;
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
  needsAnchor,
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
            : "结束任务"
    }
    okText="确认"
    cancelText="取消"
    onClose={onClose}
    onCancel={onClose}
    onOk={onSubmit}
    okButtonProps={{
      disabled:
        (kind !== "finish" && !name.trim()) || (kind !== "task" && needsAnchor),
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
    {kind === "finish" ? (
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
    {kind !== "task" && needsAnchor ? (
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
  sessionId: string;
  onMode: (mode: ReviewPanelMode) => void;
  onReload: () => Promise<void>;
  onJump?: (messageId: string) => void;
}> = ({ mode, reviews, snapshot, sessionId, onMode, onReload, onJump }) => {
  const panelClass =
    mode === "float"
      ? "fixed right-5 top-20 z-50 w-80 shadow-lg"
      : "fixed left-0 top-20 z-40 w-80 border-r";
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
        <p className="text-xs text-text-3">当前没有待处理审核。</p>
      )}
      {reviews.map((review) => {
        const fork = snapshot?.branches[review.fork_id];
        const capsule = fork?.handoff_capsule;
        return (
          <section
            key={review.id}
            className="mb-2 border-t border-border-2 pt-2"
          >
            <div className="font-medium">
              {review.state === "ready"
                ? "可审核"
                : review.state === "failed"
                  ? "审核失败"
                  : "等待审核"}
            </div>
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
                        evidenceStartMessageId:
                          fork?.parent_anchor_message_id ?? "",
                        evidenceEndMessageId:
                          fork?.parent_anchor_message_id ?? "",
                      })
                    )
                  }
                >
                  确认并提升
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
                    void mutate(() =>
                      sessionJourneyApi.discard({
                        sessionId,
                        expectedRevision: snapshot?.revision ?? 0,
                        reviewId: review.id,
                      })
                    );
                }}
              >
                丢弃
              </Button>
              <Button
                size="small"
                appearance="ghost"
                icon={<ChevronLeft size={14} />}
                onClick={() =>
                  void mutate(() =>
                    sessionJourneyApi.returnToParent({
                      sessionId,
                      expectedRevision: snapshot?.revision ?? 0,
                      reviewId: review.id,
                    })
                  )
                }
              >
                返回主干
              </Button>
            </div>
          </section>
        );
      })}
      {compareSameAnchorForks(snapshot).map(([anchor, forks]) => (
        <section key={anchor} className="border-t border-border-2 pt-2 text-xs">
          <strong>同锚点分叉对比（{anchor}）</strong>
          {forks.map((fork) => (
            <p key={fork.id} className="mt-1">
              {fork.id}：{fork.handoff_capsule?.conclusion ?? "尚无结构化结论"}
            </p>
          ))}
        </section>
      ))}
    </aside>
  );
};
