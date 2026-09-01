/**
 * useAddWorkspaceFlow Hook
 *
 * Consolidates the add workspace modal flow used by RepoSelector and SessionSourceSelector.
 * Manages modal stages, form hooks, and provides shared add workspace menu items.
 */
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { FolderAddIcon } from "@src/icons";

import { ICONS } from "../../config";
import type { SpotlightItem } from "../../types";
import { type UseCloneFormReturn, useCloneForm } from "./useCloneForm";
import {
  type UseCreateWorkspaceFormReturn,
  useCreateWorkspaceForm,
} from "./useCreateWorkspaceForm";
import {
  type UseWorkspaceFormReturn,
  useWorkspaceForm,
} from "./useWorkspaceForm";

interface DragDropData {
  initialPath?: unknown;
}

function consumeDragDropInitialPath(): string | undefined {
  const raw = sessionStorage.getItem("dragDropData");
  if (!raw) return undefined;

  sessionStorage.removeItem("dragDropData");
  try {
    const parsed = JSON.parse(raw) as DragDropData;
    return typeof parsed.initialPath === "string"
      ? parsed.initialPath
      : undefined;
  } catch {
    return undefined;
  }
}

function isDirectOpenStage(stage: AddWorkspaceModalStage): boolean {
  return stage === "add-workspace-existing";
}

export type AddWorkspaceModalStage =
  | "add-workspace-new"
  | "add-workspace-clone"
  | "add-workspace-clone-url"
  | "add-workspace-clone-github"
  | "add-workspace-existing"
  | "create-workspace"
  | null;

interface UseAddWorkspaceFlowOptions {
  modalStage: AddWorkspaceModalStage;
  setModalStage: (stage: AddWorkspaceModalStage) => void;
  onSuccess?: (workspaceId?: string) => void | Promise<void>;
  onClose?: () => void;
  onModalClose?: () => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

export interface UseAddWorkspaceFlowReturn {
  localWorkspaceForm: UseWorkspaceFormReturn;
  cloneForm: UseCloneFormReturn;
  multiRepoWorkspaceForm: UseCreateWorkspaceFormReturn;
  addWorkspaceItems: SpotlightItem[];
  getModalSourceLabel: (stage: AddWorkspaceModalStage) => string;
  getModalActionLabel: (stage: AddWorkspaceModalStage) => string;
  handleGoBack: () => void;
  isLoading: boolean;
  actionPathSegment: {
    type: "action";
    id: string;
    label: string;
    icon: SpotlightItem["icon"];
    color: string;
    data: {
      template: string;
      requiredParams: string[];
    };
  };
  getSourceSegment: (stage: AddWorkspaceModalStage) => {
    id: string;
    type: "source";
    label: string;
    icon: SpotlightItem["icon"];
    color: string;
  } | null;
}

export function useAddWorkspaceFlow(
  options: UseAddWorkspaceFlowOptions
): UseAddWorkspaceFlowReturn {
  const { t } = useTranslation();
  const {
    modalStage,
    setModalStage,
    onSuccess,
    onClose: _onClose,
    onModalClose,
    inputRef,
  } = options;

  const { forceRefreshRepos, selectRepo } = useRepoSelection({
    autoLoad: false,
  });

  const localWorkspaceForm = useWorkspaceForm({
    onSuccess: async (workspaceId?: string) => {
      await forceRefreshRepos();
      if (workspaceId) selectRepo(workspaceId);
      setModalStage(null);
      onModalClose?.();
      await onSuccess?.(workspaceId);
    },
    onClose: () => {
      setModalStage(null);
      onModalClose?.();
    },
  });

  const cloneForm = useCloneForm({
    onSuccess: async (workspaceId?: string) => {
      await forceRefreshRepos();
      if (workspaceId) selectRepo(workspaceId);
      setModalStage(null);
      onModalClose?.();
      await onSuccess?.(workspaceId);
    },
    onClose: () => {
      setModalStage(null);
      onModalClose?.();
    },
  });

  const multiRepoWorkspaceForm = useCreateWorkspaceForm({
    onSuccess: () => {
      setModalStage(null);
      onModalClose?.();
    },
    onClose: () => {
      setModalStage(null);
      onModalClose?.();
    },
  });

  const addWorkspaceText = useMemo(
    () => ({
      options: {
        openWorkspace: t("actions.openFolder"),
        createWorkspace: t("selectors.repo.addOptions.createWorkspace"),
        cloneFromGitHub: t("cloneForm.titleCloneFromGitHub"),
        cloneFromGitHubUrl: t("selectors.repo.addOptions.cloneFromGitHubUrl"),
        cloneFromMyGitHub: t("selectors.repo.addOptions.cloneFromMyGitHub"),
        createMultiRepoWorkspace: t(
          "workspaceForm.createWorkspace",
          "Create Multi-repo Workspace"
        ),
      },
      sources: {
        creatingWorkspace: t("selectors.repo.sources.creatingWorkspace"),
        cloningFromGitHub: t("selectors.repo.sources.cloningFromGitHub"),
        cloningFromGitHubUrl: t("selectors.repo.sources.cloningFromGitHubUrl"),
        cloningFromMyGitHub: t("selectors.repo.sources.cloningFromMyGitHub"),
        creatingMultiRepoWorkspace: t(
          "selectors.repo.sources.creatingMultiRepoWorkspace",
          "composing workspace"
        ),
      },
      actionPath: {
        label: t("selectors.repo.path.addBy"),
        template: t("selectors.repo.path.addByTemplate"),
      },
    }),
    [t]
  );

  const addWorkspaceItems = useMemo(
    (): SpotlightItem[] => [
      {
        id: "add-workspace-existing",
        label: addWorkspaceText.options.openWorkspace,
        icon: ICONS.folderOpen,
        type: "repo" as const,
        data: { isSelector: true },
        action: () => void localWorkspaceForm.handleOpenLocalWorkspace(),
      },
      {
        id: "add-workspace-new",
        label: addWorkspaceText.options.createWorkspace,
        icon: ICONS.newRepo,
        type: "repo" as const,
        data: { isSelector: true },
        action: () => setModalStage("add-workspace-new"),
      },
      {
        id: "add-workspace-clone-url",
        label: addWorkspaceText.options.cloneFromGitHubUrl,
        icon: ICONS.cloneRepoUrl,
        type: "repo" as const,
        data: { isSelector: true },
        action: () => setModalStage("add-workspace-clone-url"),
      },
      {
        id: "add-workspace-clone-github",
        label: addWorkspaceText.options.cloneFromMyGitHub,
        icon: ICONS.cloneRepo,
        type: "repo" as const,
        data: { isSelector: true },
        action: () => setModalStage("add-workspace-clone-github"),
      },
    ],
    [addWorkspaceText, localWorkspaceForm, setModalStage]
  );

  const getModalSourceLabel = useCallback(
    (stage: AddWorkspaceModalStage): string => {
      switch (stage) {
        case "add-workspace-new":
          return addWorkspaceText.sources.creatingWorkspace;
        case "add-workspace-clone":
          return addWorkspaceText.sources.cloningFromGitHub;
        case "add-workspace-clone-url":
          return addWorkspaceText.sources.cloningFromGitHubUrl;
        case "add-workspace-clone-github":
          return addWorkspaceText.sources.cloningFromMyGitHub;
        case "create-workspace":
          return addWorkspaceText.sources.creatingMultiRepoWorkspace;
        default:
          return "";
      }
    },
    [addWorkspaceText]
  );

  const getModalActionLabel = useCallback(
    (stage: AddWorkspaceModalStage): string => {
      switch (stage) {
        case "add-workspace-new":
          return addWorkspaceText.options.createWorkspace;
        case "add-workspace-clone":
          return addWorkspaceText.options.cloneFromGitHub;
        case "add-workspace-clone-url":
          return addWorkspaceText.options.cloneFromGitHubUrl;
        case "add-workspace-clone-github":
          return addWorkspaceText.options.cloneFromMyGitHub;
        case "create-workspace":
          return addWorkspaceText.options.createMultiRepoWorkspace;
        default:
          return "";
      }
    },
    [addWorkspaceText]
  );

  const handleGoBack = useCallback(() => {
    setModalStage(null);
  }, [setModalStage]);

  const actionPathSegment = useMemo(
    () => ({
      type: "action" as const,
      id: "add-workspace",
      label: addWorkspaceText.actionPath.label,
      icon: FolderAddIcon,
      color: "",
      data: {
        template: addWorkspaceText.actionPath.template,
        requiredParams: ["source"],
      },
    }),
    [addWorkspaceText]
  );

  const getSourceSegment = useCallback(
    (stage: AddWorkspaceModalStage) => {
      if (!stage) return null;
      const icon =
        stage === "add-workspace-new" ? ICONS.newRepo : FolderAddIcon;
      return {
        id: stage,
        type: "source" as const,
        label: getModalSourceLabel(stage),
        icon,
        color: "",
      };
    },
    [getModalSourceLabel]
  );

  // The form hooks return fresh object identities each render, so effects
  // must read them through this ref instead of listing them as deps — a
  // fresh-object dep re-runs the effect on EVERY render. That exact mistake
  // in the reset effect below once produced a self-sustaining ~1000
  // commits/s loop: resetForm()'s setState batch scheduled another render
  // (React can't eagerly bail a multi-setState batch even when all values
  // are unchanged), which re-created the form objects and re-fired the
  // effect — pegging the webview at ~90% CPU whenever a closed
  // WorkspacePalette was mounted (e.g. the session-creator repo pill).
  const formsRef = useRef({
    localWorkspaceForm,
    cloneForm,
    multiRepoWorkspaceForm,
  });
  useEffect(() => {
    formsRef.current = {
      localWorkspaceForm,
      cloneForm,
      multiRepoWorkspaceForm,
    };
  });

  useEffect(() => {
    if (!isDirectOpenStage(modalStage)) return;

    const initialPath = consumeDragDropInitialPath();
    setModalStage(null);
    void formsRef.current.localWorkspaceForm.handleOpenLocalWorkspace(
      initialPath
    );
  }, [modalStage, setModalStage]);

  // Reset the forms when the modal CLOSES (stage transitions to null) — not
  // on every render while it is closed (see formsRef comment above).
  const prevModalStageRef = useRef<AddWorkspaceModalStage>(modalStage);

  useEffect(() => {
    const previousStage = prevModalStageRef.current;
    prevModalStageRef.current = modalStage;
    if (modalStage === null && previousStage !== null) {
      formsRef.current.localWorkspaceForm.resetForm();
      formsRef.current.cloneForm.resetForm();
      formsRef.current.multiRepoWorkspaceForm.resetForm();
    }
  }, [modalStage]);

  const hasAttemptedGitHubFetchRef = useRef(false);
  const cloneFormReposLength = cloneForm.repositories.length;
  const cloneFormIsLoading = cloneForm.isLoadingRepos;
  const cloneFormFetchRepos = cloneForm.fetchGitHubRepos;

  useEffect(() => {
    const needsGitHubFetch =
      modalStage === "add-workspace-clone-github" ||
      (modalStage === "add-workspace-clone" && cloneForm.subTab === "myGitHub");
    if (!needsGitHubFetch) {
      hasAttemptedGitHubFetchRef.current = false;
      return;
    }
    if (
      cloneFormReposLength === 0 &&
      !cloneFormIsLoading &&
      !hasAttemptedGitHubFetchRef.current &&
      cloneFormFetchRepos
    ) {
      hasAttemptedGitHubFetchRef.current = true;
      cloneFormFetchRepos();
    }
  }, [
    modalStage,
    cloneForm.subTab,
    cloneFormReposLength,
    cloneFormIsLoading,
    cloneFormFetchRepos,
  ]);

  useEffect(() => {
    if (!modalStage && inputRef?.current) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [modalStage, inputRef]);

  return {
    localWorkspaceForm,
    cloneForm,
    multiRepoWorkspaceForm,
    addWorkspaceItems,
    getModalSourceLabel,
    getModalActionLabel,
    handleGoBack,
    isLoading:
      localWorkspaceForm.loading ||
      cloneForm.isLoadingRepos ||
      multiRepoWorkspaceForm.loading,
    actionPathSegment,
    getSourceSegment,
  };
}

export default useAddWorkspaceFlow;
