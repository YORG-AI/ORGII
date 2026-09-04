import React from "react";

import { useCloudOrgRemoteSessions } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";

function OrgRemoteSessionSubscription({ orgId }: { orgId: string }) {
  useCloudOrgRemoteSessions(orgId);
  return null;
}

/** Keeps every accessible org's remote session cache warm via the desktop atom. */
export function WebOrgRemoteSessionSubscriptions({
  orgIds,
}: {
  orgIds: readonly string[];
}) {
  return (
    <>
      {orgIds.map((orgId) => (
        <OrgRemoteSessionSubscription key={orgId} orgId={orgId} />
      ))}
    </>
  );
}
