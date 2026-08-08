/**
 * Merkle-frontier commitments for the imported-history replay checkpoint
 * (`ImportedReplayCheckpoint.frozenHashFrontier`). A frontier stores, for
 * each set bit of the committed event count, the root of one perfect subtree
 * over the frozen per-event hash sequence — O(log n) persisted state that
 * supports O(log n) append while still committing to the entire prefix.
 *
 * Heights whose bit is 0 hold null. `buildMerkleFrontier` leaves them as
 * array holes; every consumer normalizes holes through `[...frontier]`
 * spreads (holes become explicit `undefined`, which `stableStringify`
 * serializes as `null`), and JSON persistence stores them as `null` — the
 * commitment is byte-identical in both forms, which the engine round-trip
 * test pins down.
 */
import {
  sha256Hex,
  stableStringify,
} from "../TeamCollaboration/collabSyncUtils";

/** Hash only a bounded window at once; large CLI histories can be GBs. */
export const EVENT_HASH_CONCURRENCY = 16;

/**
 * Ceiling on persisted frontier heights (2^54 events, far beyond any real
 * transcript while staying inside safe-integer arithmetic). Mirrored by the
 * `CloudPushCursorSchema` zod bound so a corrupt persisted cursor is
 * rejected at load rather than trusted at validation time.
 */
export const MERKLE_FRONTIER_MAX_HEIGHT = 54;

/**
 * Order-preserving hash of a string list. The input is length-delimited via
 * `stableStringify`, so values containing any separator (provider-native
 * turn ids are free-form external strings) cannot collide across element
 * boundaries the way a plain join could.
 */
export async function hashStringList(
  values: readonly string[]
): Promise<string> {
  return sha256Hex(stableStringify(values));
}

function trimMerkleFrontier(
  frontier: Array<string | null>
): Array<string | null> {
  const trimmed = [...frontier];
  // The length guard is load-bearing: `[].at(-1) == null` holds and `pop()`
  // leaves an empty array empty, so without it an all-null frontier — the
  // legitimate commitment of zero frozen events — spins this synchronous
  // loop forever and freezes the renderer.
  while (trimmed.length > 0 && trimmed.at(-1) == null) trimmed.pop();
  return trimmed;
}

/** Batch-build the frontier for a complete hash sequence. */
export async function buildMerkleFrontier(
  eventHashes: readonly string[]
): Promise<Array<string | null>> {
  const frontier: Array<string | null> = [];
  let level = [...eventHashes];
  let height = 0;
  while (level.length > 0) {
    if (level.length % 2 === 1) {
      frontier[height] = level[level.length - 1];
      level = level.slice(0, -1);
    }
    const parents: string[] = [];
    for (
      let start = 0;
      start < level.length;
      start += EVENT_HASH_CONCURRENCY * 2
    ) {
      const batch = level.slice(start, start + EVENT_HASH_CONCURRENCY * 2);
      parents.push(
        ...(await Promise.all(
          Array.from({ length: batch.length / 2 }, (_, index) =>
            hashStringList([batch[index * 2], batch[index * 2 + 1]])
          )
        ))
      );
    }
    level = parents;
    height += 1;
  }
  return trimMerkleFrontier(frontier);
}

/**
 * Extend a frontier that already commits to `currentCount` hashes with new
 * hashes, exactly as binary-counter increments. Must agree with
 * `buildMerkleFrontier` over the concatenated sequence — the property test
 * in `org2CloudMerkleFrontier.test.ts` holds the two constructions equal.
 */
export async function appendMerkleFrontier(
  current: readonly (string | null)[],
  currentCount: number,
  eventHashes: readonly string[]
): Promise<Array<string | null>> {
  const frontier = [...current];
  let count = currentCount;
  for (const eventHash of eventHashes) {
    let node = eventHash;
    let height = 0;
    while (Math.floor(count / 2 ** height) % 2 === 1) {
      const left = frontier[height];
      if (!left) throw new Error("Invalid imported replay Merkle frontier");
      node = await hashStringList([left, node]);
      frontier[height] = null;
      height += 1;
    }
    frontier[height] = node;
    count += 1;
  }
  return trimMerkleFrontier(frontier);
}

/** The persisted O(1) commitment: frontier plus its exact event count. */
export async function merkleFrontierCommitment(
  frontier: readonly (string | null)[],
  eventCount: number
): Promise<string> {
  return sha256Hex(
    stableStringify({ eventCount, frontier: trimMerkleFrontier([...frontier]) })
  );
}

/** Structural check: node presence must match the count's binary digits. */
export function isValidMerkleFrontier(
  frontier: readonly (string | null)[],
  eventCount: number
): boolean {
  if (
    !Number.isSafeInteger(eventCount) ||
    eventCount < 0 ||
    frontier.length > MERKLE_FRONTIER_MAX_HEIGHT
  ) {
    return false;
  }
  let remaining = eventCount;
  for (const node of frontier) {
    if (Boolean(node) !== (remaining % 2 === 1)) return false;
    remaining = Math.floor(remaining / 2);
  }
  return remaining === 0;
}
