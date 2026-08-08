/**
 * Local (non-cloud) channel MESSAGES — the single-user message plane that
 * sits under `localChannelsAtom`'s control plane, persisted on this machine
 * only.
 *
 * The cloud control plane shipped by `0014_org_channels.sql` has no message
 * RPCs yet, so cloud channels render the same surface with a disabled
 * composer. Local channels get a working plane instead, and the pure reducers
 * below pre-commit to the semantics the eventual cloud message RPCs will
 * carry, so a later migration cannot surprise the UI:
 *   - bodies are trimmed and bounded to 1..`LOCAL_CHANNEL_MESSAGE_MAX_LENGTH`
 *     (the same 4000 ceiling as the cloud comment plane),
 *   - delete is a TOMBSTONE (`deletedAt` stamped, body blanked at read time)
 *     so a message's slot in the transcript survives its removal — exactly
 *     how `CommentThreadList` renders "comment deleted",
 *   - each channel is capped at `LOCAL_CHANNEL_MESSAGE_MAX_PER_CHANNEL` rows.
 *
 * Authorship is implicit: this store is single-user by construction, so every
 * row is the local user's and edit/delete are never role-gated.
 *
 * Persistence uses the same zod-validated localStorage idiom as
 * `localChannelsAtom`: garbage bytes parse to the initial empty list instead
 * of crashing hydration, and a single malformed row degrades just that row.
 */
import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod/v4";

import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

/** Colon-style key (codebase convention); the dot-style original is adopted below. */
export const LOCAL_CHANNEL_MESSAGES_STORAGE_KEY =
  "orgii:localChannelMessages:v1";
const LEGACY_LOCAL_CHANNEL_MESSAGES_STORAGE_KEY =
  "orgii.localChannelMessages.v1";

// One-time adoption of the briefly-shipped dot-style key.
try {
  if (typeof localStorage !== "undefined") {
    const legacy = localStorage.getItem(
      LEGACY_LOCAL_CHANNEL_MESSAGES_STORAGE_KEY
    );
    if (legacy !== null) {
      if (localStorage.getItem(LOCAL_CHANNEL_MESSAGES_STORAGE_KEY) === null) {
        localStorage.setItem(LOCAL_CHANNEL_MESSAGES_STORAGE_KEY, legacy);
      }
      localStorage.removeItem(LEGACY_LOCAL_CHANNEL_MESSAGES_STORAGE_KEY);
    }
  }
} catch {
  // Storage unavailable — nothing to migrate.
}

/** Same body ceiling as the cloud session-comment plane. */
export const LOCAL_CHANNEL_MESSAGE_MAX_LENGTH = 4000;

/** Per-channel live-row cap; posting past it fails with `"quota"`. */
export const LOCAL_CHANNEL_MESSAGE_MAX_PER_CHANNEL = 500;

/** Whole-store row cap so many archived channels cannot grow memory forever. */
export const LOCAL_CHANNEL_MESSAGE_MAX_TOTAL = 2_000;

/**
 * Conservative localStorage payload budget. Browsers commonly allow about
 * 5 MiB per origin; leave headroom for the channel registry and other app
 * state instead of relying on a synchronous QuotaExceededError.
 */
export const LOCAL_CHANNEL_MESSAGE_STORAGE_BUDGET_BYTES = 4 * 1024 * 1024;

const textEncoder = new TextEncoder();
const storedBytesByArray = new WeakMap<
  readonly LocalChannelMessage[],
  number
>();

function storedMessageBytes(messages: readonly LocalChannelMessage[]): number {
  const cached = storedBytesByArray.get(messages);
  if (cached !== undefined) return cached;
  const bytes = textEncoder.encode(JSON.stringify(messages)).byteLength;
  storedBytesByArray.set(messages, bytes);
  return bytes;
}

function serializedMessageBytes(message: LocalChannelMessage): number {
  return textEncoder.encode(JSON.stringify(message)).byteLength;
}

export const LocalChannelMessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  body: z.string(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});

export type LocalChannelMessage = z.output<typeof LocalChannelMessageSchema>;

/** Tolerant list schema: drop malformed rows (logged), keep the rest. */
const StoredLocalChannelMessagesSchema: z.ZodType<LocalChannelMessage[]> = z
  .array(z.unknown())
  .transform((rows) =>
    rows.flatMap((row) => {
      const parsed = LocalChannelMessageSchema.safeParse(row);
      if (!parsed.success) {
        // Trace per-row drops — the next whole-list write makes them final.
        console.warn("[localChannelMessages] dropped malformed row", row);
        return [];
      }
      return [parsed.data];
    })
  );

export const localChannelMessagesAtom = atomWithStorage<LocalChannelMessage[]>(
  LOCAL_CHANNEL_MESSAGES_STORAGE_KEY,
  [],
  createZodJsonStorage(StoredLocalChannelMessagesSchema, {
    onInvalid: (key, _rawValue, error) => {
      console.warn(
        `[localChannelMessages] invalid stored payload for ${key}`,
        error
      );
    },
  }),
  { getOnInit: true }
);
localChannelMessagesAtom.debugLabel = "localChannelMessagesAtom";

// ---------------------------------------------------------------------------
// Pure reducers
// ---------------------------------------------------------------------------

export type LocalChannelMessageErrorCode =
  | "empty"
  | "tooLong"
  | "quota"
  | "invalid";

export type LocalChannelMessageResult =
  | {
      ok: true;
      messages: LocalChannelMessage[];
      message: LocalChannelMessage;
    }
  | { ok: false; error: LocalChannelMessageErrorCode };

function fail(error: LocalChannelMessageErrorCode): LocalChannelMessageResult {
  return { ok: false, error };
}

/**
 * Trim first, then bound. `"empty"` and `"tooLong"` stay distinct so the
 * composer can explain WHY a submit was refused rather than silently no-op.
 */
function normalizeBody(
  raw: string
): { ok: true; body: string } | { ok: false; error: "empty" | "tooLong" } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: "empty" };
  if (trimmed.length > LOCAL_CHANNEL_MESSAGE_MAX_LENGTH) {
    return { ok: false, error: "tooLong" };
  }
  return { ok: true, body: trimmed };
}

/**
 * LIVE rows for a channel — tombstones do NOT hold a slot. Counting them
 * made a full channel permanently read-only (deleting messages never freed
 * room), and the cloud design has no per-channel cap at all; the local cap
 * is purely a storage bound. Stored tombstones are compacted oldest-first
 * on post once the total row count reaches the cap.
 */
function countLiveChannelMessages(
  messages: readonly LocalChannelMessage[],
  channelId: string
): number {
  return messages.reduce(
    (count, message) =>
      message.channelId === channelId && message.deletedAt === null
        ? count + 1
        : count,
    0
  );
}

/** Evict oldest tombstones of the channel until its total rows fit the cap. */
function compactChannelTombstones(
  messages: readonly LocalChannelMessage[],
  channelId: string
): readonly LocalChannelMessage[] {
  const totalRows = messages.reduce(
    (count, message) => (message.channelId === channelId ? count + 1 : count),
    0
  );
  let toEvict = totalRows - (LOCAL_CHANNEL_MESSAGE_MAX_PER_CHANNEL - 1);
  if (toEvict <= 0) return messages;
  const evictIds = new Set<string>();
  for (const message of messages) {
    if (toEvict === 0) break;
    if (message.channelId === channelId && message.deletedAt !== null) {
      evictIds.add(message.id);
      toEvict -= 1;
    }
  }
  if (evictIds.size === 0) return messages;
  return messages.filter((message) => !evictIds.has(message.id));
}

/** Evict oldest tombstones from any channel to reserve one global row slot. */
function compactGlobalTombstones(
  messages: readonly LocalChannelMessage[]
): readonly LocalChannelMessage[] {
  let toEvict = messages.length - (LOCAL_CHANNEL_MESSAGE_MAX_TOTAL - 1);
  if (toEvict <= 0) return messages;
  const evictIds = new Set<string>();
  for (const message of messages) {
    if (toEvict === 0) break;
    if (message.deletedAt !== null) {
      evictIds.add(message.id);
      toEvict -= 1;
    }
  }
  if (evictIds.size === 0) return messages;
  return messages.filter((message) => !evictIds.has(message.id));
}

export interface PostLocalChannelMessageInput {
  channelId: string;
  body: string;
  /** Injectable for tests; defaults to `crypto.randomUUID()`. */
  id?: string;
  /** Injectable for tests; defaults to `new Date().toISOString()`. */
  now?: string;
}

export function postLocalChannelMessage(
  messages: readonly LocalChannelMessage[],
  input: PostLocalChannelMessageInput
): LocalChannelMessageResult {
  if (input.channelId.length === 0) return fail("invalid");
  const body = normalizeBody(input.body);
  if (!body.ok) return fail(body.error);
  if (
    countLiveChannelMessages(messages, input.channelId) >=
    LOCAL_CHANNEL_MESSAGE_MAX_PER_CHANNEL
  ) {
    return fail("quota");
  }
  const compacted = compactGlobalTombstones(
    compactChannelTombstones(messages, input.channelId)
  );
  if (compacted.length >= LOCAL_CHANNEL_MESSAGE_MAX_TOTAL) {
    return fail("quota");
  }

  const message: LocalChannelMessage = {
    id: input.id ?? crypto.randomUUID(),
    channelId: input.channelId,
    body: body.body,
    createdAt: input.now ?? new Date().toISOString(),
    editedAt: null,
    deletedAt: null,
  };
  const nextMessages = [...compacted, message];
  // Exact JSON-array byte delta: replace the closing `]` with an optional
  // comma + one serialized row + `]`. The WeakMap makes steady-state posts
  // O(new-message bytes) after hydration instead of reserializing up to 4 MiB.
  const nextBytes =
    storedMessageBytes(compacted) +
    serializedMessageBytes(message) +
    (compacted.length > 0 ? 1 : 0);
  if (nextBytes > LOCAL_CHANNEL_MESSAGE_STORAGE_BUDGET_BYTES) {
    return fail("quota");
  }
  storedBytesByArray.set(nextMessages, nextBytes);
  return { ok: true, messages: nextMessages, message };
}

export interface EditLocalChannelMessageInput {
  body: string;
  now?: string;
}

/**
 * Edit in place. The author is always the single local user, so there is no
 * ownership check; a tombstone is not editable (its body no longer exists).
 */
export function editLocalChannelMessage(
  messages: readonly LocalChannelMessage[],
  id: string,
  input: EditLocalChannelMessageInput
): LocalChannelMessageResult {
  const current = messages.find((message) => message.id === id);
  if (!current || current.deletedAt !== null) return fail("invalid");
  const body = normalizeBody(input.body);
  if (!body.ok) return fail(body.error);

  const updated: LocalChannelMessage = {
    ...current,
    body: body.body,
    editedAt: input.now ?? new Date().toISOString(),
  };
  const nextMessages = messages.map((message) =>
    message.id === id ? updated : message
  );
  const nextBytes =
    storedMessageBytes(messages) -
    serializedMessageBytes(current) +
    serializedMessageBytes(updated);
  if (nextBytes > LOCAL_CHANNEL_MESSAGE_STORAGE_BUDGET_BYTES) {
    return fail("quota");
  }
  storedBytesByArray.set(nextMessages, nextBytes);
  return {
    ok: true,
    messages: nextMessages,
    message: updated,
  };
}

/**
 * TOMBSTONE delete — the row survives with `deletedAt` stamped so the
 * transcript keeps its slot; `selectLocalChannelMessages` blanks the body at
 * read time (cloud comment-plane parity). Deleting twice is idempotent.
 */
export function deleteLocalChannelMessage(
  messages: readonly LocalChannelMessage[],
  id: string,
  now?: string
): LocalChannelMessageResult {
  const current = messages.find((message) => message.id === id);
  if (!current) return fail("invalid");
  if (current.deletedAt !== null) {
    // Same array identity: the write atom skips its full-store persist for
    // a semantic no-op (registry archive/unarchive got this in this PR too).
    return {
      ok: true,
      messages: messages as LocalChannelMessage[],
      message: current,
    };
  }
  const updated: LocalChannelMessage = {
    ...current,
    body: "",
    deletedAt: now ?? new Date().toISOString(),
  };
  return {
    ok: true,
    messages: messages.map((message) =>
      message.id === id ? updated : message
    ),
    message: updated,
  };
}

/**
 * Drop every row of a channel outright. Deleting a local channel is a HARD
 * delete (`deleteLocalChannel`), so its messages must not linger as orphans
 * that a recreated same-name channel could never reach but storage still pays
 * for. Returns the surviving rows (not a `LocalChannelMessageResult`: there is
 * no single subject message and purging an empty channel is not an error).
 */
export function purgeLocalChannelMessages(
  messages: readonly LocalChannelMessage[],
  channelId: string
): LocalChannelMessage[] {
  return messages.filter((message) => message.channelId !== channelId);
}

/** Drop rows whose owning channel no longer exists in the control plane. */
export function purgeOrphanedLocalChannelMessages(
  messages: readonly LocalChannelMessage[],
  existingChannelIds: ReadonlySet<string>
): LocalChannelMessage[] {
  return messages.filter((message) =>
    existingChannelIds.has(message.channelId)
  );
}

/**
 * One channel's messages, oldest first — the transcript's render order.
 * Tombstoned rows are kept (they render as "message deleted") but their body
 * is blanked here so a stale persisted body can never leak back into the UI.
 */
export function selectLocalChannelMessages(
  messages: readonly LocalChannelMessage[],
  channelId: string
): LocalChannelMessage[] {
  return (
    messages
      .filter((message) => message.channelId === channelId)
      .map((message) =>
        message.deletedAt === null ? message : { ...message, body: "" }
      )
      // Codepoint compare: ISO-8601 strings order lexicographically; locale
      // collation is both slower and locale-dependent for pure timestamps.
      .sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
      )
  );
}

// ---------------------------------------------------------------------------
// Derived read atoms + reducer-wrapping write atoms
// ---------------------------------------------------------------------------

/**
 * Live messages for one channel, ascending by `createdAt`. Keyed per channel
 * so a channel surface only re-renders when ITS rows change.
 */
export const localChannelMessagesForChannelAtomFamily = atomFamily(
  (channelId: string) => {
    const derived = atom((get) =>
      selectLocalChannelMessages(get(localChannelMessagesAtom), channelId)
    );
    derived.debugLabel = `localChannelMessagesForChannelAtom/${channelId}`;
    return derived;
  }
);

export const postLocalChannelMessageAtom = atom(
  null,
  (
    get,
    set,
    input: PostLocalChannelMessageInput
  ): LocalChannelMessageResult => {
    const result = postLocalChannelMessage(
      get(localChannelMessagesAtom),
      input
    );
    if (result.ok) set(localChannelMessagesAtom, result.messages);
    return result;
  }
);
postLocalChannelMessageAtom.debugLabel = "postLocalChannelMessageAtom";

export const editLocalChannelMessageAtom = atom(
  null,
  (
    get,
    set,
    args: { id: string } & EditLocalChannelMessageInput
  ): LocalChannelMessageResult => {
    const { id, ...input } = args;
    const result = editLocalChannelMessage(
      get(localChannelMessagesAtom),
      id,
      input
    );
    if (result.ok) set(localChannelMessagesAtom, result.messages);
    return result;
  }
);
editLocalChannelMessageAtom.debugLabel = "editLocalChannelMessageAtom";

export const deleteLocalChannelMessageAtom = atom(
  null,
  (get, set, id: string): LocalChannelMessageResult => {
    const current = get(localChannelMessagesAtom);
    const result = deleteLocalChannelMessage(current, id);
    if (result.ok && result.messages !== current) {
      set(localChannelMessagesAtom, result.messages);
    }
    return result;
  }
);
deleteLocalChannelMessageAtom.debugLabel = "deleteLocalChannelMessageAtom";

/** Purge one channel's messages — `deleteLocalChannelAtom` composes this. */
export const purgeLocalChannelMessagesAtom = atom(
  null,
  (get, set, channelId: string): LocalChannelMessage[] => {
    const messages = get(localChannelMessagesAtom);
    const remaining = purgeLocalChannelMessages(messages, channelId);
    if (remaining.length !== messages.length) {
      set(localChannelMessagesAtom, remaining);
    }
    localChannelMessagesForChannelAtomFamily.remove(channelId);
    return remaining;
  }
);
purgeLocalChannelMessagesAtom.debugLabel = "purgeLocalChannelMessagesAtom";

/**
 * Boot/rebuild reconciliation. The caller supplies the authoritative local
 * control-plane ids; the message plane is persisted once after the full sweep.
 */
export const purgeOrphanedLocalChannelMessagesAtom = atom(
  null,
  (
    get,
    set,
    existingChannelIds: ReadonlySet<string>
  ): { removed: number; orphanedChannelIds: string[] } => {
    const messages = get(localChannelMessagesAtom);
    const orphanedChannelIds = [
      ...new Set(
        messages
          .filter((message) => !existingChannelIds.has(message.channelId))
          .map((message) => message.channelId)
      ),
    ];
    if (orphanedChannelIds.length === 0) {
      return { removed: 0, orphanedChannelIds };
    }
    const remaining = purgeOrphanedLocalChannelMessages(
      messages,
      existingChannelIds
    );
    set(localChannelMessagesAtom, remaining);
    for (const channelId of orphanedChannelIds) {
      localChannelMessagesForChannelAtomFamily.remove(channelId);
    }
    return {
      removed: messages.length - remaining.length,
      orphanedChannelIds,
    };
  }
);
purgeOrphanedLocalChannelMessagesAtom.debugLabel =
  "purgeOrphanedLocalChannelMessagesAtom";
