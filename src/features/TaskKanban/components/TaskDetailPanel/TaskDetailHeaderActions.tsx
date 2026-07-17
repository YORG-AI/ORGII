import type { TFunction } from "i18next";
import { ChevronDown, GitMerge, Play, Trash2 } from "lucide-react";
import React from "react";

import Button from "@src/components/Button";

import {
  MERGE_STRATEGY_OPTIONS,
  type MergeStrategy,
  getMergeStrategyLabel,
} from "./helpers";

interface TaskDetailHeaderActionsProps {
  canReplay: boolean;
  canMerge: boolean;
  mergeLoading: boolean;
  discardLoading: boolean;
  strategyOpen: boolean;
  mergeStrategy: MergeStrategy;
  mergeButtonTitle: string;
  strategyRef: React.RefObject<HTMLDivElement | null>;
  t: TFunction<"sessions">;
  onReplay: () => void;
  onMerge: () => void;
  onDiscard: () => void;
  onToggleStrategy: () => void;
  onSelectStrategy: (strategy: MergeStrategy) => void;
}

const TaskDetailHeaderActions: React.FC<TaskDetailHeaderActionsProps> = ({
  canReplay,
  canMerge,
  mergeLoading,
  discardLoading,
  strategyOpen,
  mergeStrategy,
  mergeButtonTitle,
  strategyRef,
  t,
  onReplay,
  onMerge,
  onDiscard,
  onToggleStrategy,
  onSelectStrategy,
}) => (
  <div className="flex items-center gap-px">
    {canReplay && (
      <Button
        size="small"
        variant="tertiary"
        onClick={onReplay}
        title={t("kanban.replay.replaySession")}
        icon={<Play size={14} fill="currentColor" strokeWidth={0} />}
      >
        {t("kanban.replay.replaySession")}
      </Button>
    )}
    {canMerge && (
      <>
        <div className="relative flex items-center" ref={strategyRef}>
          <Button
            size="small"
            variant="tertiary"
            iconOnly
            onClick={onMerge}
            loading={mergeLoading}
            disabled={mergeLoading || discardLoading}
            title={mergeButtonTitle}
            aria-label={mergeButtonTitle}
            icon={<GitMerge size={14} strokeWidth={1.75} />}
          />
          <Button
            size="small"
            variant="tertiary"
            iconOnly
            onClick={onToggleStrategy}
            disabled={mergeLoading || discardLoading}
            title={t("kanban.merge.strategyLabel")}
            aria-label={t("kanban.merge.strategyLabel")}
            icon={<ChevronDown size={14} strokeWidth={1.75} />}
          />
          {strategyOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 min-w-[140px] rounded-md border border-border-1 bg-bg-1 py-1 shadow-lg">
              {MERGE_STRATEGY_OPTIONS.map((strategy) => (
                <button
                  key={strategy}
                  className={`flex w-full items-center px-3 py-1.5 text-left text-[12px] hover:bg-bg-2 ${
                    mergeStrategy === strategy
                      ? "font-medium text-text-1"
                      : "text-text-2"
                  }`}
                  onClick={() => onSelectStrategy(strategy)}
                >
                  {getMergeStrategyLabel(strategy, t)}
                </button>
              ))}
            </div>
          )}
        </div>
        <Button
          size="small"
          variant="tertiary"
          iconOnly
          onClick={onDiscard}
          loading={discardLoading}
          disabled={mergeLoading || discardLoading}
          title={t("common:actions.delete")}
          aria-label={t("common:actions.delete")}
          icon={<Trash2 size={14} strokeWidth={1.75} />}
        />
      </>
    )}
  </div>
);

export default TaskDetailHeaderActions;
