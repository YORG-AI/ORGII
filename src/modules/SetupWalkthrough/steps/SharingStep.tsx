import {
  Clipboard,
  FolderGit2,
  Link2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Select from "@src/components/Select";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_CONTROL_STYLE,
  SECTION_PATH_TEXT_CLASSES,
  SECTION_VALUE_TEXT_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { openWorkspaceSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { WizardStepContent } from "@src/scaffold/WizardSystem/primitives";

import { SharingStepIcon } from "../components/SetupStepIcons";
import type { StepProps } from "./types";

export const SharingStep: React.FC<StepProps> = ({ controller }) => {
  const { t } = useTranslation("onboarding");
  const isMember = controller.progress.selectedOrgRole === "member";
  const isSaved = controller.progress.verifiedAt !== null;
  return (
    <WizardStepContent
      title={t("readiness.sharing.title")}
      description={t("readiness.sharing.description")}
      icon={SharingStepIcon}
    >
      <SectionContainer>
        <SectionRow
          label={t("readiness.sharing.workspace")}
          description={t("readiness.sharing.workspaceDescription")}
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className={`max-w-64 truncate ${SECTION_VALUE_TEXT_CLASSES}`}>
              {controller.workspaceFolders.length
                ? controller.workspaceFolders
                    .map((folder) => folder.name)
                    .join(", ")
                : t("readiness.sharing.noWorkspace")}
            </span>
            <Button
              size="small"
              icon={<FolderGit2 size={14} />}
              onClick={() => openWorkspaceSpotlight("open")}
            >
              {t("readiness.sharing.openWorkspace")}
            </Button>
          </div>
        </SectionRow>
        {!isMember && (
          <>
            <SectionRow
              label={t("readiness.sharing.repoScope")}
              description={t("readiness.sharing.repoScopeDescription")}
            >
              <Button
                size="small"
                loading={controller.activeOperation === "resolve-scopes"}
                disabled={
                  controller.activeOperation !== null &&
                  controller.activeOperation !== "resolve-scopes"
                }
                onClick={() => void controller.actions.resolveWorkspaceScopes()}
                data-testid="setup-resolve-repo-scope"
              >
                {t("readiness.sharing.detectScope")}
              </Button>
            </SectionRow>
            {controller.progress.repoScopes.map((scope) => (
              <SectionRow key={scope} label={t("readiness.sharing.remote")}>
                <code className={SECTION_PATH_TEXT_CLASSES}>{scope}</code>
              </SectionRow>
            ))}
            <SectionRow
              label={t("readiness.sharing.level")}
              description={t("readiness.sharing.levelDescription")}
            >
              <Select
                value={controller.progress.sharingFloor}
                onChange={(value) =>
                  controller.patchProgress({
                    sharingFloor:
                      value as typeof controller.progress.sharingFloor,
                    verifiedAt: null,
                  })
                }
                options={[
                  {
                    value: "off",
                    label: t("readiness.sharing.off"),
                  },
                  {
                    value: "metadata_only",
                    label: t("readiness.sharing.metadata"),
                  },
                  {
                    value: "full_replay",
                    label: t("readiness.sharing.replay"),
                  },
                ]}
                style={SECTION_CONTROL_STYLE}
              />
            </SectionRow>
          </>
        )}
      </SectionContainer>
      {isMember ? (
        <>
          <InlineAlert type="info">
            {t("readiness.sharing.memberHint", {
              org: controller.progress.selectedOrgName,
            })}
          </InlineAlert>
          <Button
            variant="primary"
            icon={<RefreshCw size={15} />}
            loading={controller.activeOperation === "verify-sync"}
            disabled={controller.activeOperation !== null}
            onClick={() => void controller.actions.verifySync()}
            data-testid="setup-verify-member-sync"
          >
            {t("readiness.sharing.verifyMember")}
          </Button>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon={<ShieldCheck size={15} />}
            loading={controller.activeOperation === "save-policy"}
            disabled={
              controller.progress.repoScopes.length === 0 ||
              controller.activeOperation !== null
            }
            onClick={() => void controller.actions.saveTeamPolicy()}
            data-testid="setup-save-team-policy"
          >
            {t("readiness.sharing.save")}
          </Button>
          <Button
            icon={<Link2 size={15} />}
            loading={controller.activeOperation === "create-invite"}
            disabled={!isSaved || controller.activeOperation !== null}
            onClick={() => void controller.actions.createInvite()}
            data-testid="setup-create-team-invite"
          >
            {t("readiness.sharing.createInvite")}
          </Button>
        </div>
      )}
      {controller.progress.inviteLink && (
        <SectionContainer>
          <SectionRow label={t("readiness.organization.invite")}>
            <div className={SECTION_ACTION_GAP_CLASSES}>
              <code className={SECTION_PATH_TEXT_CLASSES}>
                {controller.progress.inviteLink}
              </code>
              <Button
                size="small"
                icon={<Clipboard size={14} />}
                onClick={() =>
                  void navigator.clipboard.writeText(
                    controller.progress.inviteLink ?? ""
                  )
                }
              >
                {t("readiness.sharing.copy")}
              </Button>
            </div>
          </SectionRow>
        </SectionContainer>
      )}
      {isSaved && (
        <InlineAlert type="success" role="status">
          {t(
            isMember
              ? "readiness.sharing.memberVerified"
              : "readiness.sharing.verified"
          )}
        </InlineAlert>
      )}
    </WizardStepContent>
  );
};
