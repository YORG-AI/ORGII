import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo } from "react";

import { eventStoreProxy } from "@src/engines/SessionCore/core/store";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import {
  collabChatMessagesAtom,
  collabConnectionStatesAtom,
  collabInvitesAtom,
  collabMembersAtom,
  collabOrgsAtom,
  collabProjectsAtom,
  collabSessionAccessSettingsAtom,
  collabSessionSnapshotRequestsAtom,
  collabWorkItemsAtom,
  remoteTeammateSessionsAtom,
} from "@src/store/collaboration/collabOrgsAtom";
import { createCollabAvatarIdentity } from "@src/store/collaboration/protocol";
import {
  COLLAB_CONNECTION_STATUS,
  COLLAB_ROLE,
  COLLAB_SESSION_ACCESS_MODE,
  COLLAB_SYNC_BACKEND,
  COLLAB_WORKSPACE_SCOPE,
} from "@src/store/collaboration/types";
import type {
  CollabChatMessageRecord,
  CollabMemberRecord,
  CollabOrgConnectionState,
  CollabOrgRecord,
  CollabProjectMetadataRecord,
  CollabSessionAccessSettings,
  CollabSessionSnapshotRequestRecord,
  CollabWorkItemMetadataRecord,
  RemoteTeammateSessionMetadata,
} from "@src/store/collaboration/types";
import { sessionsAtom, upsertSession } from "@src/store/session";
import { persistSessions } from "@src/store/session/sessionAtom/persistence";
import type { Session } from "@src/store/session/sessionAtom/types";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { supabaseSyncClient } from "./sync/supabaseSyncClient";

const SYNC_INTERVAL_MS = 10_000;

interface ActiveCollabConnection {
  org: CollabOrgRecord;
  member: CollabMemberRecord;
  settings: CollabSessionAccessSettings;
}

function normalizeWorkspacePath(path: string | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

function createDefaultAccessSettings(
  orgId: string,
  memberId: string
): CollabSessionAccessSettings {
  return {
    orgId,
    memberId,
    accessMode: COLLAB_SESSION_ACCESS_MODE.OFF,
    workspaceScope: COLLAB_WORKSPACE_SCOPE.SELECTED_WORKSPACES,
    workspacePaths: [],
    updatedAt: new Date().toISOString(),
  };
}

function isSessionAllowedByAccessSettings(
  session: Session,
  settings: CollabSessionAccessSettings
): boolean {
  if (settings.accessMode === COLLAB_SESSION_ACCESS_MODE.OFF) return false;
  const repoPath = normalizeWorkspacePath(session.repoPath);
  if (!repoPath) return false;
  return settings.workspacePaths.map(normalizeWorkspacePath).includes(repoPath);
}

function isRemoteSessionAllowedByAccessSettings(
  session: RemoteTeammateSessionMetadata,
  settings: CollabSessionAccessSettings
): boolean {
  if (settings.accessMode !== COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY) {
    return false;
  }
  const repoPath = normalizeWorkspacePath(session.repoPath);
  if (!repoPath) return false;
  return settings.workspacePaths.map(normalizeWorkspacePath).includes(repoPath);
}

function createImportedSnapshotSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `imported-session-${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

function rewriteEventsForImportedSnapshot(
  events: SessionEvent[],
  localSessionId: string
): SessionEvent[] {
  return events.map((event) => ({ ...event, sessionId: localSessionId }));
}

function toRemoteMetadata(
  session: Session,
  org: CollabOrgRecord,
  member: CollabMemberRecord,
  settings: CollabSessionAccessSettings
): RemoteTeammateSessionMetadata {
  return {
    id: `${org.id}:${member.id}:${session.session_id}`,
    orgId: org.id,
    ownerMemberId: member.id,
    ownerUserId: member.id,
    ownerDisplayName: member.displayName,
    ownerIdentityKind: member.identityKind,
    sourceSessionId: session.session_id,
    title: session.name || session.user_input || session.session_id,
    status: String(session.status),
    repoPath: session.repoPath,
    branch: session.branch || session.worktreeBranch,
    lastActivityAt: session.updated_at || session.updated_time,
    accessMode: settings.accessMode,
  };
}

function upsertConnectionState(
  current: CollabOrgConnectionState[],
  nextState: CollabOrgConnectionState
): CollabOrgConnectionState[] {
  const existingIndex = current.findIndex(
    (item) => item.orgId === nextState.orgId
  );
  if (existingIndex < 0) return [nextState, ...current];
  const next = [...current];
  next[existingIndex] = nextState;
  return next;
}

function upsertCollabMember(
  current: CollabMemberRecord[],
  incoming: CollabMemberRecord
): CollabMemberRecord[] {
  const existingIndex = current.findIndex(
    (member) => member.orgId === incoming.orgId && member.id === incoming.id
  );
  if (existingIndex < 0) return [incoming, ...current];
  const next = [...current];
  next[existingIndex] = { ...current[existingIndex], ...incoming };
  return next;
}

function upsertRemoteSession(
  current: RemoteTeammateSessionMetadata[],
  incoming: RemoteTeammateSessionMetadata
): RemoteTeammateSessionMetadata[] {
  const existingIndex = current.findIndex(
    (session) => session.id === incoming.id
  );
  if (existingIndex < 0) return [incoming, ...current];
  const next = [...current];
  next[existingIndex] = incoming;
  return next;
}

function upsertChatMessage(
  current: CollabChatMessageRecord[],
  incoming: CollabChatMessageRecord
): CollabChatMessageRecord[] {
  const existingIndex = current.findIndex(
    (message) => message.id === incoming.id
  );
  if (existingIndex < 0) return [...current, incoming];
  const next = [...current];
  next[existingIndex] = incoming;
  return next;
}

function getMetadataId(record: Record<string, unknown>): string | null {
  const id = record.id;
  return typeof id === "string" && id.trim() ? id : null;
}

function upsertCollabMetadataRecord<TRecord extends Record<string, unknown>>(
  current: TRecord[],
  incoming: TRecord
): TRecord[] {
  const incomingId = getMetadataId(incoming);
  if (!incomingId) return [incoming, ...current];
  const existingIndex = current.findIndex(
    (record) => getMetadataId(record) === incomingId
  );
  if (existingIndex < 0) return [incoming, ...current];
  const next = [...current];
  next[existingIndex] = { ...current[existingIndex], ...incoming };
  return next;
}

function withOrgId<TRecord extends Record<string, unknown>>(
  orgId: string,
  record: TRecord
): TRecord {
  return { ...record, orgId };
}

function upsertSnapshotRequest(
  current: CollabSessionSnapshotRequestRecord[],
  incoming: CollabSessionSnapshotRequestRecord
): CollabSessionSnapshotRequestRecord[] {
  const existingIndex = current.findIndex(
    (request) => request.requestId === incoming.requestId
  );
  if (existingIndex < 0) return [incoming, ...current];
  const next = [...current];
  next[existingIndex] = { ...current[existingIndex], ...incoming };
  return next;
}

function memberFromRemoteSession(
  session: RemoteTeammateSessionMetadata
): CollabMemberRecord {
  const joinedAt = session.lastActivityAt ?? new Date().toISOString();
  return {
    id: session.ownerMemberId,
    orgId: session.orgId,
    displayName: session.ownerDisplayName,
    avatar: createCollabAvatarIdentity(session.ownerDisplayName),
    role: COLLAB_ROLE.MEMBER,
    identityKind: session.ownerIdentityKind,
    joinedAt,
  };
}

function memberFromChatMessage(
  message: CollabChatMessageRecord
): CollabMemberRecord {
  return {
    id: message.authorMemberId,
    orgId: message.orgId,
    displayName: message.authorDisplayName,
    avatar: createCollabAvatarIdentity(message.authorDisplayName),
    role: COLLAB_ROLE.MEMBER,
    identityKind: message.authorIdentityKind,
    joinedAt: message.createdAt,
  };
}

function getSyncProfile(org: CollabOrgRecord): {
  supabaseUrl: string;
  anonKey: string;
  orgSecret: string;
} | null {
  if (org.syncBackend !== COLLAB_SYNC_BACKEND.SUPABASE) return null;
  if (!org.supabaseUrl || !org.supabaseAnonKey || !org.orgSecret) return null;
  return {
    supabaseUrl: org.supabaseUrl,
    anonKey: org.supabaseAnonKey,
    orgSecret: org.orgSecret,
  };
}

export function useCollaborationMetadataSync(): void {
  const orgs = useAtomValue(collabOrgsAtom);
  const members = useAtomValue(collabMembersAtom);
  const remoteSessions = useAtomValue(remoteTeammateSessionsAtom);
  const chatMessages = useAtomValue(collabChatMessagesAtom);
  const sessions = useAtomValue(sessionsAtom);
  const accessSettingsList = useAtomValue(collabSessionAccessSettingsAtom);
  const snapshotRequests = useAtomValue(collabSessionSnapshotRequestsAtom);
  const { openSession } = useSessionView();
  const setRemoteSessions = useSetAtom(remoteTeammateSessionsAtom);
  const setConnectionStates = useSetAtom(collabConnectionStatesAtom);
  const setChatMessages = useSetAtom(collabChatMessagesAtom);
  const setMembers = useSetAtom(collabMembersAtom);
  const setInvites = useSetAtom(collabInvitesAtom);
  const setProjects = useSetAtom(collabProjectsAtom);
  const setWorkItems = useSetAtom(collabWorkItemsAtom);
  const setSnapshotRequests = useSetAtom(collabSessionSnapshotRequestsAtom);

  const activeConnections = useMemo<ActiveCollabConnection[]>(
    () =>
      orgs.flatMap((org) => {
        const profile = getSyncProfile(org);
        if (!profile) return [];
        const member = members.find(
          (candidate) =>
            candidate.orgId === org.id &&
            candidate.id === org.localMemberId &&
            !candidate.removedAt
        );
        if (!member) return [];
        const settings =
          accessSettingsList.find(
            (candidate) =>
              candidate.orgId === org.id && candidate.memberId === member.id
          ) ?? createDefaultAccessSettings(org.id, member.id);
        return [{ org, member, settings }];
      }),
    [accessSettingsList, members, orgs]
  );

  useEffect(() => {
    const inferredMembers = [
      ...remoteSessions.map(memberFromRemoteSession),
      ...chatMessages.map(memberFromChatMessage),
    ];
    if (inferredMembers.length === 0) return;
    setMembers((current) =>
      inferredMembers.reduce(upsertCollabMember, current)
    );
  }, [chatMessages, remoteSessions, setMembers]);

  useEffect(() => {
    if (activeConnections.length === 0) return;
    let cancelled = false;

    const setStatus = (
      orgId: string,
      status: CollabOrgConnectionState["status"],
      error?: string
    ) => {
      setConnectionStates((current) =>
        upsertConnectionState(current, {
          orgId,
          status,
          error,
          updatedAt: new Date().toISOString(),
        })
      );
    };

    const createProfile = (org: CollabOrgRecord) => {
      const profile = getSyncProfile(org);
      if (!profile) throw new Error("Supabase sync profile is incomplete");
      return profile;
    };

    const syncConnection = async ({
      org,
      member,
      settings,
    }: ActiveCollabConnection) => {
      const profile = createProfile(org);
      setStatus(org.id, COLLAB_CONNECTION_STATUS.CONNECTING);

      await supabaseSyncClient.verifySetup(profile);
      if (cancelled) return;

      for (const session of sessions) {
        if (cancelled) return;
        if (!isSessionAllowedByAccessSettings(session, settings)) {
          await supabaseSyncClient.removeSessionMetadata({
            ...profile,
            orgId: org.id,
            ownerMemberId: member.id,
            sourceSessionId: session.session_id,
          });
          continue;
        }
        await supabaseSyncClient.upsertSessionMetadata({
          ...profile,
          session: toRemoteMetadata(session, org, member, settings),
        });
      }

      for (const request of snapshotRequests) {
        if (
          request.orgId === org.id &&
          request.requesterMemberId === member.id &&
          request.status === "pending"
        ) {
          await supabaseSyncClient.requestSessionSnapshot({
            ...profile,
            requestId: request.requestId,
            orgId: request.orgId,
            requesterMemberId: request.requesterMemberId,
            ownerMemberId: request.ownerMemberId,
            sourceSessionId: request.sourceSessionId,
          });
          if (cancelled) return;
          setSnapshotRequests((current) =>
            current.map((item) =>
              item.requestId === request.requestId
                ? { ...item, status: "sent" }
                : item
            )
          );
        }
      }

      const state = await supabaseSyncClient.listOrgState({
        ...profile,
        orgId: org.id,
      });
      if (cancelled) return;

      setMembers((current) =>
        state.members.reduce(upsertCollabMember, current)
      );
      setInvites((current) =>
        state.invites.reduce((next, invite) => {
          const existingIndex = next.findIndex((item) => item.id === invite.id);
          if (existingIndex < 0) return [invite, ...next];
          const copy = [...next];
          copy[existingIndex] = invite;
          return copy;
        }, current)
      );
      setProjects((current) =>
        state.projects
          .map((project) =>
            withOrgId<CollabProjectMetadataRecord>(org.id, project)
          )
          .reduce(upsertCollabMetadataRecord, current)
      );
      setWorkItems((current) =>
        state.workItems
          .map((workItem) =>
            withOrgId<CollabWorkItemMetadataRecord>(org.id, workItem)
          )
          .reduce(upsertCollabMetadataRecord, current)
      );
      setRemoteSessions((current) =>
        state.sessions.reduce(upsertRemoteSession, current)
      );
      setChatMessages((current) =>
        state.chatMessages.reduce(upsertChatMessage, current)
      );
      setSnapshotRequests((current) =>
        state.snapshotRequests.reduce(
          (next, request) =>
            upsertSnapshotRequest(next, {
              requestId: request.requestId,
              orgId: request.orgId,
              requesterMemberId: request.requesterMemberId,
              ownerMemberId: request.ownerMemberId,
              sourceSessionId: request.sourceSessionId,
              createdAt: request.createdAt,
              status: request.status,
              error: request.error,
            }),
          current
        )
      );

      for (const request of state.snapshotRequests) {
        if (cancelled) return;
        if (
          request.ownerMemberId === member.id &&
          request.status === "pending"
        ) {
          const sourceSession = sessions.find(
            (session) => session.session_id === request.sourceSessionId
          );
          if (!sourceSession) {
            await supabaseSyncClient.denySessionSnapshot({
              ...profile,
              requestId: request.requestId,
              reason: "Session is unavailable on the owner device",
            });
            continue;
          }
          const metadata = toRemoteMetadata(
            sourceSession,
            org,
            member,
            settings
          );
          if (!isRemoteSessionAllowedByAccessSettings(metadata, settings)) {
            await supabaseSyncClient.denySessionSnapshot({
              ...profile,
              requestId: request.requestId,
              reason: "Session replay is not allowed by owner settings",
            });
            continue;
          }
          const events = await eventStoreProxy.getEvents(
            sourceSession.session_id
          );
          await supabaseSyncClient.publishSessionSnapshot({
            ...profile,
            requestId: request.requestId,
            orgId: org.id,
            sourceSessionId: sourceSession.session_id,
            session: metadata,
            events,
          });
        }

        if (
          request.requesterMemberId === member.id &&
          request.status === "completed" &&
          request.session &&
          request.events &&
          snapshotRequests.find((item) => item.requestId === request.requestId)
            ?.status !== "completed"
        ) {
          const localSessionId = createImportedSnapshotSessionId();
          const localEvents = rewriteEventsForImportedSnapshot(
            request.events,
            localSessionId
          );
          const now = new Date().toISOString();
          upsertSession({
            session_id: localSessionId,
            status: "completed",
            created_at: now,
            updated_at: now,
            completed_at: now,
            name: request.session.title,
            repoPath: request.session.repoPath,
            category: "external_history",
            model: "Collaboration Snapshot",
            agentIconId: "archive",
            agentDisplayName: "Collaboration Snapshot",
            pinned: false,
            error_message: JSON.stringify({
              originalSessionId: request.sourceSessionId,
              originalCategory: "rust_agent",
              exportedAt: now,
              eventCount: localEvents.length,
              orgId: request.orgId,
              ownerMemberId: request.session.ownerMemberId,
              snapshotRequestId: request.requestId,
              ownerDisplayName: request.session.ownerDisplayName,
            }),
          });
          persistSessions(getInstrumentedStore().get(sessionsAtom));
          await eventStoreProxy.set(localEvents, localSessionId);
          if (cancelled) return;
          setSnapshotRequests((current) =>
            current.map((item) =>
              item.requestId === request.requestId
                ? { ...item, status: "completed", error: undefined }
                : item
            )
          );
          openSession(
            localSessionId,
            request.session.title,
            request.session.repoPath
          );
        }
      }

      if (!cancelled) {
        setStatus(org.id, COLLAB_CONNECTION_STATUS.CONNECTED);
      }
    };

    let timerId: number | null = null;
    let syncInFlight = false;

    const runSync = async () => {
      if (cancelled || syncInFlight || document.visibilityState !== "visible") {
        return;
      }
      syncInFlight = true;
      try {
        await Promise.allSettled(
          activeConnections.map((connection) =>
            syncConnection(connection).catch((error: unknown) => {
              if (cancelled) return;
              setStatus(
                connection.org.id,
                COLLAB_CONNECTION_STATUS.ERROR,
                error instanceof Error ? error.message : String(error)
              );
            })
          )
        );
      } finally {
        syncInFlight = false;
        if (!cancelled && document.visibilityState === "visible") {
          timerId = window.setTimeout(() => {
            timerId = null;
            void runSync();
          }, SYNC_INTERVAL_MS);
        }
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        if (!syncInFlight) {
          if (timerId !== null) window.clearTimeout(timerId);
          timerId = null;
          void runSync();
        }
      } else if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };

    if (document.visibilityState === "visible") void runSync();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    activeConnections,
    openSession,
    sessions,
    setChatMessages,
    setConnectionStates,
    setInvites,
    setMembers,
    setProjects,
    setRemoteSessions,
    setSnapshotRequests,
    setWorkItems,
    snapshotRequests,
  ]);
}
