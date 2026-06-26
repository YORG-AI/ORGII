import type { SessionTableItem } from "@src/modules/shared/layouts/blocks";
import {
  COLLAB_CONNECTION_STATUS,
  COLLAB_SESSION_ACCESS_MODE,
} from "@src/store/collaboration/types";
import type {
  CollabChatMessageRecord,
  CollabInviteRecord,
  CollabMemberRecord,
  CollabSessionAccessSettings,
  RemoteTeammateSessionMetadata,
} from "@src/store/collaboration/types";
import { formatSmartDateTime } from "@src/util/data/formatters/date";

const SESSION_STATUS_COLOR = {
  [COLLAB_CONNECTION_STATUS.CONNECTED]: "var(--color-success-6)",
  [COLLAB_CONNECTION_STATUS.CONNECTING]: "var(--color-warning-6)",
  [COLLAB_CONNECTION_STATUS.DISCONNECTED]: "var(--color-text-4)",
  [COLLAB_CONNECTION_STATUS.ERROR]: "var(--color-danger-6)",
} as const;

export function createLocalChatMessageId(orgId: string): string {
  return `${orgId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

export function formatSessionDate(
  value: string | undefined
): string | undefined {
  if (!value) return undefined;
  return formatSmartDateTime(value);
}

export function getInviteRemainingUses(invite: CollabInviteRecord): number {
  return Math.max(0, invite.usageLimit - invite.usageCount);
}

export function isToday(value: string | undefined): boolean {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

export function normalizeWorkspacePath(
  path: string | undefined
): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

export function toSessionTableItem(
  session: RemoteTeammateSessionMetadata,
  fallbackStatusLabel: string,
  metadataOnlyLabel: string
): SessionTableItem {
  return {
    id: session.id,
    title: session.title,
    description: session.ownerDisplayName,
    statusLabel:
      session.accessMode === COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY
        ? metadataOnlyLabel
        : (session.status ?? fallbackStatusLabel),
    statusColor: SESSION_STATUS_COLOR[COLLAB_CONNECTION_STATUS.CONNECTED],
    agentLabel: session.ownerDisplayName,
    workspaceLabel: session.repoPath,
    workspaceTitle: session.repoPath,
    modelLabel: session.branch,
    startedLabel: formatSessionDate(session.lastActivityAt),
    lastUpdatedLabel: formatSessionDate(session.lastActivityAt),
  };
}

export function upsertChatMessage(
  messages: CollabChatMessageRecord[],
  incoming: CollabChatMessageRecord
): CollabChatMessageRecord[] {
  const existingIndex = messages.findIndex(
    (message) => message.id === incoming.id
  );
  if (existingIndex < 0) return [...messages, incoming];
  const next = [...messages];
  next[existingIndex] = incoming;
  return next;
}

export function upsertInvite(
  invites: CollabInviteRecord[],
  incoming: CollabInviteRecord
): CollabInviteRecord[] {
  const existingIndex = invites.findIndex(
    (invite) => invite.id === incoming.id
  );
  if (existingIndex < 0) return [incoming, ...invites];
  const next = [...invites];
  next[existingIndex] = incoming;
  return next;
}

export function replaceOrgMetadata<TRecord extends Record<string, unknown>>(
  records: TRecord[],
  orgId: string,
  incoming: TRecord[]
): TRecord[] {
  return [...incoming, ...records.filter((record) => record.orgId !== orgId)];
}

export function upsertMember(
  members: CollabMemberRecord[],
  incoming: CollabMemberRecord
): CollabMemberRecord[] {
  const existingIndex = members.findIndex(
    (member) => member.id === incoming.id
  );
  if (existingIndex < 0) return [incoming, ...members];
  const next = [...members];
  next[existingIndex] = { ...members[existingIndex], ...incoming };
  return next;
}

export function getStringField(
  record: Record<string, unknown>,
  fieldNames: string[],
  fallback = "—"
): string {
  for (const fieldName of fieldNames) {
    const value = record[fieldName];
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getRecordField(
  record: Record<string, unknown>,
  fieldName: string
): Record<string, unknown> | null {
  const value = record[fieldName];
  return isRecord(value) ? value : null;
}

export function getMetadataId(record: Record<string, unknown>): string | null {
  const id = record.id;
  return typeof id === "string" && id.trim() ? id : null;
}

export function createDefaultAccessSettings(
  orgId: string,
  memberId: string,
  workspaceScope: CollabSessionAccessSettings["workspaceScope"]
): CollabSessionAccessSettings {
  return {
    orgId,
    memberId,
    accessMode: COLLAB_SESSION_ACCESS_MODE.OFF,
    workspaceScope,
    workspacePaths: [],
    updatedAt: new Date().toISOString(),
  };
}
