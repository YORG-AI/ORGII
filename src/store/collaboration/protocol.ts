/**
 * Collaboration protocol schemas.
 *
 * Post cloud-parity Phase E this module keeps only what the managed ORG2
 * Cloud plane parses off the wire: the RemoteTeammateSessionMetadata zod
 * schema (+ the enum sub-schemas it composes) and the deterministic avatar
 * identity helper. The self-hosted Supabase link layer (invite/share link
 * builders, realtime message envelopes, org/member/settings schemas) was
 * deleted with the in-app self-hosted track.
 */
import { z } from "zod/v4";

import { IMPORTED_HISTORY_SOURCE_IDS } from "@src/types/session/externalHistory";

import {
  COLLAB_IDENTITY_KIND,
  COLLAB_SESSION_ACCESS_MODE,
  COLLAB_SESSION_ORIGIN_KIND,
  COLLAB_SESSION_REPLAY_LEVEL,
  COLLAB_SESSION_VISIBILITY,
  type CollabAvatarIdentity,
  type CollabIdentityKind,
  type CollabSessionAccessMode,
  type CollabSessionReplayLevel,
  type CollabSessionVisibility,
  type RemoteTeammateSessionMetadata,
} from "./types";

export const CollabIdentityKindSchema = z.enum([
  COLLAB_IDENTITY_KIND.HUMAN,
  COLLAB_IDENTITY_KIND.AGENT,
] satisfies [CollabIdentityKind, CollabIdentityKind]);

export const CollabSessionAccessModeSchema = z.enum([
  COLLAB_SESSION_ACCESS_MODE.OFF,
  COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
  COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
] satisfies [
  CollabSessionAccessMode,
  CollabSessionAccessMode,
  CollabSessionAccessMode,
]);

export const CollabSessionVisibilitySchema = z.enum([
  COLLAB_SESSION_VISIBILITY.ORG,
  COLLAB_SESSION_VISIBILITY.RESTRICTED,
] satisfies [CollabSessionVisibility, CollabSessionVisibility]);

export const CollabSessionReplayLevelSchema = z.enum([
  COLLAB_SESSION_REPLAY_LEVEL.METADATA,
  COLLAB_SESSION_REPLAY_LEVEL.REPLAY,
] satisfies [CollabSessionReplayLevel, CollabSessionReplayLevel]);

export const RemoteTeammateSessionMetadataSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  ownerMemberId: z.string(),
  ownerUserId: z.string(),
  ownerDisplayName: z.string(),
  ownerAvatarUrl: z.string().optional(),
  ownerIdentityKind: CollabIdentityKindSchema,
  sourceSessionId: z.string(),
  title: z.string(),
  status: z.string().optional(),
  repoPath: z.string().optional(),
  // Rides in the opaque session payload jsonb (design §8.3) — no server
  // column. Trailing .optional() keeps the inferred key optional
  // (`repoScopeKey?:`), same idiom as deletedAt below.
  repoScopeKey: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  branch: z.string().optional(),
  // Owner agent/model identity (teammate hover card): opaque-payload
  // passengers like repoScopeKey — absent on rows from older clients.
  cliAgentType: z.string().optional(),
  agentDisplayName: z.string().optional(),
  // Matching hint only: receivers may preselect the same LOCAL definition
  // when installed, but must never execute an unknown remote definition id.
  agentDefinitionId: z.string().optional(),
  model: z.string().optional(),
  origin: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal(COLLAB_SESSION_ORIGIN_KIND.ORGII) }),
      z.object({
        kind: z.literal(COLLAB_SESSION_ORIGIN_KIND.EXTERNAL_HISTORY),
        source: z.enum(IMPORTED_HISTORY_SOURCE_IDS),
      }),
    ])
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  lastActivityAt: z.string().optional(),
  accessMode: CollabSessionAccessModeSchema.optional(),
  visibility: CollabSessionVisibilitySchema.optional(),
  replayLevel: CollabSessionReplayLevelSchema.optional(),
  // Viewer-specific server projection. Optional keeps older/custom cloud
  // backends compatible; absent means the row is not known to be directed.
  directlySharedWithMe: z.boolean().optional(),
  eventsEpoch: z
    .number()
    .nullish()
    .transform((value) => value ?? undefined),
  eventsFrozenSeq: z
    .number()
    .nullish()
    .transform((value) => value ?? undefined),
  eventsCount: z
    .number()
    .nullish()
    .transform((value) => value ?? undefined),
  eventsTailHash: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
  // Fork lineage (design §16.11): rides in the opaque payload jsonb like
  // repoScopeKey. Trailing .optional() keeps the inferred key optional.
  forkedFrom: z
    .object({
      sourceSessionId: z.string(),
      rootSessionId: z.string(),
      ownerDisplayName: z.string().optional(),
      forkedAt: z.string().optional(),
    })
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  // Trailing .optional() keeps the inferred key optional (`deletedAt?:`) so
  // the persisted-atom storage type stays assignable to the interface.
  deletedAt: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  // Session-comment counters (cloud migration 0014): server-side lateral
  // aggregates on `cloud_list_org_sessions` rows. Additive — absent on
  // pre-0014 backends and simply stay undefined.
  commentCount: z
    .number()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  unresolvedCommentCount: z
    .number()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
}) satisfies z.ZodType<RemoteTeammateSessionMetadata>;

export function createCollabAvatarIdentity(
  displayName: string
): CollabAvatarIdentity {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const initials = (words[0]?.[0] ?? "U") + (words[1]?.[0] ?? "");
  const normalizedInitials = initials.toLocaleUpperCase();
  const variantSeed = [...displayName].reduce(
    (sum, character) => sum + character.charCodeAt(0),
    0
  );
  return {
    initials: normalizedInitials.slice(0, 2),
    variant: variantSeed % 2 === 0 ? "v" : "h",
  };
}
