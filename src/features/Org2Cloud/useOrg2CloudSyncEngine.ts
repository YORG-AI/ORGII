/**
 * Thin React shell for `Org2CloudSyncEngine`, keyed to the signed-in cloud
 * identity. Deliberately NOT stopped on unmount (the engine outlives React
 * tree churn; mounted once in the router root next to `useOrg2CloudOrgs`),
 * but it IS restarted across identity boundaries:
 *
 *  - signed out → engine stopped: no cloud event listeners remain and every
 *    per-identity Map (session push hashes,
 *    activity stamps, hydrate/backoff/full-listing memory) is cleared.
 *  - account/endpoint switch → stop + start: the fresh start's first pass
 *    re-lists collab state under the new identity instead of trusting
 *    another account's in-memory cursors for the same org ids.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";

import { externalHistoryBackgroundScanEnabledAtom } from "@src/store/session/dataSourceConfigAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { isMainAppWindow } from "@src/util/platform/tauri/windowIdentity";

import { memberRuntimePushScheduler } from "./memberRuntime/memberRuntimePushScheduler";
import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";
import {
  isOrgBackgroundUploadEnabled,
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
} from "./org2CloudOrgsAtom";
import type { Org2CloudOrg } from "./org2CloudOrgsAtom";
import { org2CloudSyncEngine } from "./org2CloudSyncEngine";

/**
 * Stable lifecycle key for org properties that change session-sync
 * eligibility. In particular, an admin toggling background upload must
 * schedule a pass even when membership, role, and name are unchanged.
 */
export function buildOrg2CloudSyncRosterKey(
  orgs: readonly Org2CloudOrg[]
): string {
  return JSON.stringify(
    orgs
      .map((org) => ({
        orgId: org.orgId,
        role: org.role,
        name: org.name,
        backgroundUploadEnabled: isOrgBackgroundUploadEnabled(org),
      }))
      .sort((left, right) => left.orgId.localeCompare(right.orgId))
  );
}

export function shouldEnableExternalHistoryBackgroundScan(
  authIdentityKey: string | null,
  orgsLoaded: boolean,
  orgs: readonly Org2CloudOrg[]
): boolean {
  return Boolean(
    authIdentityKey && orgsLoaded && orgs.some(isOrgBackgroundUploadEnabled)
  );
}

export function useOrg2CloudSyncEngine(): void {
  const auth = useAtomValue(org2CloudAuthAtom);
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const orgs = useAtomValue(org2CloudOrgsAtom);
  const orgsLoaded = useAtomValue(org2CloudOrgsLoadedAtom);
  const setExternalHistoryBackgroundScanEnabled = useSetAtom(
    externalHistoryBackgroundScanEnabledAtom
  );
  const rosterKey = buildOrg2CloudSyncRosterKey(orgs);
  const externalHistoryBackgroundScanEnabled =
    shouldEnableExternalHistoryBackgroundScan(
      authIdentityKey,
      orgsLoaded,
      orgs
    );

  // Main-window-only: every OS window runs this same hook stack, but the
  // push engine listens to the app-wide `orgii-data-changed` broadcast and
  // its pass guard is per-instance — two windows pushing the same segment
  // range trigger epoch-rewrite re-anchors (see CloudPushCursorsSchema). The
  // main window's webview is never destroyed while the app runs, so it is
  // the single stable owner.
  useEffect(() => {
    if (!isMainAppWindow()) return undefined;
    setExternalHistoryBackgroundScanEnabled(
      externalHistoryBackgroundScanEnabled
    );
    return () => setExternalHistoryBackgroundScanEnabled(false);
  }, [
    externalHistoryBackgroundScanEnabled,
    setExternalHistoryBackgroundScanEnabled,
  ]);

  useEffect(() => {
    if (!isMainAppWindow()) return undefined;
    // stop() is idempotent and also covers the A→B switch (no null between):
    // the old identity's engine state must never survive into the new one.
    // The member-runtime push scheduler shares the exact same identity
    // lifecycle (its persisted push state is keyed per identity; its
    // in-memory backoff/disabled verdicts must not cross identities), but
    // stays a separate module — the engine deliberately has no periodic
    // passes.
    org2CloudSyncEngine.stop();
    memberRuntimePushScheduler.stop();
    if (authIdentityKey) {
      org2CloudSyncEngine.start(getInstrumentedStore());
      memberRuntimePushScheduler.start(getInstrumentedStore());
    }
    return undefined;
  }, [authIdentityKey]);

  useEffect(() => {
    if (!isMainAppWindow() || !authIdentityKey || !orgsLoaded) return;
    org2CloudSyncEngine.reconcileRoster();
  }, [authIdentityKey, orgsLoaded, rosterKey]);
}
