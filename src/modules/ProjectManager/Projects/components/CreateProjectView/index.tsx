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

import { type ProjectOrg, projectApi } from "@src/api/http/project";
import Message from "@src/components/Message";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import LaunchButton from "@src/features/SessionCreator/components/LaunchButton";
import { useKeyboardSave } from "@src/hooks/keyboard";
import { createLogger } from "@src/hooks/logger";
import { useUndoStackWithRestore } from "@src/hooks/ui";
import {
  CreateComposerAgentFrame,
  CreateComposerHeader,
  CreateComposerPinnedActions,
  CreateComposerTitleInput,
  DetailSplitLayout,
  type LinkedRepoOption,
  ManualCreateComposer,
  PROJECT_PROPERTY_CONCISE_FIELDS,
  ProjectContentEditor,
  type ProjectContentEditorRef,
  type ProjectData,
  ProjectPropertyFields,
} from "@src/modules/ProjectManager/shared";
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

import { filterSelectableProjectOrgs } from "../../../projectOrgVisibility";

// ============================================
// Types
// ============================================

export interface CreateProjectViewProps {
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
  /** Native ORGII org that owns the created project. */
  orgId: string;
  /** Mark this tab as having unsaved changes */
  onSetUnsaved: (hasUnsaved: boolean) => void;
  /** Called after project is successfully created */
  onProjectCreated: (options?: { keepOpen?: boolean }) => void;
  /** Show the Agent composer instead of the manual Project composer. */
  aiGenerateMode?: boolean;
  /** Center the creator composer within the available launcher space. */
  centerLauncherContent?: boolean;
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

const CreateProjectView: React.FC<CreateProjectViewProps> = ({
  tabId,
  repoPath,
  repoName,
  scopeBreadcrumbLabel,
  orgId,
  onSetUnsaved,
  onProjectCreated,
  aiGenerateMode = false,
  centerLauncherContent = false,
  renderAgentComposer,
  publishHeaderToWorkstation = false,
}) => {
  const { t } = useTranslation("projects");
  const [saving, setSaving] = useState(false);
  const [availableOrgs, setAvailableOrgs] = useState<ProjectOrg[]>([]);
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);

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
      initial.orgId = orgId;
      if (repoPath) initial.linkedRepoPaths = [repoPath];
      setDraft({ tabId, draft: initial });
      initialisedRef.current = true;
    }
  }, [tabId, draftsMap, setDraft, repoPath, orgId]);

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

      await projectApi.writeProject(
        slug,
        {
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
        },
        description,
        true
      );

      await emit("orgii-data-changed");
      removeDraft(tabId);
      onProjectCreated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Failed to create project", err);
      Message.error(msg);
    } finally {
      setSaving(false);
    }
  }, [draft, onProjectCreated, removeDraft, saving, tabId]);

  useKeyboardSave(
    handleCreate,
    !aiGenerateMode && !saving && !!draft.name.trim()
  );

  const selectableOrgs = useMemo(
    () => filterSelectableProjectOrgs(availableOrgs, cloudOrgs),
    [availableOrgs, cloudOrgs]
  );

  useEffect(() => {
    if (availableOrgs.length === 0 || !draft.orgId) return;
    if (selectableOrgs.some((org) => org.id === draft.orgId)) return;
    patchDraft({ tabId, patch: { orgId: "personal-org" } });
  }, [availableOrgs.length, draft.orgId, patchDraft, selectableOrgs, tabId]);

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
      updateDraft({ orgId: String(value) });
    },
    [updateDraft]
  );

  const orgBreadcrumbPill = (
    <Select
      value={draft.orgId}
      options={orgOptions}
      onChange={handleOrgChange}
      placeholder={selectedOrgLabel}
      size="small"
      radius="pill"
      showSearch
      dropdownWidthMode="min-match"
      dropdownMinWidth={220}
      panelZIndex={10000}
      dataTestId="create-project-org-select"
      className="w-auto max-w-[220px] [&_.select-selector]:!h-7 [&_.select-selector]:!rounded-full [&_.select-selector]:!bg-bg-2 [&_.select-selector]:!px-3 [&_.select-selector]:!text-[13px] [&_.select-selector]:!font-medium [&_.select-selector]:!shadow-none [&_.select-suffix]:!hidden"
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
        visibleFields={PROJECT_PROPERTY_CONCISE_FIELDS}
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
      {orgBreadcrumbPill}
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
      descriptionClassName="no-bottom-border [&_.ProseMirror]:!pl-1.5"
      descriptionMaxHeight="100%"
      repoPath={repoPath}
      className="flex min-h-0 flex-1 flex-col"
      dataTestId="create-project-editor"
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
          centered={centerLauncherContent}
          centeredDataTestId="create-project-centered-launcher"
        >
          {aiGenerateMode && renderAgentComposer ? (
            <CreateComposerAgentFrame centered={centerLauncherContent}>
              {renderAgentComposer(composerHeaderContent, projectPinnedActions)}
            </CreateComposerAgentFrame>
          ) : (
            <ManualCreateComposer
              centered={centerLauncherContent}
              dataTestId="create-project-manual-composer"
              editorRef={editorRef}
              headerContent={composerHeaderContent}
              editorContent={projectEditor}
              pinnedActionsContent={projectPinnedActions}
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
