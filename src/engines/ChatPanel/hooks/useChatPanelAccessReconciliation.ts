import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";

import { projectApi } from "@src/api/http/project";
import {
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  closeOrganizationChatPanelTabAtom,
  closeProjectOrgChatPanelTabsAtom,
  closeRevokedCloudChannelChatPanelTabsAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import type { ChatPanelSelectedCloudOrg } from "@src/store/ui/chatPanelAtom";

/** Tab access reconciliation runs for the host's lifetime, including hidden tabs. */
export function useChatPanelAccessReconciliation(
  selectedCloudOrg: ChatPanelSelectedCloudOrg | null
) {
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const cloudOrgsLoaded = useAtomValue(org2CloudOrgsLoadedAtom);
  const closeOrganizationTab = useSetAtom(closeOrganizationChatPanelTabAtom);
  const closeProjectOrgTabs = useSetAtom(closeProjectOrgChatPanelTabsAtom);
  const closeRevokedCloudChannelTabs = useSetAtom(
    closeRevokedCloudChannelChatPanelTabsAtom
  );
  // A teammate can lose the selected cloud org while its management panel
  // is open (member removal or org deletion). Once the authoritative roster
  // has loaded, an absent org is not a recoverable panel state: close the
  // stale surface immediately instead of leaving deleted names/actions on
  // screen. Keep the selection during the initial unknown-roster phase so
  // a cold start does not flicker the panel closed before list_my_orgs lands.
  useEffect(() => {
    if (
      selectedCloudOrg &&
      cloudOrgsLoaded &&
      !cloudOrgs.some((org) => org.orgId === selectedCloudOrg.orgId)
    ) {
      closeOrganizationTab();
    }
  }, [closeOrganizationTab, cloudOrgs, cloudOrgsLoaded, selectedCloudOrg]);

  // `project_orgs` is a durable local mirror, not an authorization source.
  // Once the managed-cloud roster is authoritative, close any cached detail
  // tabs whose alias no longer maps to a live membership. The create pickers
  // apply the same boundary in projectOrgVisibility.
  useEffect(() => {
    if (!cloudOrgsLoaded) return undefined;
    let cancelled = false;
    const liveCloudOrgIds = new Set(cloudOrgs.map((org) => org.orgId));
    void projectApi.readOrgs().then((projectOrgs) => {
      if (cancelled) return;
      const revokedProjectOrgIds = projectOrgs
        .filter(
          (org) =>
            org.sync_provider === "orgii_collab" &&
            Boolean(org.external_org_id) &&
            !liveCloudOrgIds.has(org.external_org_id as string)
        )
        .map((org) => org.id);
      closeProjectOrgTabs(revokedProjectOrgIds);
    });
    return () => {
      cancelled = true;
    };
  }, [closeProjectOrgTabs, cloudOrgs, cloudOrgsLoaded]);

  // Channel tabs live in the CLOUD org id space (unlike the project-org
  // aliases above) and per-org reconciliation only covers the active
  // sidebar scope; sweep revoked orgs' channel tabs here once the roster
  // is authoritative.
  useEffect(() => {
    if (!cloudOrgsLoaded) return;
    closeRevokedCloudChannelTabs(cloudOrgs.map((org) => org.orgId));
  }, [closeRevokedCloudChannelTabs, cloudOrgs, cloudOrgsLoaded]);
}
