import { useAtomValue } from "jotai";
import React, { useMemo } from "react";

import { ConversationSenderMetadataProvider } from "@src/engines/ChatPanel/ChatItems/ConversationSenderMetadataContext";
import type {
  ConversationSenderIdentity,
  ConversationSenderStamp,
} from "@src/engines/SessionCore/conversations/conversationSenderMetadata";
import { resolveConversationViewerState } from "@src/engines/SessionCore/conversations/conversationSenderMetadata";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { getSessionForkedFrom } from "@src/features/TeamCollaboration/forkSession";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type {
  Session,
  SessionForkedFrom,
  SessionImportedFrom,
} from "@src/store/session";

import { useSessionCommentsContext } from "../SessionComments/SessionCommentsContext";
import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "../org2CloudAuthAtom";
import { parseCloudOrgSelectorValue } from "../org2CloudOrgsAtom";
import {
  org2CloudRemoteSessionsAtom,
  remoteSessionsEntryForIdentity,
} from "../org2CloudRemoteSessionsAtom";
import { useCloudSessionLoadingSource } from "../useCloudSessionDownloadSurface";

const EMPTY_REMOTE_ROWS: readonly RemoteTeammateSessionMetadata[] = [];

function trimmed(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function remoteRowIdentity(
  row: RemoteTeammateSessionMetadata | undefined
): ConversationSenderIdentity | null {
  if (!row) return null;
  return {
    userId: trimmed(row.ownerUserId),
    displayName: trimmed(row.ownerDisplayName),
    avatarUrl: trimmed(row.ownerAvatarUrl),
  };
}

function compactIdentity(
  identity: ConversationSenderIdentity
): ConversationSenderIdentity | null {
  const userId = trimmed(identity.userId);
  const displayName = trimmed(identity.displayName);
  const avatarUrl = trimmed(identity.avatarUrl);
  return userId || displayName || avatarUrl
    ? {
        ...(userId ? { userId } : {}),
        ...(displayName ? { displayName } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
      }
    : null;
}

interface Org2ConversationSourceSenderInput {
  importedFrom?: SessionImportedFrom;
  forkedFrom?: SessionForkedFrom;
  rows: readonly RemoteTeammateSessionMetadata[];
  loadingSource?: RemoteTeammateSessionMetadata;
}

/**
 * Resolve imported/forked pre-stamp rows from their source metadata. This is
 * the only compatibility fallback: it returns null instead of inventing a
 * generic author when no authoritative name/account is available.
 */
export function resolveOrg2ConversationSourceSender({
  importedFrom,
  forkedFrom,
  rows,
  loadingSource,
}: Org2ConversationSourceSenderInput): ConversationSenderIdentity | null {
  const origin = importedFrom ?? forkedFrom;
  if (!origin) return remoteRowIdentity(loadingSource);
  const sourceRow = rows.find(
    (row) =>
      row.orgId === origin.orgId &&
      row.sourceSessionId === origin.sourceSessionId
  );
  const matchingLoadingSource =
    loadingSource?.orgId === origin.orgId &&
    loadingSource.sourceSessionId === origin.sourceSessionId
      ? loadingSource
      : undefined;
  return compactIdentity({
    userId: sourceRow?.ownerUserId ?? matchingLoadingSource?.ownerUserId,
    displayName:
      importedFrom?.ownerDisplayName ??
      forkedFrom?.ownerDisplayName ??
      sourceRow?.ownerDisplayName ??
      matchingLoadingSource?.ownerDisplayName,
    avatarUrl:
      importedFrom?.ownerAvatarUrl ??
      sourceRow?.ownerAvatarUrl ??
      matchingLoadingSource?.ownerAvatarUrl,
  });
}

export function resolveOrg2ConversationEventSender(
  stampedSender: ConversationSenderStamp | null,
  knownAccounts: ReadonlyMap<string, ConversationSenderIdentity>,
  sourceSender: ConversationSenderIdentity | null
): ConversationSenderIdentity | null {
  if (!stampedSender) return sourceSender;
  const known = knownAccounts.get(stampedSender.userId);
  return compactIdentity({
    userId: stampedSender.userId,
    displayName: stampedSender.displayName ?? known?.displayName,
    avatarUrl: stampedSender.avatarUrl ?? known?.avatarUrl,
  });
}

function rememberAccount(
  accounts: Map<string, ConversationSenderIdentity>,
  identity: ConversationSenderIdentity
): void {
  const userId = trimmed(identity.userId);
  if (!userId) return;
  const previous = accounts.get(userId);
  accounts.set(userId, {
    userId,
    displayName:
      trimmed(previous?.displayName) ?? trimmed(identity.displayName),
    avatarUrl: trimmed(previous?.avatarUrl) ?? trimmed(identity.avatarUrl),
  });
}

interface Org2ConversationSenderMetadataProviderProps {
  sessionId: string;
  session: Session | null;
  children: React.ReactNode;
}

/** Subscribed Cloud composition adapter for the provider-neutral context. */
function SubscribedOrg2ConversationSenderMetadataProvider({
  sessionId,
  session,
  children,
}: Org2ConversationSenderMetadataProviderProps): React.ReactElement {
  const auth = useAtomValue(org2CloudAuthAtom);
  const remoteEntries = useAtomValue(org2CloudRemoteSessionsAtom);
  const loadingSource = useCloudSessionLoadingSource(sessionId);
  const comments = useSessionCommentsContext();
  const viewer = resolveConversationViewerState(
    auth?.userId ?? comments?.viewerUserId ?? null,
    true
  );
  const forkedFrom = useMemo(
    () => (session ? getSessionForkedFrom(session) : undefined),
    [session]
  );
  const orgId =
    comments?.target.orgId ??
    session?.importedFrom?.orgId ??
    forkedFrom?.orgId ??
    loadingSource?.orgId;
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const rows = useMemo(
    () =>
      orgId
        ? (remoteSessionsEntryForIdentity(remoteEntries[orgId], authIdentityKey)
            ?.rows ?? EMPTY_REMOTE_ROWS)
        : EMPTY_REMOTE_ROWS,
    [authIdentityKey, orgId, remoteEntries]
  );

  const knownAccounts = useMemo(() => {
    const accounts = new Map<string, ConversationSenderIdentity>();
    for (const member of comments?.mentionableMembers ?? []) {
      rememberAccount(accounts, {
        userId: member.userId,
        displayName: member.displayName,
      });
    }
    for (const row of rows) {
      rememberAccount(accounts, {
        userId: row.ownerUserId,
        displayName: row.ownerDisplayName,
        avatarUrl: row.ownerAvatarUrl,
      });
    }
    if (auth) {
      rememberAccount(accounts, {
        userId: auth.userId,
        displayName: auth.profile?.displayName,
        avatarUrl: auth.profile?.avatarUrl,
      });
    }
    return accounts;
  }, [auth, comments?.mentionableMembers, rows]);

  const sourceSender = useMemo(
    () =>
      resolveOrg2ConversationSourceSender({
        importedFrom: session?.importedFrom,
        forkedFrom,
        rows,
        loadingSource,
      }),
    [forkedFrom, loadingSource, rows, session?.importedFrom]
  );

  const value = useMemo(
    () => ({
      viewer,
      resolveSender: (
        _event: SessionEvent,
        stampedSender: ConversationSenderStamp | null
      ) =>
        resolveOrg2ConversationEventSender(
          stampedSender,
          knownAccounts,
          sourceSender
        ),
    }),
    [knownAccounts, sourceSender, viewer]
  );

  return (
    <ConversationSenderMetadataProvider value={value}>
      {children}
    </ConversationSenderMetadataProvider>
  );
}

/**
 * Keep ordinary local chats off the Cloud sender-metadata subscriptions.
 * SessionCommentsContext is already mounted by the parent and is the cheap,
 * authoritative target gate; lineage and launch ownership cover imported or
 * cloud sessions while their comment target is still resolving.
 */
export function Org2ConversationSenderMetadataProvider(
  props: Org2ConversationSenderMetadataProviderProps
): React.ReactElement {
  const comments = useSessionCommentsContext();
  const forkedFrom = props.session
    ? getSessionForkedFrom(props.session)
    : undefined;
  const isCloudSession = Boolean(
    comments?.target ||
    props.session?.importedFrom ||
    forkedFrom ||
    (props.session?.orgId &&
      parseCloudOrgSelectorValue(props.session.orgId) !== null)
  );
  if (!isCloudSession) return <>{props.children}</>;
  return <SubscribedOrg2ConversationSenderMetadataProvider {...props} />;
}
