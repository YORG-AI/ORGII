/**
 * CreateProjectView Component
 *
 * Project creation form reused by Project Manager Chat Panel and embedded create flows.
 * Draft state is cached in a jotai atom keyed by tabId, so callers can preserve
 * unsaved form data while the create surface remains mounted.
 *
 * Handles its own centralized project-store write logic so the layout doesn't need
 * to pass persistence callbacks.
 *
 * The manual and Agent variants share the same composer structure as Work Item
 * creation: title header, editor body, pinned property pills, and submit bar.
 */
import { emit } from "@tauri-apps/api/event";
import { useAtomValue, useSetAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  type ProjectOrg,
  projectApi,
  projectDataToUI,
} from "@src/api/http/project";
import Message from "@src/components/Message";
import type { SelectOption } from "@src/components/Select";
import { INPUT_AREA_EDITOR_HEIGHT } from "@src/config/inputAreaTokens";
import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { sidebarSelectedOrgIdAtom } from "@src/features/Organizations/sidebarOrgScopeAtom";
import LaunchButton from "@src/features/SessionCreator/components/LaunchButton";
import { useKeyboardSave } from "@src/hooks/keyboard";
import { createLogger } from "@src/hooks/logger";
import { useUndoStackWithRestore } from "@src/hooks/ui";
import {
  CreateComposerHeader,
  CreateComposerPinnedActions,
  CreateComposerTitleInput,
  DetailSplitLayout,
  type LinkedRepoOption,
  ManualCreateComposer,
  ProjectContentEditor,
  type ProjectContentEditorRef,
  type ProjectData,
  ProjectOrganizationSelect,
  ProjectPropertyFields,
  type ProjectPropertyFieldsProps,
} from "@src/modules/ProjectManager/shared";
import type { MarkdownEditorMode } from "@src/modules/shared/components/MarkdownTextareaEditor";
import MarkdownEditorModeSwitch from "@src/modules/shared/components/MarkdownTextareaEditor/ModeSwitch";
import { CreatorContentLayout } from "@src/modules/shared/layouts/blocks";
import { reposAtom } from "@src/store/repo";
import {
  type ProjectDraft,
  createDefaultProjectDraft,
  patchProjectDraftAtom,
  projectDraftsAtom,
  removeProjectDraftAtom,
  setProjectDraftAtom,
} from "@src/store/workstation/projectManager";
import type { Project } from "@src/types/core/project";

import {
  filterSelectableProjectOrgs,
  resolveDefaultProjectOrgId,
} from "../../../projectOrgVisibility";

// ============================================
// Types
// ============================================

export interface CreatedProjectResult {
  project: Project;
  projectSlug: string;
  orgId: string;
  orgName?: string;
}

interface CreateProjectViewProps {
  /** Tab ID used to key the draft cache */
  tabId: string;
  /**
   * Optional repo path the project is being created from. When provided,
   * it's pre-selected in the linked-repos field; the user can still add
   * more or remove it. When omitted, the project starts with no linked
   * repo — fully supported by the backend.
   */
  repoPath?: string;
  /** Repository name used only for linked repo fallback labels. */
  repoName?: string;
  /** Scope label for breadcrumb display. */
  scopeBreadcrumbLabel?: string;
  /** Optional scoped-surface org; otherwise the global sidebar org is used. */
  orgId?: string;
  /** Mark this tab as having unsaved changes */
  onSetUnsaved: (hasUnsaved: boolean) => void;
  /** Called after project is successfully created */
  onProjectCreated: (result: CreatedProjectResult) => void;
  /** Show the Agent composer instead of the manual Project composer. */
  aiGenerateMode?: boolean;
  /** Optional content centered in the page above the bottom-docked manual composer. */
  middleContent?: React.ReactNode;
  /** Agent/Manual segmented control rendered with the creator setup pills. */
  creatorModeControl?: React.ReactNode;
  /** Render Session Creator in Agent mode with Project fields in its composer. */
  renderAgentComposer?: (
    headerContent: React.ReactNode,
    pinnedActionsContent: React.ReactNode
  ) => React.ReactNode;
  /** Publish page header into the global WorkstationTabHeader. */
  publishHeaderToWorkstation?: boolean;
}

// ============================================
// Component
// ============================================

const logger = createLogger("CreateProjectView");

// Match Work Item creation: keep the essentials inline and the rest in More.
const CREATE_PROJECT_INLINE_FIELDS = [
  "status",
  "priority",
] satisfies ProjectPropertyFieldsProps["visibleFields"];

const CreateProjectView: React.FC<CreateProjectViewProps> = ({
  tabId,
  repoPath,
  repoName,
  scopeBreadcrumbLabel,
  orgId,
  onSetUnsaved,
  onProjectCreated,
  aiGenerateMode = false,
  middleContent,
  creatorModeControl,
  renderAgentComposer,
  publishHeaderToWorkstation = false,
}) => {
  const { t } = useTranslation("projects");
  const [saving, setSaving] = useState(false);
  const [editorMode, setEditorMode] = useState<MarkdownEditorMode>("write");
  const [availableOrgs, setAvailableOrgs] = useState<ProjectOrg[]>([]);
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const globalOrgSelectorValue = useAtomValue(sidebarSelectedOrgIdAtom);

  // Read draft from atom (survives tab switches)
  const draftsMap = useAtomValue(projectDraftsAtom);
  const draft = draftsMap.get(tabId) ?? createDefaultProjectDraft();
  const setDraft = useSetAtom(setProjectDraftAtom);
  const patchDraft = useSetAtom(patchProjectDraftAtom);
  const removeDraft = useSetAtom(removeProjectDraftAtom);

  // Available repos for the linked-repos picker. Sourced from the global
  // repo store so the picker shows every workspace repo the user has — not
  // just the one we entered the project manager from.
  const repos = useAtomValue(reposAtom);
  const availableRepos = useMemo<LinkedRepoOption[]>(
    () =>
      repos
        .map((repo) => ({
          id: repo.path ?? repo.fs_uri ?? repo.id,
          name: repo.name || repo.path || repo.id,
        }))
        .filter((repo) => repo.id),
    [repos]
  );

  // Track whether we've initialised the draft atom for this tab
  const initialisedRef = useRef(false);
  useEffect(() => {
    if (!initialisedRef.current && !draftsMap.has(tabId)) {
      const initial = createDefaultProjectDraft();
      if (repoPath) initial.linkedRepoPaths = [repoPath];
      setDraft({ tabId, draft: initial });
      initialisedRef.current = true;
    }
  }, [tabId, draftsMap, setDraft, repoPath]);

  useEffect(() => {
    let cancelled = false;

    const loadOrgs = async () => {
      const orgs = await projectApi.readOrgs();
      if (!cancelled) setAvailableOrgs(orgs);
    };

    void loadOrgs();
    return () => {
      cancelled = true;
    };
  }, []);

  const editorRef = useRef<ProjectContentEditorRef>(null);
  const propertiesRef = useRef<HTMLDivElement>(null);

  const undoStack = useUndoStackWithRestore<ProjectDraft>({
    keyboardShortcut: true,
    currentValue: draft,
    onRestore: (prev) => setDraft({ tabId, draft: prev }),
  });

  // Helpers to persist draft + mark tab dirty
  const updateDraft = useCallback(
    (updates: Partial<ProjectDraft>) => {
      undoStack.snapshot(draft);
      patchDraft({ tabId, patch: updates });
      onSetUnsaved(true);
    },
    [draft, tabId, patchDraft, onSetUnsaved, undoStack]
  );

  // Field handlers
  const handleTitleChange = useCallback(
    (name: string) => updateDraft({ name }),
    [updateDraft]
  );

  const handleDescriptionChange = useCallback(
    (markdown: string, _text: string) => updateDraft({ description: markdown }),
    [updateDraft]
  );

  const handleProjectUpdate = useCallback(
    (updates: Partial<ProjectData>) => {
      const mapped: Partial<ProjectDraft> = {};
      if (updates.status !== undefined) mapped.status = updates.status;
      if (updates.priority !== undefined) mapped.priority = updates.priority;
      if (updates.health !== undefined) mapped.health = updates.health;
      if (updates.lead !== undefined) mapped.leadId = updates.lead?.id;
      if (updates.members !== undefined)
        mapped.memberIds = updates.members?.map((member) => member.id) || [];
      if (updates.teams !== undefined)
        mapped.teamIds = updates.teams?.map((team) => team.id) || [];
      if (updates.labels !== undefined)
        mapped.labelIds = updates.labels?.map((label) => label.id) || [];
      if (updates.linkedRepos !== undefined)
        mapped.linkedRepoPaths =
          updates.linkedRepos?.map((repo) => repo.id) || [];
      if (updates.startDate !== undefined) mapped.startDate = updates.startDate;
      if (updates.targetDate !== undefined)
        mapped.targetDate = updates.targetDate;
      updateDraft(mapped);
    },
    [updateDraft]
  );

  // Build a name lookup for repo paths so `projectData.linkedRepos` shows
  // friendly labels in the picker chip even before the global repo list
  // reloads (e.g. when entered from a repo we've cached but not yet listed).
  const repoNameByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const repo of availableRepos) map.set(repo.id, repo.name);
    if (repoPath && repoName) map.set(repoPath, repoName);
    return map;
  }, [availableRepos, repoPath, repoName]);

  // Build ProjectData for the PropertiesPanel from the flat draft
  const projectData: ProjectData = {
    id: "",
    name: draft.name,
    status: draft.status as ProjectData["status"],
    priority: draft.priority as ProjectData["priority"],
    health: draft.health as ProjectData["health"],
    lead: draft.leadId ? { id: draft.leadId, name: "" } : undefined,
    members: draft.memberIds.map((id) => ({ id, name: "" })),
    teams: draft.teamIds.map((id) => ({ id, name: "" })),
    labels: draft.labelIds.map((id) => ({ id, name: "", color: "" })),
    linkedRepos: draft.linkedRepoPaths.map((path) => ({
      id: path,
      name: repoNameByPath.get(path) ?? path,
    })),
    startDate: draft.startDate,
    targetDate: draft.targetDate,
  };

  const handleCreate = useCallback(async () => {
    if (!draft.name.trim() || saving) return;

    setSaving(true);
    try {
      const name = draft.name.trim();
      const description = editorRef.current?.getMarkdown()?.trim() ?? "";

      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const now = new Date().toISOString();
      const workItemPrefix = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
      const normalizedWorkItemPrefix = workItemPrefix
        ? workItemPrefix.slice(0, 3).padEnd(3, "X")
        : "PRJ";

      const meta = {
        id: `proj-${slug}`,
        name,
        org_id: draft.orgId,
        status: draft.status || "backlog",
        priority: draft.priority || "none",
        health: draft.health || "no_updates",
        lead: draft.leadId,
        members: draft.memberIds,
        labels: draft.labelIds,
        linked_repos: draft.linkedRepoPaths,
        start_date: draft.startDate,
        target_date: draft.targetDate,
        created_at: now,
        updated_at: now,
        next_work_item_id: 1,
        work_item_prefix: normalizedWorkItemPrefix,
        work_item_prefix_custom: false,
      };

      await projectApi.writeProject(slug, meta, description, true);

      await emit("orgii-data-changed");
      removeDraft(tabId);
      onProjectCreated({
        project: projectDataToUI(
          { meta, description, slug },
          { labelMap: new Map(), memberMap: new Map() }
        ),
        projectSlug: slug,
        orgId: meta.org_id,
        orgName:
          availableOrgs.find((org) => org.id === meta.org_id)?.name ??
          (meta.org_id === orgId ? scopeBreadcrumbLabel : undefined),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Failed to create project", err);
      Message.error(msg);
    } finally {
      setSaving(false);
    }
  }, [
    availableOrgs,
    draft,
    onProjectCreated,
    orgId,
    removeDraft,
    saving,
    scopeBreadcrumbLabel,
    tabId,
  ]);

  useKeyboardSave(
    handleCreate,
    !aiGenerateMode && !saving && !!draft.name.trim()
  );

  const selectableOrgs = useMemo(
    () => filterSelectableProjectOrgs(availableOrgs, cloudOrgs),
    [availableOrgs, cloudOrgs]
  );

  const defaultOrgId = useMemo(
    () =>
      resolveDefaultProjectOrgId(
        orgId,
        globalOrgSelectorValue,
        availableOrgs,
        selectableOrgs
      ),
    [availableOrgs, globalOrgSelectorValue, orgId, selectableOrgs]
  );

  useEffect(() => {
    if (availableOrgs.length === 0) return;
    const selectedOrgIsValid = selectableOrgs.some(
      (org) => org.id === draft.orgId
    );
    const followsDefault = draft.orgSelectionMode !== "manual";
    if (
      selectedOrgIsValid &&
      (!followsDefault || draft.orgId === defaultOrgId)
    ) {
      return;
    }
    patchDraft({
      tabId,
      patch: { orgId: defaultOrgId, orgSelectionMode: "auto" },
    });
  }, [
    availableOrgs.length,
    defaultOrgId,
    draft.orgId,
    draft.orgSelectionMode,
    patchDraft,
    selectableOrgs,
    tabId,
  ]);

  const orgOptions = useMemo<SelectOption[]>(
    () =>
      selectableOrgs.map((org) => ({
        value: org.id,
        label: org.name,
        triggerLabel: org.name,
        dataTestId: `create-project-org-option-${org.id}`,
      })),
    [selectableOrgs]
  );

  const selectedOrgLabel =
    orgOptions.find((option) => option.value === draft.orgId)?.triggerLabel ??
    scopeBreadcrumbLabel ??
    draft.orgId;

  const handleOrgChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (Array.isArray(value)) return;
      updateDraft({ orgId: String(value), orgSelectionMode: "manual" });
    },
    [updateDraft]
  );

  const orgTrailSelect = (
    <ProjectOrganizationSelect
      value={draft.orgId}
      options={orgOptions}
      onChange={handleOrgChange}
      placeholder={selectedOrgLabel}
      placement="top"
      dataTestId="create-project-org-select"
    />
  );

  const propertyPills = (
    <div ref={propertiesRef}>
      <ProjectPropertyFields
        project={projectData}
        onUpdate={handleProjectUpdate}
        availableRepos={availableRepos}
        containerRef={propertiesRef}
        fieldVariant="pill"
        visibleFields={CREATE_PROJECT_INLINE_FIELDS}
        showMoreMenu
      />
    </div>
  );

  const titleSection = (
    <CreateComposerTitleInput
      value={draft.name}
      onChange={handleTitleChange}
      placeholder={t("projects.editor.titlePlaceholder")}
      dataTestId="create-project-title-input"
    />
  );

  const composerHeaderContent = (
    <CreateComposerHeader dataTestId="create-project-composer-header">
      {titleSection}
    </CreateComposerHeader>
  );

  const projectPinnedActions = (
    <CreateComposerPinnedActions dataTestId="create-project-pinned-actions">
      {creatorModeControl}
      {orgTrailSelect}
      {propertyPills}
    </CreateComposerPinnedActions>
  );

  const projectEditor = (
    <ProjectContentEditor
      ref={editorRef}
      title={draft.name}
      onTitleChange={handleTitleChange}
      initialDescription={draft.description || undefined}
      onDescriptionChange={handleDescriptionChange}
      titleVisible={false}
      separatorVisible={false}
      descriptionClassName="no-bottom-border [&_textarea]:!pl-1.5 [&_textarea]:!text-[14px]"
      autoFocusDescription
      descriptionMinRows={2}
      descriptionMinHeight={INPUT_AREA_EDITOR_HEIGHT.min}
      descriptionMaxHeight={INPUT_AREA_EDITOR_HEIGHT.max}
      descriptionMode={editorMode}
      onDescriptionModeChange={setEditorMode}
      repoPath={repoPath}
      className="flex min-h-0 flex-1 flex-col"
      dataTestId="create-project-editor"
      dropdownDirection="up"
    />
  );

  return (
    <DetailSplitLayout
      title={t("projects.newProject")}
      borderlessHeader
      hideHeader
      publishHeaderToWorkstation={publishHeaderToWorkstation}
      leftContent={
        <CreatorContentLayout
          placement={aiGenerateMode && renderAgentComposer ? "fill" : "bottom"}
          contentDataTestId="create-project-creator-content"
          middleContent={middleContent}
        >
          {aiGenerateMode && renderAgentComposer ? (
            renderAgentComposer(composerHeaderContent, projectPinnedActions)
          ) : (
            <ManualCreateComposer
              dataTestId="create-project-manual-composer"
              editorRef={editorRef}
              headerContent={composerHeaderContent}
              editorContent={projectEditor}
              pinnedActionsContent={projectPinnedActions}
              pills={
                <MarkdownEditorModeSwitch
                  mode={editorMode}
                  onModeChange={setEditorMode}
                  disabled={saving}
                  dataTestId="create-project-description-mode-switch"
                />
              }
              submitButton={
                <LaunchButton
                  ariaLabel={t("projects.createProject")}
                  dataTestId="create-project-submit"
                  disabled={!draft.name.trim() || saving}
                  loading={saving}
                  onClick={() => {
                    void handleCreate();
                  }}
                />
              }
            />
          )}
        </CreatorContentLayout>
      }
    />
  );
};

export default CreateProjectView;
