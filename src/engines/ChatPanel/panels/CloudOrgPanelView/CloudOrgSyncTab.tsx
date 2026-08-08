/**
 * Self-wiring Sync tab: `useCloudOrgSyncStatus` + `CloudOrgSyncSection`.
 *
 * Two surfaces render the same Sync tab — org management (this panel) and
 * Runtime → org → Sync. Both mount THIS component rather than pairing the hook
 * with the section themselves, so a change to either side lands in both places
 * at once; a second pairing is how the two tabs drift apart.
 *
 * Mounting the hook here also scopes its one-shot schema/capability probes to
 * the tab actually being open, instead of firing on every panel mount.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import CloudOrgSyncSection from "./CloudOrgSyncSection";
import { useCloudOrgSyncStatus } from "./useCloudOrgSyncStatus";

interface CloudOrgSyncTabProps {
  orgId: string;
}

export function CloudOrgSyncTab({ orgId }: CloudOrgSyncTabProps) {
  const { t } = useTranslation("navigation");
  const status = useCloudOrgSyncStatus(orgId);
  return <CloudOrgSyncSection t={t} status={status} />;
}

export default CloudOrgSyncTab;
