/**
 * Org-channel MESSAGE plane wire contract — the sibling of `types.ts` (which
 * pins the CONTROL plane: lifecycle, membership, access limits). The message
 * migration's SQL header points at this file.
 *
 * Two read shapes come back from the same RPC:
 *
 *  - **page** (`p_cursor`): DESCENDING keyset with `nextCursor` shaped
 *    `"<ISO>|<uuid>"`. The client reverses each page for display, so the
 *    transcript stays ascending like the local plane's.
 *  - **delta** (`p_since`): ASCENDING rows whose `stateChangedAt` is newer
 *    than the cursor — edits and tombstones INCLUDED, which is what makes a
 *    realtime bump reconcilable without re-listing. Capped server-side; a
 *    `hasMore: true` delta means "too much changed, reload the page".
 *
 * Zod schemas are tolerant of additive fields; per-field `.catch(...)`
 * degrades one malformed row instead of failing the whole page.
 */
import { z } from "zod/v4";

import { LOCAL_CHANNEL_MESSAGE_MAX_LENGTH } from "@src/store/ui/localChannelMessagesAtom";

import {
  CHANNELS_ERROR_CODES,
  NullableStringSchema,
  tolerantRowArray,
} from "./types";

/** RPC-enforced body ceiling — the same 4000 as the local/comment planes. */
// Derived from the local plane's constant: the shared row editor caps at
// the LOCAL constant, so an independent 4000 here would drift silently the
// day the server bound changes.
export const CHANNEL_MESSAGE_MAX_LENGTH = LOCAL_CHANNEL_MESSAGE_MAX_LENGTH;

/** Rows per page read; matches the RPC's own `p_limit` default. */
export const CHANNEL_MESSAGES_PAGE_SIZE = 50;

/**
 * The control-plane codes plus the three the message RPCs add. Kept as one
 * list so a single error class can whole-token match anything the message
 * plane can answer with.
 */
export const CHANNEL_MESSAGES_ERROR_CODES = [
  ...CHANNELS_ERROR_CODES,
  /** Posting/editing in an archived channel. */
  "ORG2_CHANNEL_ARCHIVED",
  /** Posting into a channel already at its 10000-row cap (0016). */
  "ORG2_CHANNEL_MESSAGES_FULL",
  /** `postPolicy: "managers"` and the caller is not one. */
  "ORG2_CHANNEL_POST_FORBIDDEN",
  /** Edit/delete of a message that is gone (or was never the caller's). */
  "ORG2_MESSAGE_NOT_FOUND",
] as const;

export const CloudChannelMessageSchema = z
  .object({
    id: z.string(),
    channelId: z.string(),
    authorUserId: z.string(),
    authorDisplayName: NullableStringSchema,
    authorAvatarUrl: NullableStringSchema,
    body: z.string().catch(""),
    createdAt: z.string(),
    editedAt: z.string().nullable().catch(null),
    deletedAt: z.string().nullable().catch(null),
    clientKey: z.string().nullable().catch(null).optional(),
    /** Ordering key for delta reads: max(createdAt, editedAt, deletedAt). */
    stateChangedAt: z.string().nullish(),
    mentionedUserIds: z.array(z.string()).catch([]),
  })
  .transform((row) => ({
    ...row,
    // Tombstones ship `""`; blank it here too so a body can never leak back
    // into the transcript from a tolerant/older payload.
    body: row.deletedAt === null ? row.body : "",
    // Same erasure for mentions (0017): they are message content, and a
    // pre-0017 backend still ships them on tombstones.
    mentionedUserIds: row.deletedAt === null ? row.mentionedUserIds : [],
    stateChangedAt:
      row.stateChangedAt ?? row.deletedAt ?? row.editedAt ?? row.createdAt,
  }));

export type CloudChannelMessage = z.output<typeof CloudChannelMessageSchema>;

export const CloudChannelMessagesPageSchema = z.object({
  messages: tolerantRowArray(CloudChannelMessageSchema),
  /** Keyset cursor for the NEXT older page; null once the head is reached. */
  nextCursor: z.string().nullable().catch(null),
  unreadCount: z.number().int().nonnegative().catch(0),
  /** Cursor for the next delta read. */
  serverTime: NullableStringSchema,
  hasMore: z.boolean().catch(false),
});

export type CloudChannelMessagesPage = z.output<
  typeof CloudChannelMessagesPageSchema
>;

export const CloudChannelReadCursorSchema = z.object({
  lastReadAt: z.string().nullable().catch(null),
  unreadCount: z.number().int().nonnegative().catch(0),
});

export type CloudChannelReadCursor = z.output<
  typeof CloudChannelReadCursorSchema
>;

export const CloudChannelMessageEnvelopeSchema = z.object({
  message: CloudChannelMessageSchema,
});
