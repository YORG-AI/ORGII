/**
 * Thin React shell for `Org2CloudSyncEngine`: idempotent start, deliberately
 * NOT stopped on
 * unmount (the engine outlives React tree churn; mounted once in the router
 * root next to `useOrg2CloudOrgs`).
 */
import { useEffect } from "react";

import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { org2CloudSyncEngine } from "./org2CloudSyncEngine";

export function useOrg2CloudSyncEngine(): void {
  useEffect(() => {
    org2CloudSyncEngine.start(getInstrumentedStore());
    return undefined;
  }, []);
}
