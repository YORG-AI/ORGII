import React from "react";
import { useTranslation } from "react-i18next";

import { STORY_SYNC_AUTH_METHOD } from "@src/api/http/integrations";
import Button from "@src/components/Button";
import { HugeiconsIcon, Tick01Icon } from "@src/icons";

import type { ProjectSyncAuthMethod } from "./channelWizardTypes";

interface ChannelWizardActionsProps {
  categorySelected: boolean;
  isChannels: boolean;
  isProjects: boolean;
  isGit: boolean;
  selectedType: string | null;
  isDuplicateName: boolean;
  channelIsValid: boolean;
  projectAuthMethod: ProjectSyncAuthMethod;
  projectToken: string;
  projectSubmitting: boolean;
  gitMethod: ProjectSyncAuthMethod | null;
  gitPat: string;
  gitSshKeyPath: string;
  gitScanCandidateSelected: boolean;
  gitSubmitting: boolean;
  onChannelSubmit: () => void;
  onProjectSubmit: () => void;
  onGitSubmit: () => void;
}

export const ChannelWizardActions: React.FC<ChannelWizardActionsProps> = ({
  categorySelected,
  isChannels,
  isProjects,
  isGit,
  selectedType,
  isDuplicateName,
  channelIsValid,
  projectAuthMethod,
  projectToken,
  projectSubmitting,
  gitMethod,
  gitPat,
  gitSshKeyPath,
  gitScanCandidateSelected,
  gitSubmitting,
  onChannelSubmit,
  onProjectSubmit,
  onGitSubmit,
}) => {
  const { t } = useTranslation("integrations");

  if (!categorySelected) return null;

  if (isChannels) {
    return (
      <Button
        variant="primary"
        size="small"
        disabled={!selectedType || isDuplicateName || !channelIsValid}
        onClick={onChannelSubmit}
      >
        {t("common:actions.done")}
      </Button>
    );
  }

  if (isProjects) {
    if (projectAuthMethod !== STORY_SYNC_AUTH_METHOD.PAT) return null;

    return (
      <Button
        variant="primary"
        size="small"
        disabled={!selectedType || isDuplicateName || !projectToken.trim()}
        loading={projectSubmitting}
        onClick={onProjectSubmit}
      >
        {t("common:actions.done")}
      </Button>
    );
  }

  // GitHub uses its own setup form. The OAuth tile fires its own primary
  // button inside `GitContent`; for the other methods the footer Done
  // button drives submission.
  if (isGit) {
    if (gitMethod === STORY_SYNC_AUTH_METHOD.OAUTH) return null;
    const hasInput =
      gitMethod === STORY_SYNC_AUTH_METHOD.SCAN
        ? gitScanCandidateSelected
        : gitMethod === STORY_SYNC_AUTH_METHOD.PAT
          ? !!gitPat.trim()
          : gitMethod === STORY_SYNC_AUTH_METHOD.SSH
            ? !!gitSshKeyPath.trim()
            : false;
    return (
      <Button
        variant="primary"
        size="small"
        disabled={!selectedType || isDuplicateName || !gitMethod || !hasInput}
        loading={gitSubmitting}
        onClick={onGitSubmit}
      >
        {t("common:actions.done")}
      </Button>
    );
  }

  return null;
};

interface ChannelWizardFooterStatusProps {
  isChannels: boolean;
  verified: boolean;
}

export const ChannelWizardFooterStatus: React.FC<
  ChannelWizardFooterStatusProps
> = ({ isChannels, verified }) => {
  const { t } = useTranslation("integrations");

  if (!isChannels || !verified) return undefined;

  return (
    <div className="flex items-center gap-1.5">
      <HugeiconsIcon
        icon={Tick01Icon}
        data-icon="check"
        size={14}
        className="text-success-6"
      />
      <span className="text-[12px] text-success-6">
        {t("integrations.verified")}
      </span>
    </div>
  );
};
