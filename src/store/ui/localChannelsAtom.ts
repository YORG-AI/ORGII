/**
 * Local (non-cloud) org channels — the single-user counterpart of the 0014
 * cloud control plane, persisted on this machine only.
 *
 * The pure reducers below enforce the SAME rules as `cloud_create_channel` /
 * `cloud_update_channel` so a later migration to a cloud org cannot hit
 * server-side validation the local UI never surfaced: names normalized via
 * `normalizeChannelName`, 1..80 chars, case-insensitive uniqueness across
 * active AND archived channels (archived names stay reserved), at most
 * `CHANNEL_MAX_ACTIVE_PER_SCOPE` active channels, topics ≤ 250 chars, archive
 * is soft (`archivedAt`), delete is hard removal.
 *
 * Persistence uses the zod-validated localStorage idiom
 * (`org2CloudAuthAtom` precedent): garbage bytes parse to the initial empty
 * list instead of crashing hydration, and a single malformed row degrades
 * just that row (per-row `safeParse`, mirroring the cloud listing schema's
 * per-field `.catch`).
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod/v4";

import {
  CHANNEL_MAX_ACTIVE_PER_SCOPE,
  CHANNEL_TOPIC_MAX_LENGTH,
  normalizeChannelName,
  validateChannelName,
} from "@src/features/DiscussionChannels/channelContract";
import { createLogger } from "@src/hooks/logger";
import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

import {
  purgeLocalChannelMessagesAtom,
  purgeOrphanedLocalChannelMessagesAtom,
} from "./localChannelMessagesAtom";

const log = createLogger("localChannels");

/** Colon-style key (codebase convention); the dot-style original is adopted below. */
export const LOCAL_CHANNELS_STORAGE_KEY = "orgii:localChannels:v1";
const LEGACY_LOCAL_CHANNELS_STORAGE_KEY = "orgii.localChannels.v1";

// One-time adoption of the briefly-shipped dot-style key — no data loss for
// anyone who created channels on an early develop build.
try {
  if (typeof localStorage !== "undefined") {
    const legacy = localStorage.getItem(LEGACY_LOCAL_CHANNELS_STORAGE_KEY);
    if (legacy !== null) {
      if (localStorage.getItem(LOCAL_CHANNELS_STORAGE_KEY) === null) {
        localStorage.setItem(LOCAL_CHANNELS_STORAGE_KEY, legacy);
      }
      localStorage.removeItem(LEGACY_LOCAL_CHANNELS_STORAGE_KEY);
    }
  }
} catch {
  // Storage unavailable — nothing to migrate.
}

/** Same bound as the cloud backend's per-org active-channel quota. */
export const LOCAL_CHANNEL_MAX_ACTIVE = CHANNEL_MAX_ACTIVE_PER_SCOPE;

/** Bounds archived + active rows retained by this device. */
export const LOCAL_CHANNEL_MAX_STORED = 1_000;

export const LocalChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  topic: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});

export type LocalChannel = z.output<typeof LocalChannelSchema>;

/** Tolerant list schema: drop malformed rows (logged), keep the rest. */
const StoredLocalChannelsSchema: z.ZodType<LocalChannel[]> = z
  .array(z.unknown())
  .transform((rows) =>
    rows.flatMap((row) => {
      const parsed = LocalChannelSchema.safeParse(row);
      if (!parsed.success) {
        // A silent per-row drop becomes permanent on the next whole-list
        // write; leave a trace so a schema change that sheds user data is
        // diagnosable instead of invisible.
        log.warn("dropped malformed stored row", row);
        return [];
      }
      return [parsed.data];
    })
  );

/**
 * True when the stored registry payload failed to parse and hydrated to [].
 * The orphan sweep must NOT treat that empty set as authoritative: purging
 * against it would permanently delete every channel's messages because of
 * one corrupt/unreadable REGISTRY read, while the messages key itself was
 * intact.
 */
let localChannelRegistryHydrationDegraded = false;

export function isLocalChannelRegistryHydrationDegraded(): boolean {
  return localChannelRegistryHydrationDegraded;
}

export const __LOCAL_CHANNELS_TEST_INTERNALS = {
  setRegistryHydrationDegraded(value: boolean): void {
    localChannelRegistryHydrationDegraded = value;
  },
};

export const localChannelsAtom = atomWithStorage<LocalChannel[]>(
  LOCAL_CHANNELS_STORAGE_KEY,
  [],
  createZodJsonStorage(StoredLocalChannelsSchema, {
    onInvalid: (key, _rawValue, error) => {
      localChannelRegistryHydrationDegraded = true;
      log.warn(`invalid stored payload for ${key}`, error);
    },
  }),
  { getOnInit: true }
);
localChannelsAtom.debugLabel = "localChannelsAtom";

// ---------------------------------------------------------------------------
// Pure reducers
// ---------------------------------------------------------------------------

export type LocalChannelErrorCode = "nameTaken" | "quota" | "invalid";

export type LocalChannelResult =
  | { ok: true; channels: LocalChannel[]; channel: LocalChannel }
  | { ok: false; error: LocalChannelErrorCode };

function fail(error: LocalChannelErrorCode): LocalChannelResult {
  return { ok: false, error };
}

/**
 * Names are stored normalized (lowercase), but compare case-folded anyway so
 * a hand-edited stored value can never open a duplicate-name loophole.
 * Archived channels count: their names stay reserved (cloud 0014 semantics).
 */
function isNameTaken(
  channels: readonly LocalChannel[],
  name: string,
  excludeId?: string
): boolean {
  const folded = name.toLowerCase();
  return channels.some(
    (channel) =>
      channel.id !== excludeId && channel.name.toLowerCase() === folded
  );
}

function countActive(channels: readonly LocalChannel[]): number {
  return channels.reduce(
    (count, channel) => (channel.archivedAt === null ? count + 1 : count),
    0
  );
}

/** `""`/whitespace → undefined (no topic); over-long topics are rejected. */
function normalizeTopic(
  raw: string | undefined
): { ok: true; topic: string | undefined } | { ok: false } {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) return { ok: true, topic: undefined };
  if (trimmed.length > CHANNEL_TOPIC_MAX_LENGTH) return { ok: false };
  return { ok: true, topic: trimmed };
}

export interface CreateLocalChannelInput {
  name: string;
  topic?: string;
  /** Injectable for tests; defaults to `crypto.randomUUID()`. */
  id?: string;
  /** Injectable for tests; defaults to `new Date().toISOString()`. */
  now?: string;
}

export function createLocalChannel(
  channels: readonly LocalChannel[],
  input: CreateLocalChannelInput
): LocalChannelResult {
  const name = normalizeChannelName(input.name);
  if (validateChannelName(name) !== null) return fail("invalid");
  const topic = normalizeTopic(input.topic);
  if (!topic.ok) return fail("invalid");
  if (isNameTaken(channels, name)) return fail("nameTaken");
  if (
    channels.length >= LOCAL_CHANNEL_MAX_STORED ||
    countActive(channels) >= LOCAL_CHANNEL_MAX_ACTIVE
  ) {
    return fail("quota");
  }

  const now = input.now ?? new Date().toISOString();
  const channel: LocalChannel = {
    id: input.id ?? crypto.randomUUID(),
    name,
    topic: topic.topic,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  return { ok: true, channels: [...channels, channel], channel };
}

export interface UpdateLocalChannelInput {
  /** Omitted = unchanged. */
  name?: string;
  /** Omitted = unchanged; empty string clears (0014 update contract). */
  topic?: string;
  now?: string;
}

export function updateLocalChannel(
  channels: readonly LocalChannel[],
  id: string,
  input: UpdateLocalChannelInput
): LocalChannelResult {
  const current = channels.find((channel) => channel.id === id);
  if (!current) return fail("invalid");

  let name = current.name;
  if (input.name !== undefined) {
    name = normalizeChannelName(input.name);
    if (validateChannelName(name) !== null) return fail("invalid");
    if (isNameTaken(channels, name, id)) return fail("nameTaken");
  }

  let topic = current.topic;
  if (input.topic !== undefined) {
    const normalized = normalizeTopic(input.topic);
    if (!normalized.ok) return fail("invalid");
    topic = normalized.topic;
  }

  const updated: LocalChannel = {
    ...current,
    name,
    topic,
    updatedAt: input.now ?? new Date().toISOString(),
  };
  return {
    ok: true,
    channels: channels.map((channel) =>
      channel.id === id ? updated : channel
    ),
    channel: updated,
  };
}

/** Soft archive: the row is kept and its name stays reserved. */
export function archiveLocalChannel(
  channels: readonly LocalChannel[],
  id: string,
  now?: string
): LocalChannelResult {
  const current = channels.find((channel) => channel.id === id);
  if (!current) return fail("invalid");
  if (current.archivedAt !== null) {
    // Idempotent no-op keeps the input identity so write atoms can skip the
    // redundant persist + subscriber notification.
    return { ok: true, channels: channels as LocalChannel[], channel: current };
  }
  const stamp = now ?? new Date().toISOString();
  const updated: LocalChannel = {
    ...current,
    archivedAt: stamp,
    updatedAt: stamp,
  };
  return {
    ok: true,
    channels: channels.map((channel) =>
      channel.id === id ? updated : channel
    ),
    channel: updated,
  };
}

/** Unarchive re-enters the active quota, so it re-checks the cap. */
export function unarchiveLocalChannel(
  channels: readonly LocalChannel[],
  id: string,
  now?: string
): LocalChannelResult {
  const current = channels.find((channel) => channel.id === id);
  if (!current) return fail("invalid");
  if (current.archivedAt === null) {
    // Idempotent no-op — same identity contract as archiveLocalChannel.
    return { ok: true, channels: channels as LocalChannel[], channel: current };
  }
  if (countActive(channels) >= LOCAL_CHANNEL_MAX_ACTIVE) return fail("quota");
  const updated: LocalChannel = {
    ...current,
    archivedAt: null,
    updatedAt: now ?? new Date().toISOString(),
  };
  return {
    ok: true,
    channels: channels.map((channel) =>
      channel.id === id ? updated : channel
    ),
    channel: updated,
  };
}

/** HARD delete — the row is removed outright (cloud admin-delete parity). */
export function deleteLocalChannel(
  channels: readonly LocalChannel[],
  id: string
): LocalChannelResult {
  const current = channels.find((channel) => channel.id === id);
  if (!current) return fail("invalid");
  return {
    ok: true,
    channels: channels.filter((channel) => channel.id !== id),
    channel: current,
  };
}

// ---------------------------------------------------------------------------
// Derived read atoms + reducer-wrapping write atoms
// ---------------------------------------------------------------------------

function sortByName(channels: LocalChannel[]): LocalChannel[] {
  return channels.sort((a, b) => a.name.localeCompare(b.name));
}

/** Non-archived channels, alphabetical (the cloud listing's server sort). */
export const activeLocalChannelsAtom = atom((get) =>
  sortByName(
    get(localChannelsAtom).filter((channel) => channel.archivedAt === null)
  )
);
activeLocalChannelsAtom.debugLabel = "activeLocalChannelsAtom";

export const archivedLocalChannelsAtom = atom((get) =>
  sortByName(
    get(localChannelsAtom).filter((channel) => channel.archivedAt !== null)
  )
);
archivedLocalChannelsAtom.debugLabel = "archivedLocalChannelsAtom";

export const createLocalChannelAtom = atom(
  null,
  (get, set, input: CreateLocalChannelInput): LocalChannelResult => {
    const result = createLocalChannel(get(localChannelsAtom), input);
    if (result.ok) set(localChannelsAtom, result.channels);
    return result;
  }
);
createLocalChannelAtom.debugLabel = "createLocalChannelAtom";

export const updateLocalChannelAtom = atom(
  null,
  (
    get,
    set,
    args: { id: string } & UpdateLocalChannelInput
  ): LocalChannelResult => {
    const { id, ...input } = args;
    const result = updateLocalChannel(get(localChannelsAtom), id, input);
    if (result.ok) set(localChannelsAtom, result.channels);
    return result;
  }
);
updateLocalChannelAtom.debugLabel = "updateLocalChannelAtom";

export const archiveLocalChannelAtom = atom(
  null,
  (get, set, id: string): LocalChannelResult => {
    const current = get(localChannelsAtom);
    const result = archiveLocalChannel(current, id);
    if (result.ok && result.channels !== current) {
      set(localChannelsAtom, result.channels);
    }
    return result;
  }
);
archiveLocalChannelAtom.debugLabel = "archiveLocalChannelAtom";

export const unarchiveLocalChannelAtom = atom(
  null,
  (get, set, id: string): LocalChannelResult => {
    const current = get(localChannelsAtom);
    const result = unarchiveLocalChannel(current, id);
    if (result.ok && result.channels !== current) {
      set(localChannelsAtom, result.channels);
    }
    return result;
  }
);
unarchiveLocalChannelAtom.debugLabel = "unarchiveLocalChannelAtom";

/**
 * Hard-delete the channel AND purge its message plane. The purge lives here
 * rather than in the delete dialog so every delete path (dialog today, row
 * action or bulk cleanup tomorrow) drops the messages too — an orphaned row
 * set is unreachable through the UI but still costs storage forever. Both
 * reducers stay pure; only this write atom knows about the two slices.
 */
export const deleteLocalChannelAtom = atom(
  null,
  (get, set, id: string): LocalChannelResult => {
    const result = deleteLocalChannel(get(localChannelsAtom), id);
    if (!result.ok) return result;
    set(localChannelsAtom, result.channels);
    // Compose the message-plane purge atom instead of duplicating its body —
    // one purge implementation, every delete path included.
    set(purgeLocalChannelMessagesAtom, id);
    return result;
  }
);
deleteLocalChannelAtom.debugLabel = "deleteLocalChannelAtom";

/**
 * Reconcile the message plane from the authoritative local channel registry.
 * Mounted once by the sidebar coordinator at app startup.
 */
export const reconcileLocalChannelMessagesAtom = atom(null, (get, set) => {
  if (localChannelRegistryHydrationDegraded) {
    log.warn("skipping orphan sweep: registry hydration was degraded");
    return { removed: 0, orphanedChannelIds: [] as string[] };
  }
  return set(
    purgeOrphanedLocalChannelMessagesAtom,
    new Set(get(localChannelsAtom).map((channel) => channel.id))
  );
});
reconcileLocalChannelMessagesAtom.debugLabel =
  "reconcileLocalChannelMessagesAtom";
