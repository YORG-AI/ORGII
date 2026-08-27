import { Building2, Cloud, Link2, Plus } from "lucide-react";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import { openOrg2CloudSignIn } from "@src/features/Org2Cloud/useOrg2CloudSignIn";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  SelectionGrid,
  WizardStepContent,
} from "@src/scaffold/WizardSystem/primitives";

import { OrganizationStepIcon } from "../components/SetupStepIcons";
import { SETUP_WALKTHROUGH_LAYOUT_TOKENS } from "../layoutTokens";
import { CONTROL_STYLE, type StepProps } from "./types";

export const OrganizationStep: React.FC<StepProps> = ({ controller }) => {
  const { t } = useTranslation("onboarding");
  const [mode, setMode] = useState<"create" | "join">("create");
  const [orgName, setOrgName] = useState("");
  const [invite, setInvite] = useState("");
  const openSignIn = React.useCallback(() => {
    controller.setOperationError(null);
    void openOrg2CloudSignIn().catch((error: unknown) => {
      controller.setOperationError(
        error instanceof Error ? error.message : String(error)
      );
    });
  }, [controller]);
  const orgOptions = controller.cloudOrgs.map((org) => ({
    key: org.orgId,
    label: org.name,
    description: t("readiness.organization.role", {
      role: t(`readiness.organization.roles.${org.role.toLowerCase()}`, {
        defaultValue: org.role,
      }),
    }),
    icon: Building2,
  }));
  const selected = controller.progress.selectedOrgId;
  return (
    <WizardStepContent
      title={t("readiness.organization.title")}
      description={t("readiness.organization.description")}
      icon={OrganizationStepIcon}
    >
      {!controller.cloudAuth ? (
        <InlineAlert
          type="info"
          action={
            <Button
              variant="primary"
              icon={<Cloud size={15} />}
              onClick={openSignIn}
              data-testid="setup-cloud-sign-in"
            >
              {t("readiness.organization.signIn")}
            </Button>
          }
        >
          {t("readiness.organization.signInHint")}
        </InlineAlert>
      ) : (
        <>
          {orgOptions.length > 0 && (
            <SectionContainer>
              <SectionRow
                label={t("readiness.organization.existing")}
                layout="vertical"
              >
                <SelectionGrid
                  options={orgOptions}
                  selected={selected}
                  onSelect={(orgId) => {
                    const org = controller.cloudOrgs.find(
                      (item) => item.orgId === orgId
                    );
                    if (org) controller.selectOrganization(org);
                  }}
                  columns={2}
                  cardVariant="subtle"
                  compactCards
                  className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.choiceGrid}
                />
              </SectionRow>
            </SectionContainer>
          )}
          <SectionContainer>
            <SectionRow
              label={t("readiness.organization.mode")}
              layout="vertical"
            >
              <SelectionGrid
                options={[
                  {
                    key: "create",
                    label: t("readiness.organization.create"),
                    icon: Plus,
                  },
                  {
                    key: "join",
                    label: t("readiness.organization.join"),
                    icon: Link2,
                  },
                ]}
                selected={mode}
                onSelect={setMode}
                columns={2}
                compactCards
                className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.choiceGrid}
              />
            </SectionRow>
            <SectionRow
              label={
                mode === "create"
                  ? t("readiness.organization.orgName")
                  : t("readiness.organization.invite")
              }
              layout="vertical"
              required
            >
              <div className="flex gap-2">
                <Input
                  value={mode === "create" ? orgName : invite}
                  onChange={mode === "create" ? setOrgName : setInvite}
                  placeholder={
                    mode === "create"
                      ? t("readiness.organization.orgNamePlaceholder")
                      : t("readiness.organization.invitePlaceholder")
                  }
                  style={CONTROL_STYLE}
                  data-testid={
                    mode === "create"
                      ? "setup-cloud-org-name"
                      : "setup-cloud-org-invite"
                  }
                  aria-label={
                    mode === "create"
                      ? t("readiness.organization.orgName")
                      : t("readiness.organization.invite")
                  }
                />
                <Button
                  variant="primary"
                  loading={
                    controller.activeOperation ===
                    (mode === "create" ? "create-org" : "join-org")
                  }
                  disabled={
                    controller.activeOperation !== null ||
                    (mode === "create" ? !orgName.trim() : !invite.trim())
                  }
                  onClick={() =>
                    void (mode === "create"
                      ? controller.actions.createOrganization(orgName)
                      : controller.actions.joinOrganization(invite))
                  }
                  data-testid="setup-cloud-org-submit"
                >
                  {mode === "create"
                    ? t("readiness.organization.create")
                    : t("readiness.organization.join")}
                </Button>
              </div>
            </SectionRow>
          </SectionContainer>
        </>
      )}
      {selected && (
        <InlineAlert type="success" role="status">
          {t("readiness.organization.selected", {
            org: controller.progress.selectedOrgName,
          })}
        </InlineAlert>
      )}
    </WizardStepContent>
  );
};
