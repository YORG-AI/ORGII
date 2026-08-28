/**
 * One run inside a run group: which harness ran, how it is doing, what you can
 * do about it.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import Button from "@src/components/Button";
import { PILL_SM_ICON_SIZE } from "@src/components/CompoundPill/config";
import ModelIcon from "@src/components/ModelIcon";
import { resolveAgentIcon } from "@src/config/agentIcons";
import type { RunnerAgentDisplay } from "@src/features/SessionCreator/components/RunnerListPanel/resolveRunnerAgent";
import { RUNNER_BLOCKER } from "@src/features/SessionCreator/multiRunner/contract";
import type { RunGroupEntry } from "@src/features/SessionCreator/multiRunner/runGroupContract";
import { useModelPillLabel } from "@src/hooks/models";
import { HugeiconsIcon, WorkflowCircle05Icon } from "@src/icons";
import type { Session } from "@src/store/session";

import {
  RUN_ROW_STATE,
  type RunRowState,
  canStopRun,
  formatElapsed,
  resolveRunElapsedSeconds,
} from "./runGroupRow";

/** Explicit so the i18n key checker can see every key this row can render. */
const STATE_LABEL_KEY: Record<RunRowState, string> = {
  [RUN_ROW_STATE.RUNNING]: "runGroup.state.running",
  [RUN_ROW_STATE.DONE]: "runGroup.state.done",
  [RUN_ROW_STATE.FAILED]: "runGroup.state.failed",
  [RUN_ROW_STATE.STOPPED]: "runGroup.state.stopped",
  [RUN_ROW_STATE.SKIPPED]: "runGroup.state.skipped",
  [RUN_ROW_STATE.PENDING]: "runGroup.state.pending",
};

const STATE_TONE_CLASS: Record<RunRowState, string> = {
  [RUN_ROW_STATE.RUNNING]: "text-primary-6",
  [RUN_ROW_STATE.DONE]: "text-success-6",
  [RUN_ROW_STATE.FAILED]: "text-danger-6",
  [RUN_ROW_STATE.STOPPED]: "text-text-3",
  [RUN_ROW_STATE.SKIPPED]: "text-warning-6",
  [RUN_ROW_STATE.PENDING]: "text-text-3",
};

export interface RunGroupRunRowProps {
  entry: RunGroupEntry;
  agentDisplay: RunnerAgentDisplay;
  /**
   * Live record for this run, resolved by the panel. Passed down rather than
   * re-subscribed per row so the group has exactly one session subscription.
   */
  session: Session | undefined;
  state: RunRowState;
  nowMs: number;
  onOpen: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
}

function resolveDetail(
  entry: RunGroupEntry,
  session: Session | undefined
): string | null {
  if (entry.error) return entry.error;
  if (session?.error_message) return session.error_message;
  return null;
}

const RunGroupRunRow: React.FC<RunGroupRunRowProps> = memo(
  ({ entry, agentDisplay, session, state, nowMs, onOpen, onStop }) => {
    const { t } = useTranslation("sessions");
    const sessionId = entry.sessionId;
    const { label: modelLabel } = useModelPillLabel(
      entry.runner.runtimeConfig,
      t("creator.model")
    );

    // Registry lookup, not a component constructed during render — see the
    // same note in the launcher's RunnerRow.
    const agentIcon = agentDisplay.iconId ? (
      <AnyIcon
        icon={resolveAgentIcon(agentDisplay.iconId)}
        size={PILL_SM_ICON_SIZE}
        strokeWidth={1.85}
        // `block`: an inline SVG reserves baseline descender space and
        // wobbles a sub-pixel on any neighbouring re-layout.
        className="block shrink-0 text-text-1"
      />
    ) : agentDisplay.cliAgentType ? (
      React.createElement(ModelIcon, {
        agentType: agentDisplay.cliAgentType,
        size: PILL_SM_ICON_SIZE,
        className: "block shrink-0",
      })
    ) : null;
    const elapsedSeconds = resolveRunElapsedSeconds(session, nowMs);
    const detail = resolveDetail(entry, session);
    const blockerLabel =
      entry.blocker === RUNNER_BLOCKER.CLI_NOT_INSTALLED
        ? t("creator.multiRunner.blocker.cliNotInstalled", {
            cli: agentDisplay.label,
          })
        : entry.blocker === RUNNER_BLOCKER.CLI_NO_GUI
          ? t("creator.multiRunner.blocker.cliNoGui", {
              cli: agentDisplay.label,
            })
          : entry.blocker === RUNNER_BLOCKER.NO_MODEL
            ? t("creator.multiRunner.blocker.noModel")
            : entry.blocker === RUNNER_BLOCKER.NO_AGENT
              ? t("creator.multiRunner.blocker.noHarness")
              : null;

    const hasDiffStat =
      (session?.linesAdded ?? 0) > 0 || (session?.linesRemoved ?? 0) > 0;

    return (
      <li
        className="border-t border-border-2 py-3"
        data-testid="run-group-run-row"
        data-run-state={state}
        data-run-ordinal={entry.ordinal}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            {agentIcon}
            <span className="truncate text-[14px] font-medium text-text-1">
              {agentDisplay.label}
            </span>
            <span className="truncate text-[13px] text-text-3">
              {modelLabel}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-3">
            <span
              className={`font-medium ${STATE_TONE_CLASS[state]}`}
              data-testid="run-group-run-state"
            >
              {t(STATE_LABEL_KEY[state])}
            </span>
            {elapsedSeconds !== null && (
              <span className="tabular-nums">
                {formatElapsed(elapsedSeconds)}
              </span>
            )}
            {session?.worktreeBranch && (
              <span className="flex items-center gap-1 truncate">
                <HugeiconsIcon
                  icon={WorkflowCircle05Icon}
                  data-icon="git-branch"
                  size={12}
                  strokeWidth={1.75}
                  className="block shrink-0"
                />
                {session.worktreeBranch}
              </span>
            )}
            {hasDiffStat && (
              <span className="tabular-nums">
                <span className="text-success-6">
                  +{session?.linesAdded ?? 0}
                </span>{" "}
                <span className="text-danger-6">
                  −{session?.linesRemoved ?? 0}
                </span>
              </span>
            )}
          </div>

          {(blockerLabel ?? detail) !== null && (
            <p
              className="text-[12px] text-text-3"
              data-testid="run-group-run-detail"
            >
              {blockerLabel ?? detail}
            </p>
          )}

          {sessionId !== undefined && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                variant="secondary"
                appearance="outline"
                size="small"
                shape="round"
                onClick={() => onOpen(sessionId)}
                data-testid="run-group-run-open"
              >
                {t("runGroup.open")}
              </Button>
              {canStopRun(state) && (
                <Button
                  variant="tertiary"
                  size="small"
                  shape="round"
                  onClick={() => onStop(sessionId)}
                  data-testid="run-group-run-stop"
                >
                  {t("runGroup.stop")}
                </Button>
              )}
            </div>
          )}
        </div>
      </li>
    );
  }
);

RunGroupRunRow.displayName = "RunGroupRunRow";

export default RunGroupRunRow;
