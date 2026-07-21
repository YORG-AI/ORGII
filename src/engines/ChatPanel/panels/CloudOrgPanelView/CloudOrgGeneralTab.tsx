import type { TFunction } from "i18next";
import React, { useMemo } from "react";

import Button from "@src/components/Button";
import Select from "@src/components/Select";
import type { CloudEntitlementState } from "@src/features/Org2Cloud/org2CloudClient";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  COLLAB_SESSION_ACCESS_MODE,
  type CollabSessionAccessMode,
} from "@src/store/collaboration/types";

import type { SelectValue } from "./cloudOrgPanelTypes";

interface CloudOrgGeneralTabProps {
  t: TFunction<"navigation">;
  entitlement: CloudEntitlementState | null;
  isAdmin: boolean;
  orgFloor: CollabSessionAccessMode;
  savingFloor: boolean;
  floorError: string | null;
  onFloorChange: (value: SelectValue) => Promise<void>;
  openCloudBillingPage: () => void;
}

/** Plan status and this org's sharing/access policy controls. */
export function CloudOrgGeneralTab({
  t,
  entitlement,
  isAdmin,
  orgFloor,
  savingFloor,
  floorError,
  onFloorChange,
  openCloudBillingPage,
}: CloudOrgGeneralTabProps) {
  const floorOptions = useMemo(
    () => [
      {
        value: COLLAB_SESSION_ACCESS_MODE.OFF,
        label: t("cloud.sharingFloor.optionNone"),
        dataTestId: "cloud-org-sharing-floor-off",
      },
      {
        value: COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
        label: t("cloud.syncLevel.modeMetadata"),
        dataTestId: "cloud-org-sharing-floor-metadata",
      },
      {
        value: COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
        label: t("cloud.syncLevel.modeFullReplay"),
        dataTestId: "cloud-org-sharing-floor-full",
      },
    ],
    [t]
  );

  return (
    <>
      <div data-testid="cloud-org-plan-section">
        <SectionContainer>
          {entitlement ? (
            <>
              <SectionRow
                label={t("cloud.orgPanel.planStatus", {
                  plan: entitlement.plan,
                  status: entitlement.status,
                })}
                description={
                  entitlement.plan !== "free"
                    ? t("cloud.orgPanel.manageBillingNote")
                    : undefined
                }
              >
                <Button
                  htmlType="button"
                  size="default"
                  variant={
                    entitlement.plan === "free" ? "primary" : "secondary"
                  }
                  onClick={openCloudBillingPage}
                  data-testid={
                    entitlement.plan === "free"
                      ? "cloud-org-plan-upgrade"
                      : "cloud-org-plan-manage-billing"
                  }
                >
                  {entitlement.plan === "free"
                    ? t("cloud.orgPanel.upgrade")
                    : t("cloud.orgPanel.manageBilling")}
                </Button>
              </SectionRow>
              {typeof entitlement.replayRetentionDays === "number" ? (
                <SectionRow
                  label={t("cloud.orgPanel.retention", {
                    days: entitlement.replayRetentionDays,
                  })}
                  description={t("cloud.orgPanel.retentionNote")}
                />
              ) : null}
            </>
          ) : (
            <div data-testid="cloud-org-plan-error">
              <SectionRow label={t("cloud.orgPanel.loadError")} light />
            </div>
          )}
        </SectionContainer>
      </div>

      <SectionContainer>
        {isAdmin ? (
          <SectionRow
            label={t("cloud.sharingFloor.label")}
            description={t("cloud.sharingFloor.help")}
            align="start"
          >
            <div
              className="flex flex-col gap-2"
              data-testid="cloud-org-sharing-floor"
            >
              <Select
                value={orgFloor}
                options={floorOptions}
                onChange={(value) => void onFloorChange(value)}
                size="default"
                style={SECTION_CONTROL_STYLE}
                disabled={savingFloor}
                dataTestId="cloud-org-sharing-floor-select"
              />
              {floorError ? (
                <span className="text-[12px] text-danger-6">{floorError}</span>
              ) : null}
            </div>
          </SectionRow>
        ) : orgFloor !== COLLAB_SESSION_ACCESS_MODE.OFF ? (
          <SectionRow
            label={
              <span data-testid="cloud-org-sharing-floor-member-note">
                {t("cloud.sharingFloor.label")}
              </span>
            }
            description={t("cloud.sharingFloor.memberNote", {
              mode:
                orgFloor === COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY
                  ? t("cloud.syncLevel.modeFullReplay")
                  : t("cloud.syncLevel.modeMetadata"),
            })}
          />
        ) : null}
      </SectionContainer>
    </>
  );
}

export default CloudOrgGeneralTab;
