import { atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";

import type { ConversationSource } from "@src/engines/SessionCore/conversations/conversationTypes";
import { normalizeSourceEndpointUrl } from "@src/features/TeamCollaboration/engine/collabImportIdentity";
import { resolveForkWorkspacePath } from "@src/features/TeamCollaboration/forkWorkspaceResolution";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { Repo } from "@src/store/repo";
import type { Session } from "@src/store/session";
import { getExternalHistoryCliAgentType } from "@src/util/session/sessionDispatch";

import { org2CloudAuthAtom } from "../org2CloudAuthAtom";
import {
  type CloudOrgRemoteSessionsEntry,
  org2CloudRemoteSessionsAtom,
} from "../org2CloudRemoteSessionsAtom";
import type { SessionCommentTarget } from "../sessionCommentTarget";
import { useCloudSessionLoadingSource } from "../useCloudSessionDownloadSurface";
import { cloudConversationAuthorityIsLive } from "./cloudConversationAuthority";

const detachedRemoteSessionsAtom = atom<
  Record<string, CloudOrgRemoteSessionsEntry>
>({});

export function conversationSourceFromCloudReplay(params: {
  target?: SessionCommentTarget | null;
  importedFrom?: Session["importedFrom"];
  orgId?: string;
  remoteSession?: RemoteTeammateSessionMetadata;
  sourceEndpointUrl?: string;
  workspaceRepoPath: string | null;
}): ConversationSource | undefined {
  const orgId =
    params.target?.orgId ?? params.importedFrom?.orgId ?? params.orgId;
  const sourceSessionId =
    params.target?.sessionId ??
    params.importedFrom?.sourceSessionId ??
    params.remoteSession?.sourceSessionId;
  if (!orgId || !sourceSessionId) return undefined;
  // `useSessionCommentTarget` has already converged the family onto its live
  // Cloud plane (including retention fallback). Never reroot that explicit
  // authority a second time from stale lineage metadata.
  const rootId =
    params.target?.sessionId ??
    params.remoteSession?.forkedFrom?.rootSessionId ??
    sourceSessionId;
  const endpoint =
    params.importedFrom?.sourceEndpointUrl ?? params.sourceEndpointUrl;
  return {
    root: {
      authority: "org2-cloud",
      authorityScope: endpoint
        ? [normalizeSourceEndpointUrl(endpoint), orgId]
        : [orgId],
      conversationId: rootId,
    },
    cliAgentType:
      params.importedFrom?.sourceDisplay?.cliAgentType ??
      params.remoteSession?.cliAgentType ??
      getExternalHistoryCliAgentType(rootId),
    agentDefinitionId:
      params.importedFrom?.sourceDisplay?.agentDefinitionId ??
      params.remoteSession?.agentDefinitionId,
    agentDisplayName:
      params.importedFrom?.sourceDisplay?.agentDisplayName ??
      params.remoteSession?.agentDisplayName,
    model:
      params.importedFrom?.sourceDisplay?.model ?? params.remoteSession?.model,
    initialTarget: null,
    workspaceRepoPath: params.workspaceRepoPath,
  };
}

interface CloudConversationSourceInput {
  sessionId: string | null | undefined;
  session?: Session;
  target: SessionCommentTarget | null;
  sessions: readonly Session[];
  repos: readonly Repo[];
}

interface CloudConversationSourceResolution {
  source: ConversationSource | undefined;
  workspacePending: boolean;
}

/** Resolve Cloud replay identity and its device-local checkout at the edge. */
export function useCloudConversationSource({
  sessionId,
  session,
  target,
  sessions,
  repos,
}: CloudConversationSourceInput): CloudConversationSourceResolution {
  const auth = useAtomValue(org2CloudAuthAtom);
  const loadingSource = useCloudSessionLoadingSource(sessionId);
  const importedFrom = session?.importedFrom;
  const remoteEntries = useAtomValue(
    target || importedFrom || loadingSource
      ? org2CloudRemoteSessionsAtom
      : detachedRemoteSessionsAtom
  );
  const importedRemoteRow = useMemo(() => {
    if (target) {
      const targetRow = remoteEntries[target.orgId]?.rows.find(
        (candidate) => candidate.sourceSessionId === target.sessionId
      );
      if (targetRow) return targetRow;
    }
    if (importedFrom) {
      return (
        remoteEntries[importedFrom.orgId]?.rows.find(
          (candidate) =>
            candidate.sourceSessionId === importedFrom.sourceSessionId
        ) ?? loadingSource
      );
    }
    return loadingSource;
  }, [importedFrom, loadingSource, remoteEntries, target]);
  const authorityLive = useMemo(
    () =>
      cloudConversationAuthorityIsLive({
        session,
        target,
        entry: target ? remoteEntries[target.orgId] : undefined,
        loadingSource,
      }),
    [loadingSource, remoteEntries, session, target]
  );
  const importedOrgId =
    target?.orgId ?? importedFrom?.orgId ?? loadingSource?.orgId;
  const importedWorkspaceKey = importedRemoteRow
    ? `${importedOrgId ?? ""}:${importedRemoteRow.id}`
    : null;
  const [importedWorkspaceResolution, setImportedWorkspaceResolution] =
    useState<{ key: string; path: string | null } | null>(null);
  const localWorkspaceInventoryKey = useMemo(
    () =>
      [
        ...repos.map((repo) => repo.path),
        ...sessions
          // Imported rows may contain another device's absolute path. They
          // are the input being resolved, never evidence that this machine's
          // local workspace inventory has hydrated.
          .filter((candidate) => !candidate.importedFrom)
          .flatMap((candidate) => [
            candidate.repoRootPath,
            candidate.worktreePath,
            candidate.repoPath,
          ]),
      ]
        .filter((path): path is string => Boolean(path))
        .sort()
        .join("\n"),
    [repos, sessions]
  );

  useEffect(() => {
    let cancelled = false;
    if (!importedRemoteRow || !importedWorkspaceKey) return;
    // A scoped Team Session needs the local repo/session inventory before a
    // missing match is authoritative. Keep the prior durable choice pending
    // during cold-start hydration instead of collapsing it to null.
    if (importedRemoteRow.repoScopeKey && !localWorkspaceInventoryKey) return;
    void resolveForkWorkspacePath(importedRemoteRow).then((path) => {
      if (!cancelled) {
        setImportedWorkspaceResolution({ key: importedWorkspaceKey, path });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [importedRemoteRow, importedWorkspaceKey, localWorkspaceInventoryKey]);

  const workspacePending = Boolean(
    importedRemoteRow &&
    importedWorkspaceKey &&
    importedWorkspaceResolution?.key !== importedWorkspaceKey
  );
  const importedWorkspacePath =
    importedWorkspaceResolution?.key === importedWorkspaceKey
      ? importedWorkspaceResolution.path
      : null;
  const source = useMemo(
    () =>
      !authorityLive
        ? undefined
        : conversationSourceFromCloudReplay({
            target,
            importedFrom,
            orgId: importedOrgId,
            remoteSession: importedRemoteRow,
            sourceEndpointUrl: auth?.supabaseUrl,
            // Imported rows may carry the owner's absolute path. Only the shared
            // repo-scope resolver may produce a workspace for this device.
            workspaceRepoPath:
              !importedFrom && !loadingSource
                ? (session?.repoRootPath ??
                  session?.worktreePath ??
                  session?.repoPath ??
                  null)
                : importedWorkspacePath,
          }),
    [
      authorityLive,
      importedFrom,
      loadingSource,
      importedOrgId,
      importedRemoteRow,
      importedWorkspacePath,
      auth?.supabaseUrl,
      session?.repoPath,
      session?.repoRootPath,
      session?.worktreePath,
      target,
    ]
  );

  return useMemo(
    () => ({ source, workspacePending }),
    [source, workspacePending]
  );
}
