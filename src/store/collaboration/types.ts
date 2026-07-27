/**
 * Shared collaboration wire types.
 *
 * Post cloud-parity Phase E this module carries only the backend-agnostic
 * protocol the managed ORG2 Cloud plane consumes: the session access ladder
 * consts, the remote-session metadata record (+ fork lineage), and the
 * org/member record shapes reused by the projects sync channel. The
 * self-hosted Supabase link layer (sync backend consts, realtime envelope
 * types, connection state, chat/invite/snapshot records) was deleted with
 * the in-app self-hosted track.
 */
import type { ImportedHistorySourceId } from "@src/types/session/externalHistory";

export const COLLAB_ROLE = {
  ADMIN: "admin",
  MEMBER: "member",
} as const;

export type CollabRole = (typeof COLLAB_ROLE)[keyof typeof COLLAB_ROLE];

export const COLLAB_IDENTITY_KIND = {
  HUMAN: "human",
  AGENT: "agent",
} as const;

export type CollabIdentityKind =
  (typeof COLLAB_IDENTITY_KIND)[keyof typeof COLLAB_IDENTITY_KIND];

export const COLLAB_SESSION_ACCESS_MODE = {
  OFF: "off",
  METADATA_ONLY: "metadata_only",
  FULL_REPLAY: "full_replay",
} as const;

export type CollabSessionAccessMode =
  (typeof COLLAB_SESSION_ACCESS_MODE)[keyof typeof COLLAB_SESSION_ACCESS_MODE];

/**
 * Server-side session visibility (design §6.2). Derived from the owner's
 * effective access mode at push time; a null column on pre-M4 rows is read
 * as 'org' by every server filter.
 */
export const COLLAB_SESSION_VISIBILITY = {
  ORG: "org",
  RESTRICTED: "restricted",
} as const;

export type CollabSessionVisibility =
  (typeof COLLAB_SESSION_VISIBILITY)[keyof typeof COLLAB_SESSION_VISIBILITY];

/**
 * Replay depth of a shared session / share grant (design §6.2):
 * 'metadata' — listing only; 'replay' — event segments included.
 */
export const COLLAB_SESSION_REPLAY_LEVEL = {
  METADATA: "metadata",
  REPLAY: "replay",
} as const;

export type CollabSessionReplayLevel =
  (typeof COLLAB_SESSION_REPLAY_LEVEL)[keyof typeof COLLAB_SESSION_REPLAY_LEVEL];

export const COLLAB_SESSION_ORIGIN_KIND = {
  ORGII: "orgii",
  EXTERNAL_HISTORY: "external_history",
} as const;

export type RemoteSessionOrigin =
  | { kind: typeof COLLAB_SESSION_ORIGIN_KIND.ORGII }
  | {
      kind: typeof COLLAB_SESSION_ORIGIN_KIND.EXTERNAL_HISTORY;
      source: ImportedHistorySourceId;
    };

export const COLLAB_WORKSPACE_SCOPE = {
  SELECTED_WORKSPACES: "selected_workspaces",
} as const;

export type CollabWorkspaceScope =
  (typeof COLLAB_WORKSPACE_SCOPE)[keyof typeof COLLAB_WORKSPACE_SCOPE];

export interface CollabAvatarIdentity {
  initials: string;
  variant: string;
}

/**
 * Org record consumed by the shared `ProjectSyncChannel` and the cloud sync
 * engine (which synthesizes one per cloud org: `{id, name, projectOrgId}`).
 */
export interface CollabOrgRecord {
  id: string;
  name: string;
  projectOrgId?: string;
  groupId?: string;
  adminMemberId?: string;
  localMemberId?: string;
  repoScopes?: string[];
  createdAt: string;
}

export interface CollabMemberRecord {
  id: string;
  orgId: string;
  displayName: string;
  avatar: CollabAvatarIdentity;
  role: CollabRole;
  identityKind: CollabIdentityKind;
  joinedAt: string;
  removedAt?: string;
}

export type CollabProjectMetadataRecord = Record<string, unknown>;

export type CollabWorkItemMetadataRecord = Record<string, unknown>;

export interface CollabSessionAccessSettings {
  orgId: string;
  memberId: string;
  accessMode: CollabSessionAccessMode;
  /**
   * Per-session escape hatch (design §6.3): overrides accessMode AND the
   * shareSince gate for the keyed sourceSessionId.
   */
  sessionOverrides?: Record<string, CollabSessionAccessMode>;
  /**
   * "Only share sessions created from here on" (design §6.3): sessions with
   * created_at before this ISO timestamp are treated as OFF unless they
   * carry an explicit sessionOverrides entry. Gate is by CREATION time, not
   * last activity — reopening an old session must not leak its history.
   */
  shareSince?: string;
  /**
   * Per-session visibility choice (design §6.2/§6.3, M4b): 'restricted' when
   * the owner explicitly picks "only me + people I pick" in the share dialog
   * — the server then hides the row from org-wide listing and only directed
   * share grantees see it. Absent / 'org' keeps the M4a org-visible default.
   * Keyed by sourceSessionId.
   */
  sessionVisibility?: Record<string, CollabSessionVisibility>;
  workspaceScope: CollabWorkspaceScope;
  workspacePaths: string[];
  updatedAt: string;
}

/**
 * Fork lineage carried on the wire (rides in the opaque session payload
 * jsonb — no server column). Minimal by design: enough for teammates to
 * group fork threads and attribute them, no member-id leakage beyond what
 * the session row itself already carries.
 */
export interface RemoteSessionForkLineage {
  /** Immediate parent session (bare session id, owner-side). */
  sourceSessionId: string;
  /**
   * Denormalized thread root (bare session id). Survives the parent falling
   * out of the retention window — consumers group threads on THIS.
   */
  rootSessionId: string;
  /** Display name of the parent's owner at fork time (attribution only). */
  ownerDisplayName?: string;
  forkedAt?: string;
}

export interface RemoteTeammateSessionMetadata {
  id: string;
  orgId: string;
  ownerMemberId: string;
  ownerUserId: string;
  ownerDisplayName: string;
  ownerAvatarUrl?: string;
  ownerIdentityKind: CollabIdentityKind;
  sourceSessionId: string;
  title: string;
  status?: string;
  repoPath?: string;
  /**
   * Normalized git-remote scope key of the session's repo (design §8.3),
   * resolved on the OWNER's machine at push time. Consumers match THIS
   * against org.repoScopes — repoPath is the owner's local absolute path
   * and cannot be resolved elsewhere. Absent ⇒ old client or a repo with no
   * git remote ⇒ the session is out of every scope (git-remote-only
   * sharing). Must be mirrored in RemoteTeammateSessionMetadataSchema.
   */
  repoScopeKey?: string;
  branch?: string;
  /**
   * Owner's agent/model identity for the teammate hover card (display
   * only). Rides in the opaque payload jsonb like repoScopeKey — absent on
   * rows pushed by older clients. Must be mirrored in
   * RemoteTeammateSessionMetadataSchema.
   */
  cliAgentType?: string;
  agentDisplayName?: string;
  /** Display/matching hint only; never remote execution authority. */
  agentDefinitionId?: string;
  model?: string;
  /**
   * First-class source provenance for replay/fork UX. Older rows omit it and
   * are treated as ORGII-native; external rows always include the adapter id.
   */
  origin?: RemoteSessionOrigin;
  lastActivityAt?: string;
  accessMode?: CollabSessionAccessMode;
  // Sharing plane (design §6.2): server columns fed from these payload
  // fields at push time. Absent on pre-M4 rows (server reads null as 'org').
  visibility?: CollabSessionVisibility;
  replayLevel?: CollabSessionReplayLevel;
  /**
   * True when the current viewer has an active directed grant for this row.
   * Server-derived per request (never owner-authored metadata), so the Team
   * sessions UI can distinguish "available to the org" from "specifically
   * shared with me" without guessing from visibility.
   */
  directlySharedWithMe?: boolean;
  // Segments summary (design §7.3): mirrors the sessions summary columns.
  // All undefined ⇒ the owner has not published event segments.
  eventsEpoch: number | undefined;
  eventsFrozenSeq: number | undefined;
  eventsCount: number | undefined;
  eventsTailHash: string | undefined;
  /**
   * Present iff the owner's session is a fork (design §16.11). Rides in the
   * opaque payload jsonb like repoScopeKey — absent on non-forks and on rows
   * pushed by pre-lineage clients.
   */
  forkedFrom?: RemoteSessionForkLineage;
  deletedAt?: string;
  /**
   * Session-comment counters (cloud migration 0014): live comments /
   * unresolved live top-level threads, aggregated server-side per listing
   * row. Additive and cloud-only — absent on pre-0014 backends. Must be
   * mirrored in RemoteTeammateSessionMetadataSchema.
   */
  commentCount?: number;
  unresolvedCommentCount?: number;
}
