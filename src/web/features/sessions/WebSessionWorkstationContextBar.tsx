import { Folder, GitBranch, GitFork } from "lucide-react";
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { resolveSessionWorkstationContext } from "@src/engines/ChatPanel/components/SessionWorkstationRail";
import { resolveCloudSessionEnvironmentIdentity } from "@src/features/Org2Cloud/cloudSessionReplayLifecycle";
import { formatBranchLabel } from "@src/util/git/branchLabel";

import type { WebSessionListItem } from "./useWebSessionRoster";

export interface ResolvedWebSessionWorkstationContext {
  repoName?: string;
  branchName?: string;
  worktreeBranchName?: string;
  ownerDisplayName?: string;
  isFork: boolean;
}

export function resolveWebSessionWorkstationContext(
  session: WebSessionListItem
): ResolvedWebSessionWorkstationContext {
  const remoteEnvironment = resolveCloudSessionEnvironmentIdentity(session);
  const context = resolveSessionWorkstationContext(null, remoteEnvironment);
  return {
    repoName: context.repoName,
    branchName: context.branchName,
    worktreeBranchName: context.worktreeBranchName,
    ownerDisplayName: session.ownerDisplayName,
    isFork: Boolean(session.forkedFrom),
  };
}

export function hasWebSessionWorkstationContext(
  context: ResolvedWebSessionWorkstationContext
): boolean {
  return Boolean(
    context.repoName ||
    context.branchName ||
    context.worktreeBranchName ||
    context.isFork
  );
}

interface WebSessionWorkstationContextBarProps {
  session: WebSessionListItem;
}

const WebSessionWorkstationContextBar: React.FC<WebSessionWorkstationContextBarProps> =
  memo(({ session }) => {
    const { t } = useTranslation("navigation");
    const context = useMemo(
      () => resolveWebSessionWorkstationContext(session),
      [session]
    );

    if (!hasWebSessionWorkstationContext(context)) return null;

    const branchLabel =
      formatBranchLabel(context.worktreeBranchName) ||
      formatBranchLabel(context.branchName);

    return (
      <div
        className="flex min-w-0 items-center gap-2 border-b border-border-2 bg-pane-raised px-3 py-1.5 text-xs text-text-3"
        data-testid="web-session-workstation-context"
      >
        {context.isFork ? (
          <span className="inline-flex min-w-0 items-center gap-1">
            <GitFork size={12} strokeWidth={2} aria-hidden />
            <span className="truncate">
              {t("web.sessionPage.forkContext", {
                owner: context.ownerDisplayName,
                defaultValue: "Fork of {{owner}}'s session",
              })}
            </span>
          </span>
        ) : null}
        {context.repoName ? (
          <span className="inline-flex min-w-0 items-center gap-1">
            <Folder size={12} strokeWidth={2} aria-hidden />
            <span className="truncate text-text-2">{context.repoName}</span>
          </span>
        ) : null}
        {branchLabel ? (
          <span className="inline-flex min-w-0 items-center gap-1">
            <GitBranch size={12} strokeWidth={2} aria-hidden />
            <span className="truncate">{branchLabel}</span>
          </span>
        ) : null}
      </div>
    );
  });

WebSessionWorkstationContextBar.displayName = "WebSessionWorkstationContextBar";

export default WebSessionWorkstationContextBar;
