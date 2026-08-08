/**
 * Per-session cloud sync access ladder (design §13.4) — the managed-cloud
 * mirror of the self-hosted access model (`collabSyncUtils`:
 * createDefaultAccessSettings / getEffectiveAccessMode /
 * getSessionVisibility).
 *
 * Model, per cloud org:
 * - the server-backed org sharing floor is the ONE org-wide policy;
 * - `sessionModes` stores explicit per-session choices. With no override the
 *   local mode is Off, then the org floor raises it as required;
 * - `sessionVisibility` — per-session 'org' | 'restricted'; only explicit
 *   'restricted' entries are stored ('org' is the wire default).
 *
 * Older persisted objects may still contain `defaultMode`; Zod strips that
 * unknown key while parsing, so upgraded devices cannot retain a hidden
 * second org-wide policy.
 *
 * RATCHET GUARANTEE (0010 review finding): all three pieces persist in
 * localStorage (zod-validated, same idiom as org2CloudSyncAtoms) and the
 * engine re-reads them on EVERY push via `resolveCloudPushAccess` — an
 * automated metadata re-push can therefore never rebuild "from defaults"
 * and silently flip a restricted/metadata_only session back to
 * org/full_replay.
 *
 * Wire mapping: the stored values ARE the wire strings the 0010 server
 * persists ('metadata_only' | 'full_replay' for access_mode, 'org' |
 * 'restricted' for visibility). 'off' NEVER reaches the server — the engine
 * skips off sessions entirely (`resolveCloudPushAccess` returns null), and
 * a TAGGED (move-to-org) session whose effective mode is 'off' is floored
 * to 'metadata_only' so the explicit move is not silently dropped.
 */
import { atomWithStorage } from "jotai/utils";
import { z } from "zod/v4";

import {
  COLLAB_SESSION_ACCESS_MODE,
  COLLAB_SESSION_VISIBILITY,
} from "@src/store/collaboration/types";
import type {
  CollabSessionAccessMode,
  CollabSessionVisibility,
} from "@src/store/collaboration/types";
import {
  createZodJsonStorage,
  tolerantRecordSchema,
} from "@src/util/core/storage/zodStorage";

const CloudAccessModeSchema = z.enum([
  COLLAB_SESSION_ACCESS_MODE.OFF,
  COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
  COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
]) satisfies z.ZodType<CollabSessionAccessMode>;

const CloudVisibilitySchema = z.enum([
  COLLAB_SESSION_VISIBILITY.ORG,
  COLLAB_SESSION_VISIBILITY.RESTRICTED,
]) satisfies z.ZodType<CollabSessionVisibility>;

/**
 * Tolerant at every record level. This store is the privacy ratchet: a
 * whole-store reset drops every explicit per-session override, and on the
 * next pass previously shared sessions resolve effective-off and get their
 * cloud rows RETRACTED — one corrupted byte silently unsharing the user's
 * work. A corrupted entry must cost exactly that entry, never the store.
 */
const CloudOrgAccessSettingsSchema = z.object({
  sessionModes: tolerantRecordSchema(
    "session access mode",
    CloudAccessModeSchema
  ),
  sessionVisibility: tolerantRecordSchema(
    "session visibility",
    CloudVisibilitySchema
  ),
});

export type CloudOrgAccessSettings = z.output<
  typeof CloudOrgAccessSettingsSchema
>;

export const CloudAccessSettingsByOrgSchema = tolerantRecordSchema(
  "access-settings org",
  CloudOrgAccessSettingsSchema
);

export type CloudAccessSettingsByOrg = z.output<
  typeof CloudAccessSettingsByOrgSchema
>;

/** Cloud orgId → access-ladder settings (absent org ⇒ defaults: OFF). */
export const org2CloudAccessSettingsAtom =
  atomWithStorage<CloudAccessSettingsByOrg>(
    "orgii:org2-cloud-v1:accessSettings",
    {},
    createZodJsonStorage(CloudAccessSettingsByOrgSchema),
    { getOnInit: true }
  );
org2CloudAccessSettingsAtom.debugLabel = "org2CloudAccessSettingsAtom";

// ============================================================================
// Org sharing FLOOR (admin policy mirror, 0002)
// ============================================================================

const CloudSharingFloorByOrgSchema = tolerantRecordSchema(
  "sharing floor",
  CloudAccessModeSchema
);

export type CloudSharingFloorByOrg = z.output<
  typeof CloudSharingFloorByOrgSchema
>;

/**
 * Cloud orgId → admin-set sharing FLOOR (the minimum access mode a member may
 * share at). A LOCAL MIRROR of the server truth, hydrated from
 * `get_entitlement_state` (`orgSharingFloor`) whenever the org panel / sync
 * dialog reads entitlement; an absent org ⇒ 'off' (no floor). The push engine
 * re-reads this every pass so a raised floor takes effect next pass without a
 * restart, and the dialog/panel hide sub-floor options. The SERVER
 * independently enforces the floor at `cloud_upsert_session_metadata` — this
 * mirror only drives client UX and avoids emitting a push the server would
 * lift anyway, so a stale/absent mirror is safe (server is authoritative).
 */
export const org2CloudSharingFloorAtom =
  atomWithStorage<CloudSharingFloorByOrg>(
    "orgii:org2-cloud-v1:sharingFloor",
    {},
    createZodJsonStorage(CloudSharingFloorByOrgSchema),
    { getOnInit: true }
  );
org2CloudSharingFloorAtom.debugLabel = "org2CloudSharingFloorAtom";

/** The org's floor, defaulting to OFF (no floor) for an unknown org. */
export function getOrgSharingFloor(
  byOrg: CloudSharingFloorByOrg,
  orgId: string
): CollabSessionAccessMode {
  return byOrg[orgId] ?? COLLAB_SESSION_ACCESS_MODE.OFF;
}

/** off < metadata_only < full_replay — the sharing-level ladder rank. */
const ACCESS_MODE_RANK: Record<CollabSessionAccessMode, number> = {
  [COLLAB_SESSION_ACCESS_MODE.OFF]: 0,
  [COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY]: 1,
  [COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY]: 2,
};

/** True when `mode` sits at or above `floor` on the sharing ladder. */
export function isAccessModeAtLeast(
  mode: CollabSessionAccessMode,
  floor: CollabSessionAccessMode
): boolean {
  return ACCESS_MODE_RANK[mode] >= ACCESS_MODE_RANK[floor];
}

/** Raise `mode` up to `floor` (no-op when already at/above it, or no floor). */
export function floorAccessMode(
  mode: CollabSessionAccessMode,
  floor: CollabSessionAccessMode | undefined
): CollabSessionAccessMode {
  if (!floor) return mode;
  return ACCESS_MODE_RANK[mode] >= ACCESS_MODE_RANK[floor] ? mode : floor;
}

/** Privacy-first local state: the server-backed minimum is applied later. */
export function createDefaultCloudOrgAccessSettings(): CloudOrgAccessSettings {
  return {
    sessionModes: {},
    sessionVisibility: {},
  };
}

export function getCloudOrgAccessSettings(
  byOrg: CloudAccessSettingsByOrg,
  orgId: string
): CloudOrgAccessSettings {
  return byOrg[orgId] ?? createDefaultCloudOrgAccessSettings();
}

/** Explicit per-session override, otherwise Off before the org floor. */
export function getEffectiveCloudAccessMode(
  settings: CloudOrgAccessSettings | undefined,
  sessionId: string
): CollabSessionAccessMode {
  return settings?.sessionModes[sessionId] ?? COLLAB_SESSION_ACCESS_MODE.OFF;
}

export function getCloudSessionVisibility(
  settings: CloudOrgAccessSettings | undefined,
  sessionId: string
): CollabSessionVisibility {
  return (
    settings?.sessionVisibility[sessionId] ?? COLLAB_SESSION_VISIBILITY.ORG
  );
}

/**
 * An explicit per-session sharing override (metadata_only/full_replay) set in
 * CloudSyncLevelDialog is the same "share THIS session to org X" intent as an
 * explicit tag. The engine's org-ownership gate accepts it so the dialog's
 * choice is never silently dropped for a session that is neither org-owned
 * nor tagged. An explicit OFF override is NOT intent — it must keep the
 * retract semantics of the ownership gate.
 */
export function hasExplicitCloudShareIntent(
  settings: CloudOrgAccessSettings | undefined,
  sessionId: string
): boolean {
  const mode = settings?.sessionModes[sessionId];
  return mode !== undefined && mode !== COLLAB_SESSION_ACCESS_MODE.OFF;
}

/** What one push pass sends for one session (never 'off' on the wire). */
export interface CloudPushAccess {
  accessMode:
    | typeof COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY
    | typeof COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY;
  visibility: CollabSessionVisibility;
}

/**
 * THE push gate (engine, every pass — the ratchet reads persisted state
 * here, never a cached copy):
 * - effective mode 'off' and NOT tagged → null: the session is a candidate
 *   (repo-scope matched) but is never uploaded;
 * - effective mode 'off' but TAGGED → floored to 'metadata_only': an
 *   explicit "move to org" must not be silently dropped by the privacy
 *   default, but it also must not leak replay events the ladder never
 *   granted;
 * - otherwise the effective mode + persisted visibility go on the wire.
 *
 * ORG SHARING FLOOR (admin policy, 0002): the member's effective mode is
 * FIRST raised to at least `floor` (`floorAccessMode`). So a floor of
 * 'metadata_only' turns an effective-off candidate into a metadata_only push
 * (the member can no longer go dark on the org's repos), and a floor of
 * 'full_replay' lifts a metadata_only session to full replay. A floor of
 * 'off' / undefined is a no-op. The server backstops this at push time.
 *
 * CALLER CONTRACT: pass `floor` only for ADMITTED sessions (org-owned,
 * tagged, fork-provenance, explicit per-session intent, or imported local CLI
 * history whose checkout matches an admin-configured repo scope). Ordinary
 * Personal sessions are not admitted by scope alone. Imported histories are:
 * the org sidebar already includes them automatically, so the effective admin
 * policy shown in Settings must drive the same upload behavior.
 */
export function resolveCloudPushAccess(
  settings: CloudOrgAccessSettings | undefined,
  sessionId: string,
  tagged: boolean,
  floor?: CollabSessionAccessMode
): CloudPushAccess | null {
  const mode = floorAccessMode(
    getEffectiveCloudAccessMode(settings, sessionId),
    floor
  );
  const visibility = getCloudSessionVisibility(settings, sessionId);
  if (mode === COLLAB_SESSION_ACCESS_MODE.OFF) {
    if (!tagged) return null;
    return {
      accessMode: COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
      visibility,
    };
  }
  return { accessMode: mode, visibility };
}

// ============================================================================
// Immutable update helpers (panel select / per-session dialog)
// ============================================================================

/** `mode: null` clears the override (session follows the org minimum). */
export function withCloudSessionMode(
  byOrg: CloudAccessSettingsByOrg,
  orgId: string,
  sessionId: string,
  mode: CollabSessionAccessMode | null
): CloudAccessSettingsByOrg {
  const current = getCloudOrgAccessSettings(byOrg, orgId);
  const sessionModes = { ...current.sessionModes };
  if (mode === null) {
    if (!(sessionId in sessionModes)) return byOrg;
    delete sessionModes[sessionId];
  } else {
    if (sessionModes[sessionId] === mode) return byOrg;
    sessionModes[sessionId] = mode;
  }
  return { ...byOrg, [orgId]: { ...current, sessionModes } };
}

/** Only explicit 'restricted' entries are stored; 'org' clears the entry. */
export function withCloudSessionVisibility(
  byOrg: CloudAccessSettingsByOrg,
  orgId: string,
  sessionId: string,
  visibility: CollabSessionVisibility
): CloudAccessSettingsByOrg {
  const current = getCloudOrgAccessSettings(byOrg, orgId);
  const sessionVisibility = { ...current.sessionVisibility };
  if (visibility === COLLAB_SESSION_VISIBILITY.ORG) {
    if (!(sessionId in sessionVisibility)) return byOrg;
    delete sessionVisibility[sessionId];
  } else {
    if (sessionVisibility[sessionId] === visibility) return byOrg;
    sessionVisibility[sessionId] = visibility;
  }
  return { ...byOrg, [orgId]: { ...current, sessionVisibility } };
}
