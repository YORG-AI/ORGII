import { useAtomValue } from "jotai";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { useActionSystemOptional } from "@src/ActionSystem";
import { generateCommitMessage } from "@src/api/tauri/git/commitMessage";
import { useGitOperations } from "@src/hooks/git/useGitOperations";
import { gitCommitInstructionsAtom } from "@src/store/ui/editorSettingsAtom";
import { gitOutputIntegrationAtom } from "@src/store/workstation/codeEditor/outputIntegration";
import type { GitFile } from "@src/types/git/types";
import { showGitActionDialogSafely } from "@src/util/dialogs/gitActionDialog";

import { runAmendOperation, runCommitOperation } from "./commitFormOperations";
import { hasConfiguredGitRemote } from "./commitFormRemote";

export interface CommitSuccessOptions {
  pushed?: boolean;
}

export interface UseCommitFormOptions {
  selectedRepoId: string | null;
  repoPath?: string;
  files: GitFile[];
  onCommitSuccess?: (options?: CommitSuccessOptions) => void | Promise<void>;
}

export interface UseCommitFormResult {
  commitSummary: string;
  setCommitSummary: Dispatch<SetStateAction<string>>;
  commitDescription: string;
  setCommitDescription: Dispatch<SetStateAction<string>>;
  commitLoading: boolean;
  handleCommit: () => Promise<void>;
  handleCommitAndPush: () => Promise<void>;
  handleCommitAndPublish: () => Promise<void>;
  handleCommitAndSync: () => Promise<void>;
  handleAmend: () => Promise<void>;
  generateLoading: boolean;
  handleGenerateCommitMessage: () => Promise<void>;
}

export function useCommitForm(
  options: UseCommitFormOptions
): UseCommitFormResult {
  const { selectedRepoId, repoPath, files, onCommitSuccess } = options;
  const { t } = useTranslation();
  const actionSystem = useActionSystemOptional();
  const dispatch = actionSystem?.dispatch;
  const outputIntegration = useAtomValue(gitOutputIntegrationAtom);
  const commitInstructions = useAtomValue(gitCommitInstructionsAtom);
  const { push, pull, publish } = useGitOperations({
    repoId: selectedRepoId || undefined,
    repoPath,
  });

  const [commitSummary, setCommitSummary] = useState("");
  const [commitDescription, setCommitDescription] = useState("");
  const [commitLoading, setCommitLoading] = useState(false);
  const [generateLoading, setGenerateLoading] = useState(false);

  const clearCommitForm = useCallback(() => {
    setCommitSummary("");
    setCommitDescription("");
  }, []);

  const showMissingRemoteHint = useCallback(() => {
    showGitActionDialogSafely(t("sourceControl.noRemoteForPublish"), "warning");
  }, [t]);

  const ensureConfiguredRemote = useCallback(async (): Promise<boolean> => {
    const hasRemote = await hasConfiguredGitRemote({
      selectedRepoId,
      repoPath,
    });

    if (!hasRemote) {
      showMissingRemoteHint();
    }

    return hasRemote;
  }, [repoPath, selectedRepoId, showMissingRemoteHint]);

  const handleGenerateCommitMessage = useCallback(async () => {
    if (!repoPath) return;
    setGenerateLoading(true);
    try {
      const message = await generateCommitMessage(repoPath, commitInstructions);
      if (message) {
        setCommitSummary(message);
      }
    } catch (error: unknown) {
      showGitActionDialogSafely(
        error instanceof Error ? error.message : String(error),
        "error"
      );
    } finally {
      setGenerateLoading(false);
    }
  }, [repoPath, commitInstructions]);

  const handleCommit = useCallback(async () => {
    await runCommitOperation({
      selectedRepoId,
      repoPath,
      files,
      commitSummary,
      commitDescription,
      outputIntegration,
      dispatch,
      onCommitSuccess,
      setCommitLoading,
      clearCommitForm,
      action: "committed",
      fallbackErrorMessage: "Failed to commit changes",
    });
  }, [
    selectedRepoId,
    repoPath,
    files,
    commitSummary,
    commitDescription,
    outputIntegration,
    dispatch,
    onCommitSuccess,
    clearCommitForm,
  ]);

  const handleCommitAndPush = useCallback(async () => {
    await runCommitOperation({
      selectedRepoId,
      repoPath,
      files,
      commitSummary,
      commitDescription,
      outputIntegration,
      dispatch,
      onCommitSuccess,
      setCommitLoading,
      clearCommitForm,
      action: "committed and pushed",
      fallbackErrorMessage: "Failed to commit and push changes",
      pushed: true,
      afterCommit: async () => {
        const pushResult = await push();
        if (!pushResult.success) {
          throw new Error(`Push failed: ${pushResult.errorType}`);
        }
      },
    });
  }, [
    selectedRepoId,
    repoPath,
    files,
    commitSummary,
    commitDescription,
    outputIntegration,
    dispatch,
    onCommitSuccess,
    clearCommitForm,
    push,
  ]);

  const handleCommitAndPublish = useCallback(async () => {
    await runCommitOperation({
      selectedRepoId,
      repoPath,
      files,
      commitSummary,
      commitDescription,
      outputIntegration,
      dispatch,
      onCommitSuccess,
      setCommitLoading,
      clearCommitForm,
      action: "committed and published",
      fallbackErrorMessage: "Failed to commit and publish changes",
      pushed: true,
      beforeCommit: ensureConfiguredRemote,
      afterCommit: async () => {
        const publishResult = await publish();
        if (!publishResult.success) {
          throw new Error(`Publish failed: ${publishResult.errorType}`);
        }
      },
    });
  }, [
    selectedRepoId,
    repoPath,
    files,
    commitSummary,
    commitDescription,
    outputIntegration,
    dispatch,
    onCommitSuccess,
    setCommitLoading,
    clearCommitForm,
    ensureConfiguredRemote,
    publish,
  ]);

  const handleCommitAndSync = useCallback(async () => {
    await runCommitOperation({
      selectedRepoId,
      repoPath,
      files,
      commitSummary,
      commitDescription,
      outputIntegration,
      dispatch,
      onCommitSuccess,
      setCommitLoading,
      clearCommitForm,
      action: "committed and synced",
      fallbackErrorMessage: "Failed to commit and sync changes",
      pushed: true,
      afterCommit: async () => {
        const pullResult = await pull();
        if (!pullResult.success) {
          throw new Error(`Pull failed: ${pullResult.errorType}`);
        }

        const pushResult = await push();
        if (!pushResult.success) {
          throw new Error(`Push failed: ${pushResult.errorType}`);
        }
      },
    });
  }, [
    selectedRepoId,
    repoPath,
    files,
    commitSummary,
    commitDescription,
    outputIntegration,
    dispatch,
    onCommitSuccess,
    setCommitLoading,
    clearCommitForm,
    pull,
    push,
  ]);

  const handleAmend = useCallback(async () => {
    await runAmendOperation({
      selectedRepoId,
      files,
      commitSummary,
      outputIntegration,
      dispatch,
      onCommitSuccess,
      setCommitLoading,
      clearCommitForm,
    });
  }, [
    selectedRepoId,
    files,
    commitSummary,
    outputIntegration,
    dispatch,
    onCommitSuccess,
    clearCommitForm,
  ]);

  return {
    commitSummary,
    setCommitSummary,
    commitDescription,
    setCommitDescription,
    commitLoading,
    handleCommit,
    handleCommitAndPush,
    handleCommitAndPublish,
    handleCommitAndSync,
    handleAmend,
    generateLoading,
    handleGenerateCommitMessage,
  };
}
