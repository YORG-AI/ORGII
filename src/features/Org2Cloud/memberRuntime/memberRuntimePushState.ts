/**
 * Per-(identity, org) member-runtime push bookkeeping, persisted in
 * localStorage via the shared zod-storage idiom (`createZodJsonStorage`):
 * a corrupted or schema-incompatible stored value parses to the EMPTY state
 * (never pushed) instead of crashing the scheduler — the next tick simply
 * re-pushes everything, which the server-side upserts absorb.
 *
 * Keyed `${prefix}:${identityKey}:${orgId}` so an account or endpoint switch
 * can never reuse another identity's fingerprints, mirroring how the collab
 * push cursors are namespaced.
 */
import { z } from "zod/v4";

import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

import { MEMBER_RUNTIME_PUSH_STATE_KEY_PREFIX } from "./types";

const MemberRuntimePushStateSchema = z.object({
  /** Epoch ms of the last SUCCESSFUL push; 0 = never pushed. */
  lastPushAtMs: z.number(),
  /** `${day}|${bucket}` → row-content fingerprint at the last push. */
  usageFingerprint: z.record(z.string(), z.string()),
  profileFingerprint: z.string().nullable(),
  agentsFingerprint: z.string().nullable(),
  /** Epoch ms of the last installed-agent detection probe; 0 = never. */
  lastAgentsDetectAtMs: z.number(),
});

export type MemberRuntimePushState = z.output<
  typeof MemberRuntimePushStateSchema
>;

export function emptyMemberRuntimePushState(): MemberRuntimePushState {
  return {
    lastPushAtMs: 0,
    usageFingerprint: {},
    profileFingerprint: null,
    agentsFingerprint: null,
    lastAgentsDetectAtMs: 0,
  };
}

const pushStateStorage = createZodJsonStorage(MemberRuntimePushStateSchema);

export function memberRuntimePushStateKey(
  identityKey: string,
  orgId: string
): string {
  return `${MEMBER_RUNTIME_PUSH_STATE_KEY_PREFIX}:${identityKey}:${orgId}`;
}

export function readMemberRuntimePushState(
  identityKey: string,
  orgId: string
): MemberRuntimePushState {
  return pushStateStorage.getItem(
    memberRuntimePushStateKey(identityKey, orgId),
    emptyMemberRuntimePushState()
  );
}

export function writeMemberRuntimePushState(
  identityKey: string,
  orgId: string,
  state: MemberRuntimePushState
): void {
  pushStateStorage.setItem(
    memberRuntimePushStateKey(identityKey, orgId),
    state
  );
}
