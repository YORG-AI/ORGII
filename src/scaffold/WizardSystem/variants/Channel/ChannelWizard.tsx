/**
 * ChannelWizard Component
 *
 * Single-step wizard for adding a new integration. Git connections
 * are created through the same wizard via four methods (scan / OAuth
 * / PAT / SSH) and stored in `connection_token_store`.
 */
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import {
  STORY_SYNC_ADAPTER,
  STORY_SYNC_AUTH_METHOD,
  syncConnectionsApi,
} from "@src/api/http/integrations";
import { WizardShell } from "@src/scaffold/WizardSystem/primitives";

import { ChannelContent, GitContent, ProjectContent } from "./ChannelSections";
import {
  ChannelWizardActions,
  ChannelWizardFooterStatus,
} from "./ChannelWizardActions";
import IntegrationSelection from "./IntegrationSelection";
import { buildConfigData, validateAccountName } from "./channelWizardHelpers";
import type {
  ProjectSyncAdapterType,
  WizardCategory,
} from "./channelWizardTypes";
import { useChannelWizardState } from "./useChannelWizardState";

interface ChannelWizardProps {
  onSubmit: (
    channelType: string,
    accountId: string,
    configData: Record<string, unknown>
  ) => void;
  onCancel: () => void;
  existingAccounts: Map<string, string[]>;
  initialCategory?: WizardCategory | null;
  initialType?: string | null;
  onGitConnected?: () => void;
  onProjectsConnected?: () => void | Promise<void>;
}

const ChannelWizard: React.FC<ChannelWizardProps> = ({
  onSubmit,
  onCancel,
  existingAccounts,
  initialCategory,
  initialType,
  onGitConnected,
  onProjectsConnected,
}) => {
  const { t } = useTranslation("integrations");
  const wizardState = useChannelWizardState({
    existingAccounts,
    initialCategory,
    initialType,
  });

  const {
    accountName,
    category,
    channelConfig,
    channelIsValid,
    errors,
    gitMethod,
    gitOAuthFlow,
    gitPat,
    gitScanCandidate,
    gitSshKeyPath,
    gitSubmitError,
    gitSubmitting,
    handleAccountNameChange,
    handleConfigChange,
    handleGitMethodChange,
    handleProbe,
    handleProjectMethodChange,
    handleSelectType,
    handleSelectionClear,
    isChannels,
    isDuplicateName,
    isGit,
    isProjects,
    probeErrorDismissed,
    probeResult,
    probing,
    projectAuthMethod,
    projectOAuthFlow,
    projectSubmitError,
    projectSubmitting,
    projectToken,
    resolvedAccountId,
    resolvedAccountName,
    selectedType,
    selectedTypeLabel,
    setErrors,
    setGitOAuthFlow,
    setGitPat,
    setGitScanCandidate,
    setGitSshKeyPath,
    setGitSubmitError,
    setGitSubmitting,
    setProbeErrorDismissed,
    setProjectOAuthFlow,
    setProjectSubmitError,
    setProjectSubmitting,
    setProjectToken,
  } = wizardState;

  const handleSubmit = useCallback(() => {
    if (!selectedType) return;

    const validationErrors = validateAccountName(isDuplicateName, {
      duplicate: t("integrations.accountNameDuplicate"),
    });
    if (validationErrors.name) {
      setErrors(validationErrors);
      return;
    }

    const configData = buildConfigData(channelConfig);
    onSubmit(selectedType, resolvedAccountId, configData);
  }, [
    selectedType,
    isDuplicateName,
    resolvedAccountId,
    channelConfig,
    t,
    onSubmit,
    setErrors,
  ]);

  // Dispatch the right per-method create command for GitHub. Account-name
  // validation is shared with the channel / project paths.
  const handleGitSubmit = useCallback(async () => {
    if (!gitMethod) return;

    const validationErrors = validateAccountName(isDuplicateName, {
      duplicate: t("integrations.accountNameDuplicate"),
    });
    if (validationErrors.name) {
      setErrors(validationErrors);
      return;
    }

    setGitSubmitting(true);
    setGitSubmitError(null);
    try {
      const label = resolvedAccountName;
      if (gitMethod === STORY_SYNC_AUTH_METHOD.SCAN) {
        if (!gitScanCandidate) {
          setGitSubmitError(
            t(
              "gitConnections.scanSelectRequired",
              "Pick a detected credential to import."
            )
          );
          setGitSubmitting(false);
          return;
        }
        if (gitScanCandidate.kind === "ssh_key") {
          await syncConnectionsApi.createFromSsh(
            STORY_SYNC_ADAPTER.GITHUB,
            label,
            gitScanCandidate.secret,
            gitScanCandidate.username
          );
        } else {
          await syncConnectionsApi.createFromScan(
            STORY_SYNC_ADAPTER.GITHUB,
            label,
            gitScanCandidate.secret,
            gitScanCandidate.username
          );
        }
      } else if (gitMethod === STORY_SYNC_AUTH_METHOD.OAUTH) {
        const started = await syncConnectionsApi.oauthStart(
          STORY_SYNC_ADAPTER.GITHUB,
          label
        );
        setGitOAuthFlow(started.flow);
        await syncConnectionsApi.oauthComplete(started.connection.id);
      } else if (gitMethod === STORY_SYNC_AUTH_METHOD.PAT) {
        if (!gitPat.trim()) {
          setGitSubmitError(t("projectConnections.tokenRequired"));
          setGitSubmitting(false);
          return;
        }
        await syncConnectionsApi.createPat(
          STORY_SYNC_ADAPTER.GITHUB,
          label,
          gitPat.trim()
        );
      } else if (gitMethod === STORY_SYNC_AUTH_METHOD.SSH) {
        if (!gitSshKeyPath.trim()) {
          setGitSubmitError(
            t("gitConnections.sshKeyPathRequired", "SSH key path is required.")
          );
          setGitSubmitting(false);
          return;
        }
        await syncConnectionsApi.createFromSsh(
          STORY_SYNC_ADAPTER.GITHUB,
          label,
          gitSshKeyPath.trim()
        );
      }
      onGitConnected?.();
      onCancel();
    } catch (error) {
      setGitSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setGitSubmitting(false);
    }
  }, [
    gitMethod,
    gitScanCandidate,
    gitPat,
    gitSshKeyPath,
    resolvedAccountName,
    isDuplicateName,
    t,
    onGitConnected,
    onCancel,
    setErrors,
    setGitOAuthFlow,
    setGitSubmitError,
    setGitSubmitting,
  ]);

  // OAuth-only entry point used by the "Sign in with GitHub" button
  // inside `GitContent`. Distinct from `handleGitSubmit` so the OAuth
  // button can fire without waiting for the user to click Done in the
  // footer (matches the project-side `ProjectContent` UX).
  const handleGitOAuthStart = useCallback(() => {
    void handleGitSubmit();
  }, [handleGitSubmit]);

  const handleProjectSubmit = useCallback(async () => {
    if (!selectedType) return;

    const validationErrors = validateAccountName(isDuplicateName, {
      duplicate: t("integrations.accountNameDuplicate"),
    });
    if (validationErrors.name) {
      setErrors(validationErrors);
      return;
    }

    if (
      projectAuthMethod === STORY_SYNC_AUTH_METHOD.PAT &&
      !projectToken.trim()
    ) {
      setProjectSubmitError(t("projectConnections.tokenRequired"));
      return;
    }

    setProjectSubmitting(true);
    setProjectSubmitError(null);
    try {
      const adapterId = selectedType as ProjectSyncAdapterType;
      if (projectAuthMethod === STORY_SYNC_AUTH_METHOD.PAT) {
        await syncConnectionsApi.createPat(
          adapterId,
          resolvedAccountName,
          projectToken.trim()
        );
      } else {
        const started = await syncConnectionsApi.oauthStart(
          adapterId,
          resolvedAccountName
        );
        setProjectOAuthFlow(started.flow);
        await syncConnectionsApi.oauthComplete(started.connection.id);
      }
      await onProjectsConnected?.();
      onCancel();
    } catch (error) {
      setProjectSubmitError(
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setProjectSubmitting(false);
    }
  }, [
    selectedType,
    resolvedAccountName,
    isDuplicateName,
    projectAuthMethod,
    projectToken,
    t,
    onProjectsConnected,
    onCancel,
    setErrors,
    setProjectOAuthFlow,
    setProjectSubmitError,
    setProjectSubmitting,
  ]);

  const stepActions = (
    <ChannelWizardActions
      categorySelected={!!category}
      isChannels={isChannels}
      isProjects={isProjects}
      isGit={isGit}
      selectedType={selectedType}
      isDuplicateName={isDuplicateName}
      channelIsValid={channelIsValid}
      projectAuthMethod={projectAuthMethod}
      projectToken={projectToken}
      projectSubmitting={projectSubmitting}
      gitMethod={gitMethod}
      gitPat={gitPat}
      gitSshKeyPath={gitSshKeyPath}
      gitScanCandidateSelected={!!gitScanCandidate}
      gitSubmitting={gitSubmitting}
      onChannelSubmit={handleSubmit}
      onProjectSubmit={handleProjectSubmit}
      onGitSubmit={handleGitSubmit}
    />
  );

  const footerLeft = (
    <ChannelWizardFooterStatus
      isChannels={isChannels}
      verified={!!probeResult?.ok}
    />
  );

  const channelContent = isChannels ? (
    <ChannelContent
      selectedType={selectedType}
      channelConfig={channelConfig}
      channelIsValid={channelIsValid}
      probing={probing}
      probeResult={probeResult}
      probeErrorDismissed={probeErrorDismissed}
      onConfigChange={handleConfigChange}
      onProbe={handleProbe}
      onDismissProbeError={() => setProbeErrorDismissed(true)}
    />
  ) : null;

  const projectContent = isProjects ? (
    <ProjectContent
      selectedType={selectedType}
      isDuplicateName={isDuplicateName}
      projectAuthMethod={projectAuthMethod}
      projectToken={projectToken}
      projectSubmitting={projectSubmitting}
      projectSubmitError={projectSubmitError}
      projectOAuthFlow={projectOAuthFlow}
      onProjectMethodChange={handleProjectMethodChange}
      onProjectTokenChange={setProjectToken}
      onProjectSubmit={handleProjectSubmit}
    />
  ) : null;

  const gitContent = isGit ? (
    <GitContent
      selectedType={selectedType}
      isDuplicateName={isDuplicateName}
      gitMethod={gitMethod}
      gitPat={gitPat}
      gitSshKeyPath={gitSshKeyPath}
      gitScanCandidate={gitScanCandidate}
      gitOAuthFlow={gitOAuthFlow}
      gitSubmitting={gitSubmitting}
      gitSubmitError={gitSubmitError}
      onGitMethodChange={handleGitMethodChange}
      onGitPatChange={setGitPat}
      onGitSshKeyPathChange={setGitSshKeyPath}
      onGitScanCandidateChange={setGitScanCandidate}
      onGitOAuthStart={handleGitOAuthStart}
    />
  ) : null;

  return (
    <WizardShell title={t("integrations.addAccount")} onCancel={onCancel}>
      <IntegrationSelection
        category={category}
        selectedType={selectedType}
        onSelectType={handleSelectType}
        onClearSelection={handleSelectionClear}
        accountName={accountName}
        accountNameBase={selectedTypeLabel}
        onAccountNameChange={handleAccountNameChange}
        errors={errors}
        isDuplicateName={isDuplicateName}
        totalSteps={1}
        actions={stepActions}
        onCancel={onCancel}
        footerLeft={footerLeft}
        channelContent={channelContent}
        projectContent={projectContent}
        gitContent={gitContent}
      />
    </WizardShell>
  );
};

export default ChannelWizard;
