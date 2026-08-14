import { useSetAtom } from "jotai";
import React, { useCallback } from "react";

import { useChannelWorkItem } from "@src/features/DiscussionChannels/ChannelPanelView/useChannelWorkItem";
import type { CloudSessionEnvironmentIdentity } from "@src/features/Org2Cloud/cloudSessionDownloadControlAtoms";
import { parseCloudOrgSelectorValue } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  useCloudSessionDownloadProgressEntry,
  useCloudSessionPendingPlayEntry,
} from "@src/features/Org2Cloud/useCloudSessionDownloadSurface";
import { getWorkItemStatusConfig } from "@src/modules/ProjectManager/config/manage";
import {
  type FocusedChatSessionContext,
  FocusedChatWorkstationRail,
} from "@src/modules/shared/layouts/FocusedChatWorkstationRail";
import { openWorkItemInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { Session } from "@src/store/session";
import type { WorkItemStatus } from "@src/types/core/workItem";
import { formatBranchLabel } from "@src/util/git/branchLabel";
import { basename } from "@src/util/path";

interface SessionWorkstationRailProps {
  compactMenuHost: HTMLSpanElement | null;
  conversationMinimapHostRef: (node: HTMLDivElement | null) => void;
  session: Session | null | undefined;
  sessionId: string | null | undefined;
  topInset?: number;
}

export interface ResolvedSessionWorkstationContext {
  branchName?: string;
  orgId?: string;
  projectSlug?: string;
  repoName?: string;
  /** Locally resolvable session workspace used for session-scoped Git details. */
  repoPath?: string;
  worktreeBranchName?: string;
  worktreePath?: string;
  workItemId?: string;
}

export function resolveSessionWorkstationContext(
  session: Session | null | undefined,
  remoteEnvironment?: CloudSessionEnvironmentIdentity
): ResolvedSessionWorkstationContext {
  const repoName = session?.repoPath
    ? basename(session.repoPath)
    : remoteEnvironment?.repoName;
  const branchName =
    formatBranchLabel(session?.branch) ||
    formatBranchLabel(session?.baseBranch) ||
    formatBranchLabel(remoteEnvironment?.branchName) ||
    formatBranchLabel(remoteEnvironment?.baseBranchName) ||
    undefined;
  const localWorktreePath = session?.importedFrom
    ? undefined
    : session?.worktreePath;
  const worktreeBranchName =
    formatBranchLabel(session?.worktreeBranch) ||
    (localWorktreePath ? basename(localWorktreePath) : undefined) ||
    formatBranchLabel(remoteEnvironment?.worktreeBranchName) ||
    undefined;
  const workItemId =
    session?.productMode === "project" ? session.workItemId : undefined;
  const sessionOrgId = session?.orgId ?? undefined;
  const orgId = sessionOrgId
    ? (parseCloudOrgSelectorValue(sessionOrgId) ?? sessionOrgId)
    : undefined;
  // A cloud replay's repoPath belongs to its owner's machine. Only the
  // importer-resolved repo root is safe for local Git/PR lookups.
  const repoPath =
    session?.repoRootPath ??
    (session?.importedFrom
      ? undefined
      : (session?.worktreePath ?? session?.repoPath));

  return {
    branchName,
    orgId,
    projectSlug: session?.projectSlug ?? undefined,
    repoName,
    repoPath,
    worktreeBranchName,
    worktreePath: localWorktreePath,
    workItemId: workItemId ?? undefined,
  };
}

interface ConnectedSessionWorkstationRailProps extends Omit<
  SessionWorkstationRailProps,
  "session" | "sessionId"
> {
  context: ResolvedSessionWorkstationContext;
  projectSlug: string;
  workItemId: string;
}

const ConnectedSessionWorkstationRail: React.FC<
  ConnectedSessionWorkstationRailProps
> = ({
  compactMenuHost,
  context,
  conversationMinimapHostRef,
  projectSlug,
  topInset,
  workItemId,
}) => {
  const openWorkItem = useSetAtom(openWorkItemInChatPanelTabAtom);
  const { resolved } = useChannelWorkItem({
    orgId: context.orgId,
    projectSlug,
    shortId: workItemId,
  });
  const status = resolved?.workItem.status;
  const statusLabel = status
    ? getWorkItemStatusConfig(status as WorkItemStatus).label
    : undefined;

  const handleOpen = useCallback(() => {
    if (!resolved) return;
    openWorkItem({
      workItem: resolved.workItem,
      shortId: resolved.workItem.shortId ?? workItemId,
      projectId: resolved.projectId,
      projectSlug,
      projectName: resolved.projectName,
      orgId: resolved.orgId ?? context.orgId,
    });
  }, [context.orgId, openWorkItem, projectSlug, resolved, workItemId]);

  const sessionContext: FocusedChatSessionContext = {
    branchName: context.branchName,
    repoName: context.repoName,
    repoPath: context.repoPath,
    worktreeBranchName: context.worktreeBranchName,
    worktreePath: context.worktreePath,
    workItem: {
      label: workItemId,
      onClick: resolved ? handleOpen : undefined,
      statusLabel,
    },
  };

  return (
    <FocusedChatWorkstationRail
      compactMenuHost={compactMenuHost}
      conversationMinimapHostRef={conversationMinimapHostRef}
      sessionContext={sessionContext}
      topInset={topInset}
    />
  );
};

const SessionWorkstationRail: React.FC<SessionWorkstationRailProps> = ({
  compactMenuHost,
  conversationMinimapHostRef,
  session,
  sessionId,
  topInset,
}) => {
  const pending = useCloudSessionPendingPlayEntry(sessionId);
  const progress = useCloudSessionDownloadProgressEntry(sessionId);
  const context = resolveSessionWorkstationContext(
    session,
    progress?.sessionEnvironment ?? pending?.sessionEnvironment
  );
  const baseSessionContext: FocusedChatSessionContext = {
    branchName: context.branchName,
    repoName: context.repoName,
    repoPath: context.repoPath,
    worktreeBranchName: context.worktreeBranchName,
    worktreePath: context.worktreePath,
    workItem: context.workItemId ? { label: context.workItemId } : undefined,
  };

  if (context.workItemId) {
    return (
      <ConnectedSessionWorkstationRail
        compactMenuHost={compactMenuHost}
        context={context}
        conversationMinimapHostRef={conversationMinimapHostRef}
        projectSlug={context.projectSlug ?? ""}
        topInset={topInset}
        workItemId={context.workItemId}
      />
    );
  }

  return (
    <FocusedChatWorkstationRail
      compactMenuHost={compactMenuHost}
      conversationMinimapHostRef={conversationMinimapHostRef}
      sessionContext={baseSessionContext}
      topInset={topInset}
    />
  );
};

export default SessionWorkstationRail;
