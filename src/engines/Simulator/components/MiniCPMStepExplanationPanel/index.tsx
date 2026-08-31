import { useAtomValue } from "jotai";
import React, { memo, useEffect, useMemo, useReducer, useRef } from "react";

import { sessionStepExplain } from "@src/api/services/keyValidation";
import {
  currentEventAtom,
  currentSimulatorEventIndexAtom,
  simulatorEventCountAtom,
} from "@src/engines/SessionCore";
import type { SessionEvent } from "@src/engines/SessionCore";
import { useHousekeeperConfig } from "@src/hooks/housekeeper";
import {
  AlertCircleIcon,
  Cancel01Icon,
  HugeiconsIcon,
  Loading03Icon,
  SparklesIcon,
} from "@src/icons";

type ExplanationStatus = "idle" | "loading" | "ready" | "fallback";

interface ExplanationState {
  status: ExplanationStatus;
  text: string;
  cacheKey?: string;
}

const STEP_EXPLANATION_CACHE_LIMIT = 200;
const STEP_EXPLANATION_CACHE = new Map<string, string>();
const IDLE_TEXT = "等待 session 步骤产生后，将请求本地 MiniCPM 生成解释。";
const LOADING_TEXT = "正在请求本地 MiniCPM 解释当前步骤...";
const DISABLED_TEXT = "常驻管家的步骤解释功能未开启。";
const UNCONFIGURED_TEXT =
  "需要先在常驻管家里配置 MiniCPM vLLM 账号，才能生成步骤解释。";
const EMPTY_RESPONSE_TEXT = "MiniCPM 返回了空解释，当前步骤暂时没有可用解释。";

function rememberExplanation(cacheKey: string, explanation: string): void {
  if (STEP_EXPLANATION_CACHE.has(cacheKey)) {
    STEP_EXPLANATION_CACHE.delete(cacheKey);
  }
  STEP_EXPLANATION_CACHE.set(cacheKey, explanation);
  if (STEP_EXPLANATION_CACHE.size > STEP_EXPLANATION_CACHE_LIMIT) {
    const firstKey = STEP_EXPLANATION_CACHE.keys().next().value;
    if (firstKey) STEP_EXPLANATION_CACHE.delete(firstKey);
  }
}

function buildErrorText(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const normalized = message.trim().replace(/\s+/g, " ");
  if (!normalized)
    return "MiniCPM 暂时无法解释当前步骤，请检查常驻管家连接状态。";
  return `MiniCPM 暂时无法解释当前步骤：${normalized.slice(0, 160)}`;
}

function buildCacheKey(event: SessionEvent | null): string | null {
  if (!event) return null;
  return `${event.id}:${event.displayStatus}`;
}

function toStepExplainRequest(event: SessionEvent) {
  return {
    eventId: event.id,
    functionName: event.functionName,
    actionType: event.actionType,
    displayText: event.displayText,
    displayStatus: event.displayStatus,
    displayVariant: event.displayVariant,
    source: event.source,
    filePath: event.filePath ?? null,
    command: event.command ?? null,
    args: event.args,
    result: event.result,
  };
}

function useMiniCPMStepExplanation(): ExplanationState & {
  currentIndex: number;
  eventCount: number;
} {
  const event = useAtomValue(currentEventAtom);
  const currentIndex = useAtomValue(currentSimulatorEventIndexAtom);
  const eventCount = useAtomValue(simulatorEventCountAtom);
  const housekeeper = useHousekeeperConfig();
  const cacheKey = useMemo(() => buildCacheKey(event), [event]);
  const requestSeqRef = useRef(0);
  const [state, dispatchState] = useReducer(
    (_prev: ExplanationState, next: ExplanationState) => next,
    {
      status: "idle",
      text: IDLE_TEXT,
      cacheKey: cacheKey ?? undefined,
    }
  );

  useEffect(() => {
    if (!event || !cacheKey) {
      dispatchState({
        status: "idle",
        text: IDLE_TEXT,
        cacheKey: undefined,
      });
      return;
    }

    if (!housekeeper.enabled || !housekeeper.features.stepExplain) {
      dispatchState({
        status: "fallback",
        text: DISABLED_TEXT,
        cacheKey,
      });
      return;
    }

    if (!housekeeper.isConfigured) {
      dispatchState({
        status: "fallback",
        text: UNCONFIGURED_TEXT,
        cacheKey,
      });
      return;
    }

    const cached = STEP_EXPLANATION_CACHE.get(cacheKey);
    if (cached) {
      dispatchState({ status: "ready", text: cached, cacheKey });
      return;
    }

    const requestSeq = ++requestSeqRef.current;
    dispatchState({ status: "loading", text: LOADING_TEXT, cacheKey });

    const timer = window.setTimeout(() => {
      void sessionStepExplain(toStepExplainRequest(event), {
        accountId: housekeeper.resolvedAccountId ?? undefined,
        model: housekeeper.resolvedModel,
      })
        .then((response) => {
          if (requestSeqRef.current !== requestSeq) return;
          const explanation = response.explanation.trim();
          if (!explanation) {
            dispatchState({
              status: "fallback",
              text: EMPTY_RESPONSE_TEXT,
              cacheKey,
            });
            return;
          }
          rememberExplanation(cacheKey, explanation);
          dispatchState({ status: "ready", text: explanation, cacheKey });
        })
        .catch((error: unknown) => {
          if (requestSeqRef.current !== requestSeq) return;
          dispatchState({
            status: "fallback",
            text: buildErrorText(error),
            cacheKey,
          });
        });
    }, 450);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    cacheKey,
    event,
    housekeeper.enabled,
    housekeeper.features.stepExplain,
    housekeeper.isConfigured,
    housekeeper.resolvedAccountId,
    housekeeper.resolvedModel,
  ]);

  return { ...state, currentIndex, eventCount };
}

interface MiniCPMStepExplanationPanelProps {
  onClose?: () => void;
}

const MiniCPMStepExplanationPanel: React.FC<MiniCPMStepExplanationPanelProps> =
  memo(({ onClose }) => {
    const { status, text, currentIndex, eventCount } =
      useMiniCPMStepExplanation();
    const hasStep = eventCount > 0 && currentIndex >= 0;
    const isUnavailable = status === "fallback";
    const statusLabel =
      status === "loading"
        ? "MiniCPM 解析中"
        : status === "ready"
          ? "MiniCPM"
          : status === "fallback"
            ? "MiniCPM 不可用"
            : "等待步骤";
    const icon =
      status === "loading" ? (
        <HugeiconsIcon
          icon={Loading03Icon}
          data-icon="loader-2"
          size={15}
          className="animate-spin text-primary-6"
        />
      ) : status === "fallback" ? (
        <HugeiconsIcon
          icon={AlertCircleIcon}
          data-icon="alert-circle"
          size={15}
          className="text-danger-6"
        />
      ) : (
        <HugeiconsIcon
          icon={SparklesIcon}
          data-icon="sparkles"
          size={15}
          className={hasStep ? "text-primary-6" : "text-text-4"}
        />
      );

    return (
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto relative w-full max-w-[760px] overflow-hidden rounded-lg border border-border-2 bg-bg-2/95 shadow-[0_14px_42px_rgba(15,23,42,0.14)] backdrop-blur-md"
      >
        <div
          className={`absolute inset-x-0 top-0 h-0.5 ${isUnavailable ? "bg-danger-6/70" : "bg-primary-6/80"}`}
        />
        {onClose ? (
          <button
            type="button"
            className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md text-text-4 transition-colors hover:bg-fill-2 hover:text-text-1"
            onClick={onClose}
            aria-label="关闭 MiniCPM 步骤解析"
            title="关闭 MiniCPM 步骤解析"
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              data-icon="x"
              size={14}
              strokeWidth={1.75}
            />
          </button>
        ) : null}
        <div className="flex min-h-[64px] min-w-0 items-start gap-3 px-3.5 py-3 pr-9">
          <div
            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${
              isUnavailable
                ? "border-danger-6/20 bg-danger-6/10"
                : "border-primary-6/20 bg-primary-6/10"
            }`}
          >
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex min-w-0 items-center gap-2 text-[11px] leading-none text-text-4">
              <span
                className={`font-semibold ${isUnavailable ? "text-danger-6" : "text-text-2"}`}
              >
                {statusLabel}
              </span>
              {hasStep ? (
                <span className="font-medium tabular-nums text-text-4">
                  {currentIndex + 1} / {eventCount}
                </span>
              ) : null}
            </div>
            <div className="line-clamp-2 text-[13px] leading-5 text-text-1">
              {text}
            </div>
          </div>
        </div>
      </div>
    );
  });

MiniCPMStepExplanationPanel.displayName = "MiniCPMStepExplanationPanel";

export default MiniCPMStepExplanationPanel;
