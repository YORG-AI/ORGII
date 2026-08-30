/**
 * ActiveProcesses
 *
 * Collapsible section in ComposerStack showing currently running/background
 * agent jobs for the active session — both shell processes and background
 * Delegate/Shadow subagent workers. Each row displays the command / agent
 * name with a Stop button on hover.
 *
 * Data comes from shellProcessMapAtom (status "running" | "background") and
 * subagentJobMapAtom (status "running"), both filtered by the active session.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  CHAT_COMPOSER_STACK_BAR_INNER_PADDING_X_CLASS,
  CHAT_COMPOSER_STACK_BAR_SURFACE_BG_CLASS,
  COMPOSER_STACK_ROW_ACTIONS,
  COMPOSER_STACK_ROW_BASE,
  COMPOSER_STACK_ROW_HOVER,
  COMPOSER_STACK_ROW_LABEL,
} from "@src/config/composerStackTokens";
import { createLogger } from "@src/hooks/logger";
import {
  BotIcon,
  Delete02Icon,
  HugeiconsIcon,
  SquareTerminalIcon,
} from "@src/icons";
import { killAgentShellProcess } from "@src/services/terminal";
import { activeSessionIdAtom } from "@src/store/session";
import {
  type ShellProcessState,
  shellProcessMapAtom,
} from "@src/store/session/shellProcessAtom";
import {
  type SubagentJobState,
  removeSubagentJobAtom,
  subagentJobMapAtom,
} from "@src/store/session/subagentJobAtom";
import { invokeTauri } from "@src/util/platform/tauri/init";

import ComposerStackHeader from "./ComposerStackHeader";

const logger = createLogger("ActiveProcesses");

// ============================================
// Types
// ============================================

export interface ActiveProcessesProps {
  onToggle: () => void;
  sessionId?: string | null;
  onVisibleCountChange?: (count: number) => void;
  /** When true, keeps component mounted (for count tracking) but renders nothing visible. */
  hidden?: boolean;
  /** When provided, renders with this static data instead of reading from atoms. */
  initialProcesses?: ShellProcessState[];
}

// ============================================
// Shell process row
// ============================================

interface ProcessRowProps {
  process: ShellProcessState;
  onStop: (pid: number, callId: string) => void;
}

const ProcessRow: React.FC<ProcessRowProps> = memo(({ process, onStop }) => {
  const { t } = useTranslation("common");
  const handleStop = useCallback(
    () => onStop(process.pid, process.callId),
    [onStop, process.callId, process.pid]
  );

  return (
    <div className={`${COMPOSER_STACK_ROW_BASE} ${COMPOSER_STACK_ROW_HOVER}`}>
      <div className="flex h-[14px] w-[14px] shrink-0 items-center justify-center">
        <HugeiconsIcon
          icon={SquareTerminalIcon}
          data-icon="square-terminal"
          size={14}
          className="text-text-2"
        />
      </div>
      <span className={COMPOSER_STACK_ROW_LABEL}>{process.command}</span>
      <span className={COMPOSER_STACK_ROW_ACTIONS}>
        <Button
          htmlType="button"
          variant="tertiary"
          size="mini"
          icon={
            <HugeiconsIcon icon={Delete02Icon} data-icon="trash-2" size={12} />
          }
          iconOnly
          className="enabled:hover:bg-fill-3 enabled:hover:text-danger-6"
          onClick={handleStop}
          title={t("actions.stop")}
        />
      </span>
    </div>
  );
});
ProcessRow.displayName = "ProcessRow";

// ============================================
// Subagent worker row
// ============================================

function formatElapsed(startedAt: number, now: number): string {
  const totalSec = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${min % 60 > 0 ? ` ${min % 60}m` : ""}`;
}

interface SubagentRowProps {
  job: SubagentJobState;
  now: number;
  onStop: (handle: string) => void;
}

const SubagentRow: React.FC<SubagentRowProps> = memo(({ job, now, onStop }) => {
  const { t } = useTranslation("common");
  const handleStop = useCallback(
    () => onStop(job.handle),
    [onStop, job.handle]
  );

  return (
    <div className={`${COMPOSER_STACK_ROW_BASE} ${COMPOSER_STACK_ROW_HOVER}`}>
      <div className="flex h-[14px] w-[14px] shrink-0 items-center justify-center">
        <HugeiconsIcon
          icon={BotIcon}
          data-icon="bot"
          size={14}
          className="text-text-2"
        />
      </div>
      <span className={COMPOSER_STACK_ROW_LABEL}>
        {job.agentName}
        <span className="ml-1.5 text-text-3">
          {job.subagentType} · {formatElapsed(job.startedAt, now)}
        </span>
      </span>
      <span className={COMPOSER_STACK_ROW_ACTIONS}>
        <Button
          htmlType="button"
          variant="tertiary"
          size="mini"
          icon={
            <HugeiconsIcon icon={Delete02Icon} data-icon="trash-2" size={12} />
          }
          iconOnly
          className="enabled:hover:bg-fill-3 enabled:hover:text-danger-6"
          onClick={handleStop}
          title={t("actions.stop")}
        />
      </span>
    </div>
  );
});
SubagentRow.displayName = "SubagentRow";

// ============================================
// Main component
// ============================================

const ActiveProcesses: React.FC<ActiveProcessesProps> = memo(
  ({
    onToggle,
    sessionId: sessionIdProp,
    onVisibleCountChange,
    hidden,
    initialProcesses,
  }) => {
    const { t } = useTranslation("common");
    const activeSessionId = useAtomValue(activeSessionIdAtom);
    const sessionId = sessionIdProp ?? activeSessionId;
    const processMap = useAtomValue(shellProcessMapAtom);
    const subagentJobMap = useAtomValue(subagentJobMapAtom);
    const dispatchRemoveSubagentJob = useSetAtom(removeSubagentJobAtom);

    const activeProcesses = useMemo(() => {
      if (initialProcesses) return initialProcesses;
      if (!sessionId) return [];
      const sessionProcesses = processMap.get(sessionId);
      if (!sessionProcesses) return [];
      return [...sessionProcesses.values()].filter(
        (proc) => proc.status === "running" || proc.status === "background"
      );
    }, [initialProcesses, processMap, sessionId]);

    const activeSubagents = useMemo(() => {
      if (initialProcesses) return [];
      if (!sessionId) return [];
      const jobs = subagentJobMap.get(sessionId);
      if (!jobs) return [];
      return [...jobs.values()].filter((job) => job.status === "running");
    }, [initialProcesses, subagentJobMap, sessionId]);

    const count = activeProcesses.length + activeSubagents.length;

    useEffect(() => {
      onVisibleCountChange?.(count);
    }, [count, onVisibleCountChange]);

    // Tick once a second only while subagent rows (the only elapsed-time
    // display) are visible, so their timer counts up live instead of
    // freezing at the value captured on the last atom change.
    const [now, setNow] = useState(() => Date.now());
    const hasSubagents = activeSubagents.length > 0;
    useEffect(() => {
      if (!hasSubagents) return;
      const interval = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(interval);
    }, [hasSubagents]);

    const handleStop = useCallback(
      async (pid: number, callId: string) => {
        try {
          await killAgentShellProcess({
            pid,
            sessionId: sessionId ?? undefined,
            callId,
          });
        } catch (err: unknown) {
          logger.warn("kill failed:", err);
        }
      },
      [sessionId]
    );

    const handleStopSubagent = useCallback(
      async (handle: string) => {
        try {
          await invokeTauri("agent_kill_subagent_job", { handle });
        } catch (err: unknown) {
          // Registry already GC'd the job (it can never broadcast a terminal
          // event), so the row would otherwise linger unkillable. The kill the
          // user clicked must still take it off the pin bar.
          if (String(err).includes("not found")) {
            dispatchRemoveSubagentJob({ handle });
          } else {
            logger.warn("subagent kill failed:", err);
          }
        }
      },
      [dispatchRemoveSubagentJob]
    );

    if (count === 0 || hidden) return null;

    return (
      <div
        className={`${CHAT_COMPOSER_STACK_BAR_SURFACE_BG_CLASS} overflow-hidden rounded-lg border border-solid border-border-2`}
      >
        <ComposerStackHeader
          icon={
            <HugeiconsIcon
              icon={SquareTerminalIcon}
              data-icon="square-terminal"
              size={14}
            />
          }
          label={t("labels.processCount", { count })}
          expanded={true}
          onToggle={onToggle}
        />
        <div
          className={`${CHAT_COMPOSER_STACK_BAR_INNER_PADDING_X_CLASS} max-h-[192px] overflow-y-auto pb-1`}
        >
          {activeSubagents.map((job) => (
            <SubagentRow
              key={job.handle}
              job={job}
              now={now}
              onStop={handleStopSubagent}
            />
          ))}
          {activeProcesses.map((proc) => (
            <ProcessRow key={proc.pid} process={proc} onStop={handleStop} />
          ))}
        </div>
      </div>
    );
  }
);

ActiveProcesses.displayName = "ActiveProcesses";

export default ActiveProcesses;
