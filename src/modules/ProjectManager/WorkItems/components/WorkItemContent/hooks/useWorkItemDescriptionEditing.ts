/**
 * useWorkItemDescriptionEditing
 *
 * Draft / save / cancel state for the Work Item description. The draft is
 * keyed by Work Item id so switching items never leaks another item's edit,
 * and GitHub-backed items save through their own body-update command.
 */
import { useState } from "react";

import type { MarkdownEditorMode } from "@src/modules/shared/components/MarkdownTextareaEditor";

import type { GitHubIssueInteractionConfig } from "../types";

export interface UseWorkItemDescriptionEditingOptions {
  workItemId: string;
  /** Description currently rendered for this Work Item. */
  displayedDescription: string;
  isGitHubWorkItem: boolean;
  githubIssueInteraction?: GitHubIssueInteractionConfig;
  /** Persist path for project-backed Work Items. */
  onCommitDescription: (markdown: string) => void;
}

export function useWorkItemDescriptionEditing({
  workItemId,
  displayedDescription,
  isGitHubWorkItem,
  githubIssueInteraction,
  onCommitDescription,
}: UseWorkItemDescriptionEditingOptions) {
  const [descriptionDraftState, setDescriptionDraftState] = useState<{
    workItemId: string;
    base: string;
    value: string;
  } | null>(null);
  const [descriptionEditWorkItemId, setDescriptionEditWorkItemId] = useState<
    string | null
  >(null);
  const [descriptionSaveErrorWorkItemId, setDescriptionSaveErrorWorkItemId] =
    useState<string | null>(null);
  const [descriptionEditorMode, setDescriptionEditorMode] =
    useState<MarkdownEditorMode>("write");

  const currentDescriptionDraft =
    descriptionDraftState?.workItemId === workItemId
      ? descriptionDraftState
      : null;
  const descriptionHasChanges = Boolean(
    currentDescriptionDraft &&
    currentDescriptionDraft.value !== currentDescriptionDraft.base
  );
  const descriptionDraft =
    currentDescriptionDraft && descriptionHasChanges
      ? currentDescriptionDraft.value
      : displayedDescription;

  const handleDescriptionDraftChange = (markdown: string) => {
    setDescriptionSaveErrorWorkItemId(null);
    setDescriptionDraftState((current) => {
      if (current?.workItemId === workItemId) {
        return { ...current, value: markdown };
      }
      return {
        workItemId,
        base: displayedDescription,
        value: markdown,
      };
    });
  };

  const handleCancelDescription = () => {
    setDescriptionDraftState(null);
    setDescriptionEditWorkItemId(null);
    setDescriptionSaveErrorWorkItemId(null);
  };

  const handleSaveDescription = async () => {
    if (!descriptionHasChanges) return;
    if (isGitHubWorkItem) {
      if (
        !githubIssueInteraction?.canEditBody ||
        githubIssueInteraction.updatingBody
      ) {
        return;
      }
      try {
        await githubIssueInteraction.onUpdateBody(descriptionDraft);
        setDescriptionDraftState(null);
        setDescriptionEditWorkItemId(null);
        setDescriptionSaveErrorWorkItemId(null);
      } catch {
        setDescriptionSaveErrorWorkItemId(workItemId);
      }
      return;
    }
    onCommitDescription(descriptionDraft);
    setDescriptionDraftState(null);
    setDescriptionEditWorkItemId(null);
    setDescriptionSaveErrorWorkItemId(null);
  };

  const beginDescriptionEdit = () => {
    setDescriptionSaveErrorWorkItemId(null);
    setDescriptionEditWorkItemId(workItemId);
  };

  return {
    descriptionDraft,
    descriptionHasChanges,
    descriptionEditWorkItemId,
    descriptionSaveErrorWorkItemId,
    descriptionEditorMode,
    setDescriptionEditorMode,
    handleDescriptionDraftChange,
    handleCancelDescription,
    handleSaveDescription,
    beginDescriptionEdit,
  };
}
