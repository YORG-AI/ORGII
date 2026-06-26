import { ExternalLink, FolderCog, KeyRound, Terminal } from "lucide-react";
import React, { memo } from "react";

import { getToolIcon } from "@src/config/toolIcons";

import {
  EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES,
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderInfo,
  EventBlockHeaderTitle,
  SESSION_UI_TOKENS,
  getEventBlockContainerClasses,
  useEventBlockHeader,
} from "../primitives";

// ============================================
// Types
// ============================================

export type SetupRepoStatus = "ready" | "params_missing" | "not_analyzed";
export type SetupRepoAppType = "web" | "desktop" | "cli" | "unknown";

export interface SetupRepoEnvVar {
  key: string;
  value?: string;
  description?: string;
}

export interface SetupRepoBlockProps {
  action: string;
  status?: SetupRepoStatus;
  message?: string;
  envVars?: SetupRepoEnvVar[];
  url?: string;
  command?: string;
  appType?: SetupRepoAppType;
  lifecycleLabel?: string;
  isRunning?: boolean;
  isFailed?: boolean;
}

// ============================================
// Helpers
// ============================================

function statusBadgeClass(status: SetupRepoStatus): string {
  if (status === "ready") return SESSION_UI_TOKENS.STATUS_BADGE.SUCCESS;
  if (status === "params_missing")
    return SESSION_UI_TOKENS.STATUS_BADGE.WARNING;
  return SESSION_UI_TOKENS.STATUS_BADGE.NEUTRAL;
}

function statusLabel(status: SetupRepoStatus): string {
  if (status === "ready") return "ready";
  if (status === "params_missing") return "params missing";
  return "not analyzed";
}

function appTypeIcon(appType: SetupRepoAppType): React.ReactNode {
  const cls = "text-text-2";
  if (appType === "web") return <ExternalLink size={12} className={cls} />;
  if (appType === "cli") return <Terminal size={12} className={cls} />;
  if (appType === "desktop") return <FolderCog size={12} className={cls} />;
  return <Terminal size={12} className={cls} />;
}

// ============================================
// SetupRepoBlock
// ============================================

const SetupRepoBlock: React.FC<SetupRepoBlockProps> = memo(
  ({
    action,
    status,
    message,
    envVars,
    url,
    command,
    appType,
    lifecycleLabel,
    isRunning = false,
    isFailed = false,
  }) => {
    const hasContent =
      !!message ||
      (envVars !== undefined && envVars.length > 0) ||
      !!url ||
      !!command;

    const {
      isCollapsed,
      isHeaderHovered,
      handleHeaderClick,
      handleHeaderMouseEnter,
      handleHeaderMouseLeave,
    } = useEventBlockHeader({
      defaultCollapsed: false,
      collapseAllValue: true,
    });

    const toolIcon = getToolIcon("setup_repo", {
      size: 14,
      className: "text-text-2",
    });

    const infoContent = (() => {
      if (action === "report_status" && status) return statusLabel(status);
      if (
        (action === "update_env" || action === "add_env_vars") &&
        envVars &&
        envVars.length > 0
      )
        return `${envVars.length} var${envVars.length !== 1 ? "s" : ""}`;
      if (action === "launch_app" && appType && appType !== "unknown")
        return appType;
      return undefined;
    })();

    return (
      <div className={getEventBlockContainerClasses(false)}>
        <EventBlockHeader
          isCollapsed={isCollapsed}
          onClick={hasContent ? handleHeaderClick : undefined}
          onMouseEnter={handleHeaderMouseEnter}
          onMouseLeave={handleHeaderMouseLeave}
        >
          <EventBlockHeaderIcon
            icon={toolIcon}
            isCollapsed={isCollapsed}
            isHeaderHovered={isHeaderHovered}
            onToggle={hasContent ? handleHeaderClick : undefined}
            hasContent={hasContent}
            isLoading={isRunning}
            isFailed={isFailed}
          />
          <EventBlockHeaderTitle isLoading={isRunning}>
            {lifecycleLabel ?? "Setup repo"}
          </EventBlockHeaderTitle>
          {infoContent && (
            <EventBlockHeaderInfo isLoading={isRunning}>
              {infoContent}
            </EventBlockHeaderInfo>
          )}
        </EventBlockHeader>

        {!isCollapsed && hasContent && (
          <div className={EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES}>
            <div className="flex flex-col gap-1 p-2">
              {action === "report_status" && (
                <ReportStatusContent status={status} message={message} />
              )}
              {(action === "update_env" || action === "add_env_vars") &&
                envVars &&
                envVars.length > 0 && <EnvVarsContent envVars={envVars} />}
              {action === "launch_app" && (
                <LaunchAppContent
                  appType={appType}
                  url={url}
                  command={command}
                />
              )}
            </div>
          </div>
        )}
      </div>
    );
  }
);

SetupRepoBlock.displayName = "SetupRepoBlock";

export default SetupRepoBlock;

// ============================================
// Sub-renderers
// ============================================

const ReportStatusContent: React.FC<{
  status?: SetupRepoStatus;
  message?: string;
}> = ({ status, message }) => (
  <>
    {status && (
      <div className="flex items-center gap-2 px-1">
        <span className={statusBadgeClass(status)}>{statusLabel(status)}</span>
      </div>
    )}
    {message && (
      <p className="chat-block-content px-1 leading-relaxed text-text-2">
        {message}
      </p>
    )}
  </>
);

const EnvVarsContent: React.FC<{ envVars: SetupRepoEnvVar[] }> = ({
  envVars,
}) => (
  <div className="flex flex-col gap-0.5">
    {envVars.map((v, i) => (
      <div
        key={`${v.key}-${i}`}
        className="flex items-start gap-1.5 rounded px-1.5 py-1 hover:bg-fill-2"
      >
        <KeyRound size={11} className="mt-0.5 shrink-0 text-text-3" />
        <div className="min-w-0 flex-1">
          <span className="chat-block-content font-mono font-medium text-text-1">
            {v.key}
          </span>
          {v.value !== undefined && v.value !== "" && (
            <span className="chat-block-content font-mono text-text-3">
              {" "}
              = {v.value}
            </span>
          )}
          {v.description && (
            <p className="chat-block-xs mt-0.5 text-text-3">{v.description}</p>
          )}
        </div>
      </div>
    ))}
  </div>
);

const LaunchAppContent: React.FC<{
  appType?: SetupRepoAppType;
  url?: string;
  command?: string;
}> = ({ appType = "unknown", url, command }) => (
  <div className="flex flex-col gap-1">
    <div className="flex items-center gap-1.5 px-1">
      {appTypeIcon(appType)}
      <span className="chat-block-xs font-medium uppercase tracking-wide text-text-3">
        {appType}
      </span>
    </div>
    {url && (
      <div className="flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-fill-2">
        <ExternalLink size={11} className="shrink-0 text-text-3" />
        <span className="chat-block-content min-w-0 flex-1 truncate font-mono text-primary-6">
          {url}
        </span>
      </div>
    )}
    {command && (
      <div className="flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-fill-2">
        <Terminal size={11} className="shrink-0 text-text-3" />
        <span className="chat-block-content min-w-0 flex-1 truncate font-mono text-text-1">
          {command}
        </span>
      </div>
    )}
  </div>
);
