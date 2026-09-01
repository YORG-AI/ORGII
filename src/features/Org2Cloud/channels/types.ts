/**
 * Org-channels wire contract — pinned by `0014_org_channels.sql` (the SQL
 * header points at this file). Channels are the Slack-style org chat plane:
 * this slice covers the CONTROL plane only (lifecycle, membership, access
 * limits); the message plane arrives with a later migration (design:
 * docs/org-channels-design-2026-07-31.md).
 *
 * Zod schemas are tolerant of additive fields; per-field `.catch(...)`
 * degrades one malformed row instead of failing the whole listing.
 */
import { z } from "zod/v4";

export const CHANNEL_ADD_MEMBERS_MAX_PER_CALL = 100;

export const CHANNELS_ERROR_CODES = [
  "ORG2_VALIDATION",
  "ORG2_CONFLICT",
  "ORG2_QUOTA_EXCEEDED",
  "ORG2_NOT_FOUND",
  "ORG2_ORG_NOT_FOUND",
  "ORG2_AUTH_REQUIRED",
  "ORG2_MEMBER_REQUIRED",
  "ORG2_ADMIN_REQUIRED",
  "ORG2_CHANNEL_NOT_FOUND",
  "ORG2_CHANNEL_MANAGER_REQUIRED",
  "ORG2_LAST_MANAGER",
] as const;

export type CloudChannelVisibility = "org" | "private";
export type CloudChannelPostPolicy = "everyone" | "managers";
export type CloudChannelRole = "manager" | "member";

/** Absent/null → undefined. Shared with the message plane's contract. */
export const NullableStringSchema = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined)
  .optional();

export const CloudChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  topic: NullableStringSchema,
  visibility: z.enum(["org", "private"]).catch("org"),
  postPolicy: z.enum(["everyone", "managers"]).catch("everyone"),
  createdBy: NullableStringSchema,
  createdAt: z.string(),
  updatedAt: NullableStringSchema,
  archivedAt: z.string().nullable().catch(null),
  messageCount: z.number().int().nonnegative().catch(0),
  lastMessageAt: NullableStringSchema,
  memberCount: z.number().int().nonnegative().catch(0),
  myRole: z
    .enum(["manager", "member"])
    .nullish()
    .transform((value) => value ?? null)
    .catch(null),
});

export type CloudChannel = z.output<typeof CloudChannelSchema>;

/**
 * Drop-bad-rows array (the org2CloudSyncClient listing precedent): one
 * malformed row degrades to nothing instead of rejecting the whole listing
 * and blanking the sidebar section. Shared with the message plane's contract.
 */
export const tolerantRowArray = <Schema extends z.ZodType>(schema: Schema) =>
  z
    .array(z.unknown())
    .default([])
    .transform((rows) =>
      rows.flatMap((row) => {
        const parsed = schema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      })
    );

export const CloudChannelsListSchema = z.object({
  channels: tolerantRowArray(CloudChannelSchema),
  serverTime: NullableStringSchema,
});

export type CloudChannelsList = z.output<typeof CloudChannelsListSchema>;

const CloudChannelMemberSchema = z.object({
  userId: z.string(),
  displayName: NullableStringSchema,
  avatarUrl: NullableStringSchema,
  role: z.enum(["manager", "member"]).catch("member"),
  addedAt: NullableStringSchema,
});

export type CloudChannelMember = z.output<typeof CloudChannelMemberSchema>;

export const CloudChannelMembersSchema = z.object({
  members: tolerantRowArray(CloudChannelMemberSchema),
});

export interface CreateCloudChannelInput {
  name: string;
  topic?: string;
  visibility: CloudChannelVisibility;
  postPolicy: CloudChannelPostPolicy;
  /** Only meaningful (and only accepted server-side) for `private`. */
  memberUserIds?: readonly string[];
}

export interface UpdateCloudChannelInput {
  name?: string;
  /** Empty string clears the topic (0014 contract). */
  topic?: string;
  postPolicy?: CloudChannelPostPolicy;
}
