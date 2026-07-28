import { useAtomValue, useSetAtom } from "jotai";
import { Cloud, Laptop } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { type ProjectOrg, projectApi } from "@src/api/http/project";
import Select, { type SelectOption } from "@src/components/Select";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import {
  buildCloudOrgSelectorValue,
  org2CloudOrgsAtom,
  parseCloudOrgSelectorValue,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { buildOrgSelectorEntries } from "@src/features/Organizations/orgSelectorEntries";
import { createLogger } from "@src/hooks/logger";
import { useProjectDataChanged } from "@src/hooks/project";
import { openOrganizationInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { DEFAULT_SESSION_ORG_ID } from "@src/store/session";
import type { ChatPanelSelectedOrganization } from "@src/store/ui/chatPanelAtom";
import { PROJECT_ORG_SURFACE_VIEW } from "@src/store/workstation/tabs";
import { STORY_ORG_SCOPE } from "@src/store/workstation/tabs";

const logger = createLogger("OrganizationPanelHeader");

interface OrganizationPanelHeaderProps {
  organization: ChatPanelSelectedOrganization;
  tabControl: React.ReactNode;
  dataTestId: string;
}

/** Launchpad-aligned pinned header shared by cloud and local organization views. */
export function OrganizationPanelHeader({
  organization,
  tabControl,
  dataTestId,
}: OrganizationPanelHeaderProps) {
  const { t } = useTranslation("navigation");
  const { t: tProjects } = useTranslation("projects");
  const personalOrgLabel = tProjects("orgs.personalOrg");
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const openOrganizationTab = useSetAtom(openOrganizationInChatPanelTabAtom);
  const [localOrgs, setLocalOrgs] = useState<ProjectOrg[]>([]);

  const fetchLocalOrgs = useCallback(async (): Promise<ProjectOrg[]> => {
    try {
      return await projectApi.readOrgs();
    } catch (error) {
      logger.error("Failed to load organization picker options", error);
      return [];
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchLocalOrgs().then((orgs) => {
      if (!cancelled) setLocalOrgs(orgs);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchLocalOrgs]);
  useProjectDataChanged(
    useCallback(() => {
      void fetchLocalOrgs().then(setLocalOrgs);
    }, [fetchLocalOrgs])
  );

  const pickerEntries = useMemo(
    () =>
      buildOrgSelectorEntries({
        personalOrgId: DEFAULT_SESSION_ORG_ID,
        personalLabel: personalOrgLabel,
        localOrgs,
        cloudOrgs,
        localSuffix: "local",
      }),
    [cloudOrgs, localOrgs, personalOrgLabel]
  );
  const pickerOptions = useMemo<SelectOption[]>(() => {
    const options = pickerEntries.map((entry) => ({
      value: entry.value,
      label: entry.label,
      icon:
        entry.kind === "cloud" ? (
          <Cloud size={13} strokeWidth={2} />
        ) : (
          <Laptop size={13} strokeWidth={2} />
        ),
      dataTestId: `organization-picker-${entry.kind}-${entry.value}`,
    }));
    if (
      organization.kind === "local" &&
      !options.some((option) => option.value === organization.projectOrg.orgId)
    ) {
      options.unshift({
        value: organization.projectOrg.orgId,
        label: organization.projectOrg.orgName,
        icon: <Laptop size={13} strokeWidth={2} />,
        dataTestId: `organization-picker-local-${organization.projectOrg.orgId}`,
      });
    }
    return options;
  }, [organization, pickerEntries]);

  const selectedValue =
    organization.kind === "cloud"
      ? buildCloudOrgSelectorValue(organization.cloudOrg.orgId)
      : organization.projectOrg.orgId;

  const handleOrganizationChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (Array.isArray(value)) return;
      const target = String(value);
      if (target === selectedValue) return;

      if (target === DEFAULT_SESSION_ORG_ID) {
        openOrganizationTab({
          organization: {
            kind: "local",
            projectOrg: {
              orgId: DEFAULT_SESSION_ORG_ID,
              orgName: personalOrgLabel,
              orgScope: STORY_ORG_SCOPE.PERSONAL_ORG,
              initialView: PROJECT_ORG_SURFACE_VIEW.SETTINGS,
              initialViewRequestId: Date.now(),
            },
          },
          title: t("collaboration.manageOrg"),
        });
        return;
      }

      const cloudOrgId = parseCloudOrgSelectorValue(target);
      if (cloudOrgId) {
        openOrganizationTab({
          organization: {
            kind: "cloud",
            cloudOrg: { orgId: cloudOrgId },
          },
          title: t("collaboration.manageOrg"),
        });
        return;
      }

      const org = localOrgs.find((candidate) => candidate.id === target);
      if (!org) return;
      openOrganizationTab({
        organization: {
          kind: "local",
          projectOrg: {
            orgId: org.id,
            orgName: org.name,
            orgScope: STORY_ORG_SCOPE.PROJECT_ORG,
            orgSyncProvider: org.sync_provider,
            initialView: PROJECT_ORG_SURFACE_VIEW.SETTINGS,
            initialViewRequestId: Date.now(),
          },
        },
        title: t("collaboration.manageOrg"),
      });
    },
    [localOrgs, openOrganizationTab, personalOrgLabel, selectedValue, t]
  );

  return (
    <div
      className="sticky top-0 z-20 shrink-0 bg-chat-pane"
      data-testid={dataTestId}
    >
      <div
        className={`${DETAIL_PANEL_TOKENS.headerWidth} flex h-14 min-w-0 items-center justify-center gap-3 px-4 pt-1`}
      >
        <div className="flex -translate-y-1 items-center gap-2">
          <Select
            value={selectedValue}
            options={pickerOptions}
            onChange={handleOrganizationChange}
            showSearch={pickerOptions.length > 8}
            size="large"
            variant="ghost"
            radius="pill"
            dropdownMinWidth={168}
            dropdownWidthMode="auto"
            className="w-auto shrink-0"
            selectorClassName="max-w-[240px] !gap-2 !px-1 !text-[16px] !leading-6 [&_.select-suffix]:!ml-0"
            dataTestId="organization-picker"
          />
          <span
            className="h-5 w-px shrink-0 bg-border-2"
            role="separator"
            aria-hidden
            data-testid="organization-picker-separator"
          />
        </div>
        <div className="min-w-0 overflow-x-auto scrollbar-hide">
          {tabControl}
        </div>
      </div>
    </div>
  );
}

export default OrganizationPanelHeader;
