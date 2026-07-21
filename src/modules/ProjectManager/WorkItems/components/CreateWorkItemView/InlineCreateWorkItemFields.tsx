import { BookOpen, Building2, ChevronRight } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { type ProjectOrg, projectApi } from "@src/api/http/project";
import Input from "@src/components/Input";
import { PropertyDropdownField } from "@src/components/PropertyField/PropertyDropdownField";
import type { PropertyDropdownOption } from "@src/components/PropertyField/PropertyDropdownField";
import { createLogger } from "@src/hooks/logger";
import {
  mapWorkItemUpdatesToDraftPatch,
  useWorkItemCreatorDraft,
  useWorkItemImageInsert,
  workItemDraftToStubWorkItem,
} from "@src/hooks/project";
import { useUndoStackWithRestore } from "@src/hooks/ui";
import { useAgentDefinitions } from "@src/modules/MainApp/AgentOrgs/hooks/useAgentDefinitions";
import { useAgentOrgs } from "@src/modules/MainApp/AgentOrgs/hooks/useAgentOrgs";
import type {
  AgentDefinition,
  OrgMember,
} from "@src/modules/MainApp/AgentOrgs/types";
import {
  ProjectContentEditor,
  type ProjectContentEditorRef,
} from "@src/modules/ProjectManager/shared";
import { PROJECT_MANAGER_TEXT_PLACEHOLDER_CLASS } from "@src/modules/ProjectManager/shared/placeholderTokens";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";
import type { Person } from "@src/types/core/shared";
import type {
  WorkItem as WorkItemExtended,
  WorkItemLabel,
  WorkItemMilestone,
  WorkItemProject,
} from "@src/types/core/workItem";

import WorkItemContentStack from "../WorkItemContentStack";
import WorkItemProperties from "../WorkItemProperties";
import type { WorkItemPropertyFieldKey } from "../WorkItemProperties/types";

interface CreateWorkItemProjectOption extends WorkItemProject {
  slug?: string;
  orgId?: string;
}

export const CREATE_WORK_ITEM_VISIBLE_FIELDS: WorkItemPropertyFieldKey[] = [
  "project",
  "status",
  "priority",
  "assignee",
  "reviewer",
  "milestone",
  "startDate",
  "date",
  "labels",
];

export const CREATE_WORK_ITEM_INLINE_FIELDS: WorkItemPropertyFieldKey[] = [
  "status",
  "priority",
];

const CREATE_WORK_ITEM_BREADCRUMB_ICON_SIZE = 13;
const logger = createLogger("InlineCreateWorkItemFields");

export interface InlineCreateWorkItemFieldsState {
  descriptionSection: React.ReactNode;
  draft: WorkItemDraft;
  editorResetKey: number;
  editorRef: React.RefObject<ProjectContentEditorRef | null>;
  availableAgents: AgentDefinition[];
  availableOrgs: OrgMember[];
  handlePropertyUpdate: (updates: Partial<WorkItemExtended>) => void;
  inlinePropertyPills?: React.ReactNode;
  resetDraftForCreateMore: () => void;
  resolvedLabels: WorkItemLabel[];
  resolvedMembers: Person[];
  resolvedProjects: CreateWorkItemProjectOption[];
  selectedProjectSlug?: string;
  clearDraft: () => void;
  setDraft: (draft: WorkItemDraft) => void;
  showManualInputs: boolean;
  stubWorkItem: WorkItemExtended;
  titleSection: React.ReactNode;
  updateDraft: (patch: Partial<WorkItemDraft>) => void;
  workItemPillBreadcrumb: React.ReactNode;
}

export interface UseInlineCreateWorkItemFieldsOptions {
  aiGenerateMode?: boolean;
  availableLabels?: WorkItemLabel[];
  availableMembers?: Person[];
  availableMilestones?: WorkItemMilestone[];
  availableProjects?: WorkItemProject[];
  chatPanelFooter?: boolean;
  defaultProjectId?: string;
  onDraftChange?: (draft: WorkItemDraft) => void;
  onSetUnsaved: (hasUnsaved: boolean) => void;
  orgId?: string | null;
  propertiesOpen?: boolean;
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
  repoPath?: string | null;
  scopeBreadcrumbLabel?: string;
}

export function useInlineCreateWorkItemFields({
  aiGenerateMode = false,
  availableLabels = [],
  availableMembers = [],
  availableMilestones = [],
  availableProjects = [],
  chatPanelFooter = false,
  defaultProjectId,
  onDraftChange,
  onSetUnsaved,
  orgId: surfaceOrgId,
  propertiesOpen = false,
  projectId,
  projectName,
  projectSlug,
  repoPath,
  scopeBreadcrumbLabel,
}: UseInlineCreateWorkItemFieldsOptions): InlineCreateWorkItemFieldsState {
  const { t } = useTranslation("projects");
  const { t: tSessions } = useTranslation("sessions");
  const [editorResetKey, setEditorResetKey] = useState(0);
  const { agents: customAgents } = useAgentDefinitions();
  const { orgs: availableOrgs } = useAgentOrgs();
  const [loadedMembers, setLoadedMembers] = useState<Person[]>([]);
  const [loadedProjects, setLoadedProjects] = useState<
    CreateWorkItemProjectOption[]
  >([]);
  const [projectOrgs, setProjectOrgs] = useState<ProjectOrg[]>([]);
  const [loadedProjectSlugById, setLoadedProjectSlugById] = useState<
    Record<string, string>
  >({});
  const [loadedLabels, setLoadedLabels] = useState<WorkItemLabel[]>([]);

  const { draft, updateDraft, setDraft, resetDraft, clearDraft } =
    useWorkItemCreatorDraft({
      seedProjectId: projectId,
      defaultProjectId,
      onSetUnsaved,
    });

  const selectedProjectSlug =
    draft.projectId && draft.projectId === projectId
      ? projectSlug
      : draft.projectId
        ? loadedProjectSlugById[draft.projectId]
        : undefined;

  const editorRef = useRef<ProjectContentEditorRef>(null);

  useEffect(() => {
    onDraftChange?.(draft);
  }, [draft, onDraftChange]);

  const { handleImageInsert } = useWorkItemImageInsert({
    projectSlug: selectedProjectSlug ?? "",
    editorRef,
  });

  useEffect(() => {
    let cancelled = false;

    const loadOrgs = async () => {
      try {
        const orgsData = await projectApi.readOrgs();
        if (!cancelled) setProjectOrgs(orgsData);
      } catch (err) {
        logger.warn("Failed to load orgs for work item picker", err);
      }
    };

    void loadOrgs();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (availableProjects.length > 0) return;
    let cancelled = false;

    const loadProjects = async () => {
      try {
        const projectsData = await projectApi.readProjects();
        if (cancelled) return;
        setLoadedProjects(
          projectsData.map((project) => ({
            id: project.meta.id,
            name: project.meta.name,
            slug: project.slug,
            orgId: project.meta.org_id,
          }))
        );
        setLoadedProjectSlugById(
          Object.fromEntries(
            projectsData.map((project) => [project.meta.id, project.slug])
          )
        );
      } catch (err) {
        logger.warn("Failed to load projects for work item picker", err);
      }
    };

    loadProjects();
    return () => {
      cancelled = true;
    };
  }, [availableProjects.length]);

  useEffect(() => {
    if (availableMembers.length > 0 || !selectedProjectSlug) return;
    let cancelled = false;

    const loadProjectLookups = async () => {
      try {
        const [membersFile, labelsFile] = await Promise.all([
          projectApi.readMembers(selectedProjectSlug),
          projectApi.readLabels(selectedProjectSlug),
        ]);
        if (cancelled) return;

        const activeMembers: Person[] = membersFile.members
          .filter((member) => member.active !== false)
          .map((member) => ({
            id: member.id,
            name: member.name,
            email: member.email,
            avatar: member.avatar,
          }));
        setLoadedMembers(activeMembers);
        setLoadedLabels(
          labelsFile.labels.map((label) => ({
            id: label.id,
            name: label.name,
            color: label.color,
          }))
        );
      } catch (err) {
        logger.warn("Failed to load project metadata for pickers", err);
      }
    };

    loadProjectLookups();
    return () => {
      cancelled = true;
    };
  }, [selectedProjectSlug, availableMembers.length]);

  const resolvedMembers =
    availableMembers.length > 0 ? availableMembers : loadedMembers;
  const resolvedProjects: CreateWorkItemProjectOption[] =
    availableProjects.length > 0 ? availableProjects : loadedProjects;
  const resolvedLabels =
    availableLabels.length > 0 ? availableLabels : loadedLabels;

  const undoStack = useUndoStackWithRestore<WorkItemDraft>({
    keyboardShortcut: true,
    currentValue: draft,
    onRestore: (previous) => setDraft(previous),
  });

  const updateDraftWithUndo = useCallback(
    (updates: Partial<WorkItemDraft>) => {
      undoStack.snapshot(draft);
      updateDraft(updates);
    },
    [draft, undoStack, updateDraft]
  );

  const handleTitleChange = useCallback(
    (name: string) => updateDraftWithUndo({ name }),
    [updateDraftWithUndo]
  );

  const handleDescriptionChange = useCallback(
    (markdown: string, _text: string) =>
      updateDraftWithUndo({ description: markdown }),
    [updateDraftWithUndo]
  );

  const selectedProject = resolvedProjects.find(
    (project) => project.id === draft.projectId
  );
  const selectedProjectName = selectedProject?.name ?? projectName ?? "";
  const selectedProjectOrgId = selectedProject?.orgId;
  const effectiveOrgId =
    selectedProjectOrgId ?? draft.orgId ?? surfaceOrgId ?? "personal-org";
  const selectedProjectOrgLabel =
    projectOrgs.find((org) => org.id === effectiveOrgId)?.name ??
    scopeBreadcrumbLabel ??
    t("orgs.personalOrg");
  const projectBreadcrumbLabel =
    selectedProjectName || t("projects.dashboardTitle");

  const projectOptions = useMemo<PropertyDropdownOption<string>[]>(
    () =>
      resolvedProjects.map((project) => ({
        value: project.id,
        label: project.name,
        icon: <BookOpen size={CREATE_WORK_ITEM_BREADCRUMB_ICON_SIZE} />,
        iconColor: project.color,
      })),
    [resolvedProjects]
  );

  const orgOptions = useMemo<PropertyDropdownOption<string>[]>(
    () =>
      projectOrgs.map((org) => ({
        value: org.id,
        label: org.name,
        icon: <Building2 size={CREATE_WORK_ITEM_BREADCRUMB_ICON_SIZE} />,
      })),
    [projectOrgs]
  );

  const handleProjectBreadcrumbChange = useCallback(
    (value: string) => updateDraftWithUndo({ projectId: value }),
    [updateDraftWithUndo]
  );

  const handleOrgBreadcrumbChange = useCallback(
    (nextOrgId: string) => {
      const patch: Partial<WorkItemDraft> = { orgId: nextOrgId };
      const currentProject = resolvedProjects.find(
        (project) => project.id === draft.projectId
      );
      if (currentProject && currentProject.orgId !== nextOrgId) {
        const nextProject = resolvedProjects.find(
          (project) => project.orgId === nextOrgId
        );
        patch.projectId = nextProject?.id;
      }
      updateDraftWithUndo(patch);
    },
    [draft.projectId, resolvedProjects, updateDraftWithUndo]
  );

  const orgBreadcrumbSegment =
    orgOptions.length > 0 ? (
      <PropertyDropdownField
        value={effectiveOrgId}
        label={selectedProjectOrgLabel}
        icon={null}
        options={orgOptions}
        onChange={handleOrgBreadcrumbChange}
        placement="portal"
        fieldVariant="pill"
        triggerVariant="pill"
        searchable
        searchPlaceholder={t("workItems.properties.searchProjects")}
        selected={Boolean(selectedProjectOrgId ?? draft.orgId)}
        maxWidthClassName="max-w-[220px] shrink-0"
        dataTestId="create-work-item-org-select"
      />
    ) : (
      <PropertyDropdownField
        value="org"
        label={selectedProjectOrgLabel}
        icon={null}
        placement="portal"
        fieldVariant="pill"
        triggerVariant="pill"
        readonly
        searchable={false}
        selected
        maxWidthClassName="max-w-[220px] shrink-0"
        dataTestId="create-work-item-org-select"
      />
    );

  const projectBreadcrumbSegment =
    projectOptions.length > 0 ? (
      <PropertyDropdownField
        value={draft.projectId ?? ""}
        label={
          draft.projectId
            ? projectBreadcrumbLabel
            : t("projects.dashboardTitle")
        }
        icon={null}
        options={projectOptions}
        onChange={handleProjectBreadcrumbChange}
        placement="portal"
        fieldVariant="pill"
        triggerVariant="pill"
        searchable
        searchPlaceholder={t("workItems.properties.searchProjects")}
        selected={Boolean(draft.projectId)}
        maxWidthClassName="max-w-[220px] shrink-0"
        dataTestId="create-work-item-project-select"
      />
    ) : (
      <PropertyDropdownField
        value="project"
        label={projectBreadcrumbLabel}
        icon={null}
        placement="portal"
        fieldVariant="pill"
        triggerVariant="pill"
        readonly
        searchable={false}
        selected
        maxWidthClassName="max-w-[220px] shrink-0"
        dataTestId="create-work-item-project-select"
      />
    );

  const workItemPillBreadcrumb = (
    <div
      className="flex min-w-0 flex-nowrap items-center gap-1.5"
      data-testid="create-work-item-pill-breadcrumb"
    >
      {orgBreadcrumbSegment}
      <ChevronRight
        size={14}
        strokeWidth={1.75}
        className="shrink-0 text-fill-4"
        aria-hidden
      />
      {projectBreadcrumbSegment}
    </div>
  );

  const stubWorkItem = workItemDraftToStubWorkItem(draft, selectedProjectName);

  const handlePropertyUpdate = useCallback(
    (updates: Partial<WorkItemExtended>) => {
      updateDraftWithUndo(mapWorkItemUpdatesToDraftPatch(updates));
    },
    [updateDraftWithUndo]
  );

  const inlinePropertyPills = !propertiesOpen ? (
    <div data-testid="create-work-item-property-pills">
      <WorkItemProperties
        workItem={stubWorkItem}
        onUpdate={handlePropertyUpdate}
        availableProjects={resolvedProjects}
        availableMilestones={availableMilestones}
        availableLabels={resolvedLabels}
        availableMembers={resolvedMembers}
        availableAgents={customAgents}
        availableOrgs={availableOrgs}
        visibleFields={CREATE_WORK_ITEM_INLINE_FIELDS}
        fieldVariant="pill"
        showMoreMenu
      />
    </div>
  ) : undefined;

  const workItemTitlePlaceholder = t("workItems.titlePlaceholder");
  const optionalWorkItemTitlePlaceholder = `${workItemTitlePlaceholder} (${t("common:optional")})`;
  const titleSection = (
    <Input
      type="text"
      value={draft.name}
      onChange={handleTitleChange}
      placeholder={
        aiGenerateMode
          ? optionalWorkItemTitlePlaceholder
          : workItemTitlePlaceholder
      }
      autoFocus
      fieldVariant="ghost"
      size="small"
      className="flex-1"
      inputClassName={PROJECT_MANAGER_TEXT_PLACEHOLDER_CLASS}
      data-testid="create-work-item-title-input"
    />
  );

  const showManualInputs = !(chatPanelFooter && aiGenerateMode);

  const descriptionSection = (
    <ProjectContentEditor
      key={editorResetKey}
      ref={editorRef}
      title={draft.name}
      onTitleChange={handleTitleChange}
      initialDescription={draft.description || ""}
      onDescriptionChange={handleDescriptionChange}
      titleVisible={false}
      separatorVisible={false}
      descriptionPlaceholder={tSessions("creator.placeholderDefault")}
      onImageInsert={handleImageInsert}
      descriptionClassName="no-bottom-border"
      descriptionMaxHeight="100%"
      repoPath={repoPath}
      className="flex min-h-0 flex-1 flex-col"
      dataTestId="create-work-item-editor"
    />
  );

  const resetDraftForCreateMore = useCallback(() => {
    resetDraft(defaultProjectId);
    setEditorResetKey((value) => value + 1);
  }, [defaultProjectId, resetDraft]);

  return {
    availableAgents: customAgents,
    availableOrgs,
    clearDraft,
    descriptionSection,
    draft,
    editorResetKey,
    editorRef,
    handlePropertyUpdate,
    inlinePropertyPills,
    resetDraftForCreateMore,
    resolvedLabels,
    resolvedMembers,
    resolvedProjects,
    selectedProjectSlug,
    setDraft,
    showManualInputs,
    stubWorkItem,
    titleSection,
    updateDraft,
    workItemPillBreadcrumb,
  };
}

export interface InlineCreateWorkItemFieldsProps {
  className?: string;
  descriptionClassName?: string;
  showDividers?: boolean;
  showDescription?: boolean;
  state: InlineCreateWorkItemFieldsState;
}

export const InlineCreateWorkItemFields: React.FC<
  InlineCreateWorkItemFieldsProps
> = ({
  className = "h-full w-full",
  descriptionClassName = "min-h-0 overflow-hidden",
  showDividers = true,
  showDescription,
  state,
}) => {
  const shouldShowDescription = showDescription ?? state.showManualInputs;

  return (
    <WorkItemContentStack
      className={className}
      titleContent={state.titleSection}
      pathContent={state.workItemPillBreadcrumb}
      propertiesContent={state.inlinePropertyPills}
      descriptionContent={
        shouldShowDescription ? state.descriptionSection : undefined
      }
      descriptionFlexible={shouldShowDescription}
      metaClassName="py-2"
      titleClassName="flex h-10 items-center py-0"
      descriptionClassName={descriptionClassName}
      separatorClassName=""
      showDividers={showDividers}
    />
  );
};
