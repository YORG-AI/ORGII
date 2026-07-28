import type { TFunction } from "i18next";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import type {
  CloudEntitlementState,
  CloudOrgMember,
} from "@src/features/Org2Cloud/org2CloudClient";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  COLLAB_SESSION_ACCESS_MODE,
  type CollabSessionAccessMode,
} from "@src/store/collaboration/types";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import type { SelectValue } from "./cloudOrgPanelTypes";
import type { CloudOrgManagement } from "./useCloudOrgManagement";

interface CloudOrgSettingsSectionProps {
  t: TFunction<"navigation">;
  entitlement: CloudEntitlementState | null;
  orgFloor: CollabSessionAccessMode;
  savingFloor: boolean;
  floorError: string | null;
  onFloorChange: (value: SelectValue) => Promise<void>;
  openCloudBillingPage: () => void;
  orgName: string;
  members: CloudOrgMember[];
  currentUserId: string | null;
  management: CloudOrgManagement;
  onOpenSessions: () => void;
}

/** General-tab plan, sharing policy, and organization identity settings. */
export function CloudOrgSettingsSection({
  t,
  entitlement,
  orgFloor,
  savingFloor,
  floorError,
  onFloorChange,
  openCloudBillingPage,
  orgName,
  members,
  currentUserId,
  management,
  onOpenSessions,
}: CloudOrgSettingsSectionProps) {
  const { t: tCommon } = useTranslation("common");
  const {
    isAdmin,
    isOwner,
    renaming,
    renameSaved,
    renameError,
    handleRenameOrg,
    transferring,
    transferError,
    handleTransferOwnership,
    deleting,
    deleteError,
    handleDeleteOrg,
  } = management;

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

  const [nameDraft, setNameDraft] = useState(orgName);
  // Re-seed when a rename lands (refetched org name) or the org switches.
  const [seededName, setSeededName] = useState(orgName);
  if (seededName !== orgName) {
    setSeededName(orgName);
    setNameDraft(orgName);
  }

  const [transferTarget, setTransferTarget] = useState<string>("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const transferOptions = useMemo(
    () =>
      members
        .filter(
          (member) =>
            member.status === "active" && member.userId !== currentUserId
        )
        .map((member) => ({
          value: member.userId,
          label: member.displayName ?? member.userId,
          dataTestId: `cloud-org-transfer-option-${member.userId}`,
        })),
    [members, currentUserId]
  );

  const nameDirty = nameDraft.trim().length > 0 && nameDraft.trim() !== orgName;

  const handleTransfer = async () => {
    if (!transferTarget) return;
    const target = members.find((member) => member.userId === transferTarget);
    const confirmed = await confirmDestructiveAction({
      title: t("cloud.orgManagement.settings.transferTitle"),
      message: t("cloud.orgManagement.settings.transferConfirm", {
        org: orgName,
        member: target?.displayName ?? transferTarget,
      }),
      okLabel: t("cloud.orgManagement.settings.transferAction"),
      cancelLabel: t("cloud.orgManagement.leave.cancel"),
    });
    if (!confirmed) return;
    void handleTransferOwnership(transferTarget);
  };

  return (
    <>
      <SectionContainer title={t("cloud.orgManagement.settings.title")}>
        {entitlement ? (
          <>
            <SectionRow
              dataTestId="cloud-org-plan-section"
              label={t("cloud.orgPanel.planStatus", {
                plan: entitlement.plan,
                status: entitlement.status,
              })}
              description={
                entitlement.plan !== "free"
                  ? t("cloud.orgPanel.manageBillingNote")
                  : undefined
              }
              align="start"
            >
              <Button
                htmlType="button"
                size="default"
                variant={entitlement.plan === "free" ? "primary" : "secondary"}
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
          <SectionRow
            dataTestId="cloud-org-plan-section"
            label={
              <span data-testid="cloud-org-plan-error">
                {t("cloud.orgPanel.loadError")}
              </span>
            }
            light
          />
        )}

        <SectionRow
          dataTestId="cloud-org-sessions-row"
          label={t("routes.sessions")}
        >
          <Button
            htmlType="button"
            size="default"
            variant="secondary"
            data-testid="cloud-org-open-sessions"
            onClick={onOpenSessions}
          >
            {tCommon("actions.open")}
          </Button>
        </SectionRow>

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

        {isAdmin ? (
          <SectionRow
            dataTestId="cloud-org-settings"
            label={t("cloud.orgManagement.settings.renameLabel")}
          >
            <div
              className={`${SECTION_ACTION_GAP_CLASSES} flex-wrap`}
              data-testid="cloud-org-name-controls"
            >
              <Input
                size="default"
                value={nameDraft}
                onChange={setNameDraft}
                style={SECTION_CONTROL_STYLE}
                data-testid="cloud-org-rename-input"
              />
              <Button
                htmlType="button"
                size="default"
                variant="primary"
                disabled={!nameDirty || renaming}
                loading={renaming}
                data-testid="cloud-org-rename-save"
                onClick={() => void handleRenameOrg(nameDraft.trim())}
              >
                {t("cloud.orgManagement.settings.renameSave")}
              </Button>
              {renameSaved ? (
                <span className="text-[12px] text-success-6">
                  {t("cloud.orgManagement.settings.renamed")}
                </span>
              ) : null}
              {renameError ? (
                <span className="text-[12px] text-danger-6">{renameError}</span>
              ) : null}
            </div>
          </SectionRow>
        ) : null}

        {isOwner ? (
          <>
            <SectionRow
              label={t("cloud.orgManagement.settings.transferTitle")}
              description={t("cloud.orgManagement.settings.transferHint")}
              align="start"
            >
              <div className={`${SECTION_ACTION_GAP_CLASSES} flex-wrap`}>
                <Select
                  size="default"
                  value={transferTarget || undefined}
                  options={transferOptions}
                  placeholder={t(
                    "cloud.orgManagement.settings.transferPlaceholder"
                  )}
                  style={SECTION_CONTROL_STYLE}
                  disabled={transferring || transferOptions.length === 0}
                  dataTestId="cloud-org-transfer-select"
                  onChange={(value) => setTransferTarget(String(value))}
                />
                <Button
                  htmlType="button"
                  size="default"
                  variant="secondary"
                  disabled={!transferTarget || transferring}
                  loading={transferring}
                  data-testid="cloud-org-transfer-confirm"
                  onClick={() => void handleTransfer()}
                >
                  {t("cloud.orgManagement.settings.transferAction")}
                </Button>
                {transferError ? (
                  <span className="text-[12px] text-danger-6">
                    {transferError}
                  </span>
                ) : null}
              </div>
            </SectionRow>

            <SectionRow
              label={t("cloud.orgManagement.settings.ownerLeaveHint")}
              light
            />
          </>
        ) : null}
      </SectionContainer>

      {isOwner ? (
        <SectionContainer title={t("cloud.orgManagement.settings.dangerZone")}>
          <SectionRow
            dataTestId="cloud-org-danger-zone"
            label={t("cloud.orgManagement.settings.deleteTitle")}
            description={t("cloud.orgManagement.settings.deleteHint", {
              org: orgName,
            })}
            layout="vertical"
          >
            <div className={`${SECTION_ACTION_GAP_CLASSES} flex-wrap`}>
              <Input
                size="default"
                value={deleteConfirmText}
                onChange={setDeleteConfirmText}
                placeholder={t(
                  "cloud.orgManagement.settings.deleteTypeToConfirm",
                  { org: orgName }
                )}
                style={SECTION_CONTROL_STYLE}
                data-testid="cloud-org-delete-confirm-input"
              />
              <Button
                htmlType="button"
                size="default"
                variant="danger"
                disabled={deleteConfirmText.trim() !== orgName || deleting}
                loading={deleting}
                data-testid="cloud-org-delete-confirm"
                onClick={() => void handleDeleteOrg()}
              >
                {t("cloud.orgManagement.settings.deleteAction")}
              </Button>
              {deleteError ? (
                <span className="text-[12px] text-danger-6">{deleteError}</span>
              ) : null}
            </div>
          </SectionRow>
        </SectionContainer>
      ) : null}
    </>
  );
}

export default CloudOrgSettingsSection;
