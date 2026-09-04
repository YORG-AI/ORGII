/**
 * AddWorkspaceModalShell Component
 *
 * Shared modal shell for the add workspace flow used by WorkspacePalette.
 */
import React from "react";

import { SpotlightSearchBar } from "../components";
import type {
  AddWorkspaceModalStage,
  UseAddWorkspaceFlowReturn,
} from "../hooks/forms/useAddWorkspaceFlow";
import { SpotlightShell } from "../shell";
import { SpotlightModalView } from "../views";

interface AddWorkspaceModalShellProps {
  isOpen: boolean;
  onClose: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  modalStage: AddWorkspaceModalStage;
  addWorkspaceFlow: UseAddWorkspaceFlowReturn;
  currentRepoId?: string;
  onGoBack?: () => void;
  asBody?: boolean;
}

export const AddWorkspaceModalShell: React.FC<AddWorkspaceModalShellProps> = ({
  isOpen,
  onClose,
  inputRef,
  handleKeyDown,
  modalStage,
  addWorkspaceFlow,
  currentRepoId,
  onGoBack,
  asBody = false,
}) => {
  if (!modalStage) return null;

  const rawSourceSegment = addWorkspaceFlow.getSourceSegment(modalStage);
  if (!rawSourceSegment) return null;

  const sourceSegment = {
    ...rawSourceSegment,
    icon: rawSourceSegment.icon ?? "",
  };

  const searchPath = [
    {
      ...sourceSegment,
      type: "action" as const,
      label: addWorkspaceFlow.getModalActionLabel(modalStage),
      icon: rawSourceSegment.icon ?? "",
    },
  ];

  const body = (
    <>
      <SpotlightSearchBar
        inputRef={inputRef}
        searchQuery=""
        onSearchQueryChange={() => {}}
        onKeyDown={handleKeyDown}
        placeholder=""
        isLoading={addWorkspaceFlow.isLoading}
        isCountingDown={false}
        hideActionClose={false}
        hideInput
        path={searchPath}
        onRemoveSegment={(index) => {
          if (index === 0) (onGoBack ?? onClose)();
          if (index === 1) addWorkspaceFlow.handleGoBack();
        }}
      />
      <SpotlightModalView
        sourceSegment={sourceSegment}
        localWorkspaceForm={addWorkspaceFlow.localWorkspaceForm}
        cloneForm={addWorkspaceFlow.cloneForm}
        multiRepoWorkspaceForm={addWorkspaceFlow.multiRepoWorkspaceForm}
        currentRepoId={currentRepoId}
        onCancel={onGoBack ?? addWorkspaceFlow.handleGoBack}
      />
    </>
  );

  if (asBody) return body;

  return (
    <SpotlightShell
      isOpen={isOpen}
      onClose={onClose}
      stopPropagation
      hasActiveAction
    >
      {body}
    </SpotlightShell>
  );
};
