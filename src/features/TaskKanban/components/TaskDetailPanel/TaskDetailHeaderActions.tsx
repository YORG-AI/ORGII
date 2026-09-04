import type { TFunction } from "i18next";
import React from "react";

import Button from "@src/components/Button";
import {
  ArrowDown01Icon,
  Delete02Icon,
  GitMergeIcon,
  HugeiconsIcon,
} from "@src/icons";

import {
  MERGE_STRATEGY_OPTIONS,
  type MergeStrategy,
  getMergeStrategyLabel,
} from "./helpers";

interface TaskDetailHeaderActionsProps {
  canMerge: boolean;
  mergeLoading: boolean;
  discardLoading: boolean;
  strategyOpen: boolean;
  mergeStrategy: MergeStrategy;
  mergeButtonTitle: string;
  strategyRef: React.RefObject<HTMLDivElement | null>;
  t: TFunction<"sessions">;
  onMerge: () => void;
  onDiscard: () => void;
  onToggleStrategy: () => void;
  onSelectStrategy: (strategy: MergeStrategy) => void;
}

const TaskDetailHeaderActions: React.FC<TaskDetailHeaderActionsProps> = ({
  canMerge,
  mergeLoading,
  discardLoading,
  strategyOpen,
  mergeStrategy,
  mergeButtonTitle,
  strategyRef,
  t,
  onMerge,
  onDiscard,
  onToggleStrategy,
  onSelectStrategy,
}) => (
  <div className="flex items-center gap-px">
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
            icon={
              <HugeiconsIcon
                icon={GitMergeIcon}
                data-icon="git-merge"
                size={14}
                strokeWidth={1.75}
              />
            }
          />
          <Button
            size="small"
            variant="tertiary"
            iconOnly
            onClick={onToggleStrategy}
            disabled={mergeLoading || discardLoading}
            title={t("kanban.merge.strategyLabel")}
            aria-label={t("kanban.merge.strategyLabel")}
            icon={
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                data-icon="chevron-down"
                size={14}
                strokeWidth={1.75}
              />
            }
          />
          {strategyOpen && (
            <div className="absolute top-full right-0 z-50 mt-1 min-w-[140px] rounded-md border border-border-1 bg-bg-1 py-1 shadow-lg">
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
          icon={
            <HugeiconsIcon
              icon={Delete02Icon}
              data-icon="trash-2"
              size={14}
              strokeWidth={1.75}
            />
          }
        />
      </>
    )}
  </div>
);

export default TaskDetailHeaderActions;
