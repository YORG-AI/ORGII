import { resolveAgentIcon } from "@src/config/agentIcons";
import {
  type CloudSessionReference,
  parseCloudSessionReference,
} from "@src/features/Org2Cloud/cloudSessionReference";
import {
  type Org2CloudAuthState,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  type CloudOrgRemoteSessionsEntry,
  remoteSessionsEntryForIdentity,
} from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { resolveSessionReferenceTitle } from "@src/features/Org2Cloud/resolveSessionReferenceTitle";
import { UserMultipleIcon } from "@src/icons";
import {
  isSessionCompletedUnread,
  isSessionPendingAsking,
} from "@src/scaffold/NavigationSidebar/connectors/useSessionMenuItems/menuItemBuilders";
import {
  renderBreathingStatusDot,
  renderStatusDot,
} from "@src/scaffold/NavigationSidebar/connectors/useSessionMenuItems/statusIndicators";
import type { Session } from "@src/store/session";
import { resolveSessionDisplayMetadata } from "@src/util/session/sessionDisplayMetadata";
import { isSessionInProgress } from "@src/util/session/sessionInProgress";
import {
  getSessionListDisplayName,
  resolveSessionRowIcon,
} from "@src/util/session/sessionSidebarRow";

import type { SpotlightItem } from "../../types";

export interface ResolvedAgentSessionSearchInput {
  query: string;
  reference: CloudSessionReference | null;
}

/**
 * A copied cloud reference is an exact session identity, not free text.
 * Preserve the parsed tuple for navigation while using its source id for
 * any local/imported-row lookup.
 */
export function resolveAgentSessionSearchInput(
  value: string
): ResolvedAgentSessionSearchInput {
  const reference = parseCloudSessionReference(value);
  return {
    query: reference?.sourceSessionId ?? value,
    reference,
  };
}

interface ResolveSpotlightCloudSessionPresentationInput {
  reference: CloudSessionReference;
  fallbackLabel: string;
  auth: Pick<Org2CloudAuthState, "supabaseUrl" | "userId"> | null;
  remoteEntries: Record<string, CloudOrgRemoteSessionsEntry>;
  localSessions: readonly Session[];
}

export interface SpotlightCloudSessionPresentation {
  label: string;
  icon: SpotlightItem["icon"];
}

/**
 * Resolve a reference title and agent icon only from data already authorized
 * for the active cloud identity. Local presentation is eligible only when the
 * reference owner is the signed-in user; source ids are not globally unique
 * across publishers.
 */
export function resolveSpotlightCloudSessionPresentation({
  reference,
  fallbackLabel,
  auth,
  remoteEntries,
  localSessions,
}: ResolveSpotlightCloudSessionPresentationInput): SpotlightCloudSessionPresentation {
  const identityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const remoteEntry = remoteSessionsEntryForIdentity(
    remoteEntries[reference.orgId],
    identityKey
  );
  const localSession =
    auth?.userId === reference.ownerUserId
      ? localSessions.find(
          (session) => session.session_id === reference.sourceSessionId
        )
      : undefined;
  const localTitle = localSession
    ? getSessionListDisplayName(localSession, "")
    : undefined;
  const remoteRow = remoteEntry?.rows.find(
    (candidate) =>
      candidate.sourceSessionId === reference.sourceSessionId &&
      candidate.ownerUserId === reference.ownerUserId
  );
  const remoteIcon = remoteRow
    ? resolveAgentIcon(
        resolveSessionDisplayMetadata({
          kind: "remote",
          session: remoteRow,
        }).agentIconId
      )
    : undefined;

  return {
    label:
      resolveSessionReferenceTitle({
        reference,
        orgRows: remoteEntry?.rows,
        localTitle,
      }) ?? fallbackLabel,
    icon: localSession
      ? resolveSessionRowIcon(localSession)
      : (remoteIcon ?? UserMultipleIcon),
  };
}

interface BuildSpotlightSessionItemsInput {
  sessions: readonly Session[];
  fallbackSessionLabel: string;
  visitedSessions: ReadonlySet<string>;
  query: string;
  onSelect: (session: Session, sessionName: string) => void;
  limit?: number;
  idPrefix?: string;
}

function matchedSessionIdentity(
  session: Session,
  query: string
): string | undefined {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return undefined;

  return [session.session_id, session.importedFrom?.sourceSessionId].find(
    (identity): identity is string =>
      Boolean(identity?.toLowerCase().includes(normalizedQuery))
  );
}

/**
 * Shared row builder for both the nested and general Spotlight searches.
 * The general palette passes a limit; the dedicated palette renders all
 * filtered rows.
 */
export function buildSpotlightSessionItems({
  sessions,
  fallbackSessionLabel,
  visitedSessions,
  query,
  onSelect,
  limit,
  idPrefix,
}: BuildSpotlightSessionItemsInput): SpotlightItem[] {
  const visibleSessions =
    limit === undefined ? sessions : sessions.slice(0, limit);

  return visibleSessions.map((session) => {
    const sessionName = getSessionListDisplayName(
      session,
      fallbackSessionLabel
    );
    const inProgress = isSessionInProgress(session.status, session);
    const pendingAsking = isSessionPendingAsking(session);
    const unread = isSessionCompletedUnread(session, visitedSessions);
    const statusDotTone = pendingAsking
      ? "asking"
      : unread
        ? "unread"
        : "default";

    return {
      id: idPrefix ? `${idPrefix}:${session.session_id}` : session.session_id,
      label: sessionName,
      desc: matchedSessionIdentity(session, query),
      icon: resolveSessionRowIcon(session),
      type: "option" as const,
      data: {
        statusContent:
          inProgress && !pendingAsking
            ? renderBreathingStatusDot()
            : renderStatusDot(statusDotTone),
        iconTone: "text1",
      },
      action: () => onSelect(session, sessionName),
    };
  });
}

interface BuildCloudSessionReferenceItemInput {
  reference: CloudSessionReference;
  label: string;
  icon?: SpotlightItem["icon"];
  onSelect: (reference: CloudSessionReference) => void;
  idPrefix?: string;
}

export function buildCloudSessionReferenceItem({
  reference,
  label,
  icon = UserMultipleIcon,
  onSelect,
  idPrefix = "cloud-session-reference",
}: BuildCloudSessionReferenceItemInput): SpotlightItem {
  return {
    id: `${idPrefix}:${reference.orgId}:${reference.ownerUserId}:${reference.sourceSessionId}`,
    label,
    desc: reference.sourceSessionId,
    icon,
    type: "option",
    data: { iconTone: "text1" },
    action: () => onSelect(reference),
  };
}
