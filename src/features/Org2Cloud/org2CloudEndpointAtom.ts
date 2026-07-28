/**
 * Custom-backend endpoint override + endpoint-switch reset (cloud-parity
 * Phase C, "bring your own server").
 *
 * The override atom persists `{webOrigin, supabaseUrl, anonKey}` (or `null`
 * for the official endpoint) under the SAME localStorage key + zod schema
 * that `getCloudEndpoint()` reads directly, so a write here is visible to
 * every raw-fetch client on its next request — no reload, no store plumbing.
 *
 * Switching endpoints REQUIRES a sign-out: the auth tokens, org list, repo
 * scopes, and push/delta cursors all describe state on the OLD backend.
 * `resetCloudStateForEndpointSwitch` wipes them in one shot; the Settings
 * card calls it on every apply/reset. Deliberately NOT wiped:
 * - `org2CloudAccessSettingsAtom` — the per-org privacy ladder is a ratchet
 *   of user intent; org ids are uuids, so stale entries can never collide
 *   with orgs on the new backend (and re-apply if the user switches back).
 * - `sessionOrgTagsAtom` cloud tags — same uuid-keyed no-collision argument;
 *   the push loop only targets orgs present in `org2CloudOrgsAtom`.
 */
import type { createStore } from "jotai";
import { atomWithStorage } from "jotai/utils";

import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

import {
  ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY,
  Org2CloudEndpointOverrideSchema,
} from "./config";
import type { Org2CloudEndpointOverride } from "./config";
import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { resetOrgEntitlementCoordinator } from "./org2CloudEntitlementCoordinator";
import {
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
} from "./org2CloudOrgsAtom";
import { org2CloudRemoteSessionsAtom } from "./org2CloudRemoteSessionsAtom";
import { org2CloudSessionCommentsAtom } from "./org2CloudSessionCommentsAtom";
import {
  org2CloudCollabStateCursorsAtom,
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
  org2CloudRepoScopesAtom,
  org2CloudSyncEnabledAtom,
} from "./org2CloudSyncAtoms";

const StoredOverrideSchema = Org2CloudEndpointOverrideSchema.nullable();

/** `null` = official managed endpoint (the default). */
export const org2CloudEndpointOverrideAtom =
  atomWithStorage<Org2CloudEndpointOverride | null>(
    ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY,
    null,
    createZodJsonStorage(StoredOverrideSchema),
    { getOnInit: true }
  );
org2CloudEndpointOverrideAtom.debugLabel = "org2CloudEndpointOverrideAtom";

type JotaiStore = ReturnType<typeof createStore>;

/**
 * Sign out and drop every piece of backend-coupled cloud state. MUST run on
 * every endpoint switch (custom apply AND reset-to-official) — tokens are
 * only valid against the issuing GoTrue, and orgs/scopes/cursors describe
 * rows that exist only on the old backend (a cursor replayed against a
 * different server would silently skip or double-apply deltas).
 */
export function resetCloudStateForEndpointSwitch(store: JotaiStore): void {
  resetOrgEntitlementCoordinator(store);
  store.set(org2CloudAuthAtom, null);
  store.set(org2CloudOrgsAtom, []);
  store.set(org2CloudOrgsLoadedAtom, false);
  store.set(org2CloudRepoScopesAtom, {});
  store.set(org2CloudSyncEnabledAtom, {});
  store.set(org2CloudPushCursorsAtom, {});
  // The pushed-metadata marker is server history ("a live metadata row
  // exists on THIS backend"); carried across a switch it can trigger an
  // erroneous retract against the new backend. Wipe-set must stay equal to
  // the roster-reconcile prune-set.
  store.set(org2CloudPushedMetadataAtom, {});
  store.set(org2CloudCollabStateCursorsAtom, {});
  store.set(org2CloudSessionCommentsAtom, {});
  store.set(org2CloudRemoteSessionsAtom, {});
}
