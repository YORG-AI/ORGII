import {
  ChevronDown,
  ChevronRight,
  Files,
  SquareArrowOutUpRight,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LinkedSession } from "@src/api/http/project";

import SessionOutputPreview from "../SessionOutputPreview";
import { useSessionFiles } from "../hooks/useSessionFiles";
import {
  STATUS_I18N_KEYS,
  type SessionFilesCache,
  TERMINAL_STATUS,
  getStatusStyle,
} from "../types";
import SessionFileRow from "./SessionFileRow";
import SubAgentRunCard from "./SubAgentRunCard";

interface SessionRunCardProps {
  sessionId: string;
  roleLabel: string;
  runNumber: number;
  status: string;
  isActive: boolean;
  onOpenSession?: (sessionId: string) => void;
  onSessionComplete?: () => void;
  onSubAgentChange?: () => void;
  subAgentSessions?: LinkedSession[];
  filesCache: React.MutableRefObject<SessionFilesCache>;
}

const SessionRunCard: React.FC<SessionRunCardProps> = ({
  sessionId,
  roleLabel,
  runNumber,
  status,
  isActive,
  onOpenSession,
  onSessionComplete,
  onSubAgentChange,
  subAgentSessions,
  filesCache,
}) => {
  const { t } = useTranslation("projects");
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const delayedRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (delayedRefreshRef.current) clearTimeout(delayedRefreshRef.current);
    };
  }, []);

  const handleSessionComplete = useCallback(() => {
    onSessionComplete?.();
    if (delayedRefreshRef.current) clearTimeout(delayedRefreshRef.current);
    delayedRefreshRef.current = setTimeout(() => {
      onSessionComplete?.();
    }, 3000);
  }, [onSessionComplete]);

  const displayStatus =
    liveStatus && TERMINAL_STATUS.has(liveStatus) ? liveStatus : status;
  const style = getStatusStyle(displayStatus);
  const StatusIcon = style.icon;
  const isTerminal = TERMINAL_STATUS.has(displayStatus);

  const { sessionFiles, filesLoading, loadSessionFiles } = useSessionFiles({
    sessionId,
    displayStatus,
    isActive,
    isTerminal,
    filesCache,
  });

  const toggleFiles = useCallback(async () => {
    const next = !showFiles;
    setShowFiles(next);
    if (next && sessionFiles === null && !filesLoading) {
      await loadSessionFiles();
    }
  }, [showFiles, sessionFiles, filesLoading, loadSessionFiles]);

  const fileCount = sessionFiles?.length ?? 0;
  const canShowFiles =
    isTerminal || (isActive && sessionFiles && sessionFiles.length > 0);

  return (
    <div className="overflow-hidden rounded-lg bg-fill-1">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <StatusIcon size={14} className={style.iconClass} />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-[12px] font-semibold text-text-1">
            {roleLabel} #{runNumber}
          </span>
          <span
            className={`rounded-full px-2 py-px text-[10px] font-medium leading-[16px] ${style.badgeClass}`}
          >
            {t(STATUS_I18N_KEYS[displayStatus] ?? displayStatus)}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {canShowFiles && (
            <button
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
              onClick={toggleFiles}
            >
              <Files size={12} />
              {fileCount > 0 && <span>{fileCount}</span>}
              {showFiles ? (
                <ChevronDown size={10} />
              ) : (
                <ChevronRight size={10} />
              )}
            </button>
          )}
          {onOpenSession && (
            <button
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
              onClick={() => onOpenSession(sessionId)}
            >
              <SquareArrowOutUpRight size={12} />
              <span>
                {isActive
                  ? t("workItems.agentWorkflow.viewLiveChat")
                  : t("workItems.agentWorkflow.viewConversation")}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* File list */}
      {showFiles && (
        <div className="border-t border-border-2 px-3 py-2">
          {filesLoading && (
            <span className="text-[11px] text-text-4">
              {t("common:status.loading")}
            </span>
          )}
          {sessionFiles && sessionFiles.length === 0 && (
            <span className="text-[11px] text-text-4">
              {t("workItems.agentWorkflow.noFilesModified")}
            </span>
          )}
          {sessionFiles && sessionFiles.length > 0 && (
            <div className="space-y-0.5">
              {sessionFiles.map((file) => (
                <SessionFileRow key={file.path} file={file} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Hidden live output listener — unmount once terminal status is known */}
      {!isTerminal && (
        <div className="hidden">
          <SessionOutputPreview
            sessionId={sessionId}
            isRunning={isActive}
            onSessionComplete={handleSessionComplete}
            onStatusChange={setLiveStatus}
            onSubAgentChange={onSubAgentChange}
            defaultCollapsed={true}
          />
        </div>
      )}

      {/* Sub-agents */}
      {subAgentSessions && subAgentSessions.length > 0 && (
        <div className="border-t border-border-2 px-3 py-2">
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-text-4">
            {t("workItems.agentWorkflow.subAgents")}
          </div>
          <div className="space-y-1.5">
            {subAgentSessions.map((sub) => (
              <SubAgentRunCard
                key={sub.session_id}
                sessionId={sub.session_id}
                agentName={
                  sub.sub_agent_name ??
                  t("workItems.agentWorkflow.subAgentDefault")
                }
                instanceNumber={sub.sub_agent_instance ?? 1}
                status={sub.status}
                isActive={sub.status === "running"}
                totalTokens={sub.total_tokens}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default SessionRunCard;
