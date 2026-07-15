/**
 * AgentTeamFormSections — Shared body of the team create/edit form.
 *
 * Renders the four sections that both `AgentTeamWizard` (creation flow) and
 * `OrgDetailView` (inline edit on a saved team) need: name + description,
 * coordinator + hierarchy mode, members (Edit / Preview), and the
 * strict-mode reachability preview. Owning the form chrome here keeps
 * the two surfaces visually identical and prevents drift when, e.g., a
 * new validation hint is added to one path but not the other.
 *
 * State remains hoisted to the parent (controlled props) so that
 * AgentTeamWizard can keep its single-step submit pattern and OrgDetailView
 * can keep its dirty-buffer + sticky-footer pattern.
 *
 * Note on the agent-creation entry point: only AgentTeamWizard supports
 * inline agent creation (`onAddAgent`). OrgDetailView omits it so that
 * row creation here doesn't fork into an Agent wizard from a saved-team
 * surface; passing `onAddAgent={undefined}` simply hides the inline
 * "+ New agent" affordance in `TeamMemberTable`.
 */
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import TabPill from "@src/components/TabPill";
import TeamMemberTable, {
  type TeamMember,
} from "@src/components/TeamMemberTable";
import Textarea from "@src/components/Textarea";
import OrgChart from "@src/modules/MainApp/AgentOrgs/components/org/OrgChart";
import {
  type AgentDefinition,
  type HierarchyMode,
  type OrgMember,
  type PlanApprovalPolicy,
} from "@src/modules/MainApp/AgentOrgs/types";
import {
  SECTION_DESCRIPTION_CLASSES,
  SECTION_LABEL_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { SECTION_CONTROL_STYLE } from "@src/modules/shared/layouts/SectionLayout/tokens";
import { Placeholder } from "@src/modules/shared/layouts/blocks/Placeholder";

import HierarchyModeSelector from "./HierarchyModeSelector";
import PlanApprovalPolicySelector from "./PlanApprovalPolicySelector";
import { ReachabilityPreview } from "./ReachabilityPreview";
import { findDuplicateMemberNameIds } from "./orgTree";

type AgentOption = ReturnType<
  typeof import("@src/modules/MainApp/AgentOrgs/components/org/config").buildAgentOptions
>[number];

export interface AgentTeamFormSectionsProps {
  // Controlled fields
  orgName: string;
  onOrgNameChange: (value: string) => void;
  orgDescription: string;
  onOrgDescriptionChange: (value: string) => void;
  coordinatorAgentId: string;
  onCoordinatorAgentIdChange: (value: string) => void;
  hierarchyMode: HierarchyMode;
  onHierarchyModeChange: (mode: HierarchyMode) => void;
  planApprovalPolicy: PlanApprovalPolicy;
  onPlanApprovalPolicyChange: (policy: PlanApprovalPolicy) => void;
  members: TeamMember[];
  onMembersChange: (members: TeamMember[]) => void;

  // Member-table tab state (controlled by parent so the choice persists
  // across re-renders without the parent having to re-derive it)
  membersTab: "edit" | "preview";
  onMembersTabChange: (tab: "edit" | "preview") => void;

  // Lookups
  agentOptions: AgentOption[];
  /** Coordinator + custom agents, used to render OrgChart preview. */
  allAgents: AgentDefinition[];
  /** Live org used to feed OrgChart in preview mode. */
  previewRoot: OrgMember;

  // Optional inline-create entry (creation flow only)
  onAddAgent?: () => void;

  /** Auto-focus the name input. Use on creation to drop the cursor in. */
  autoFocusName?: boolean;

  /**
   * Optional destructive action. When set, a "Danger Zone" section is
   * appended with a confirm-then-execute Delete button. Only the
   * saved-org surface (`OrgDetailView`) wires this; the create wizard
   * omits it.
   */
  onDelete?: () => void | Promise<void>;
}

/**
 * Renders the four shared team-form sections. Caller owns state and the
 * surrounding scroll/footer chrome.
 */
const AgentTeamFormSections: React.FC<AgentTeamFormSectionsProps> = ({
  orgName,
  onOrgNameChange,
  orgDescription,
  onOrgDescriptionChange,
  coordinatorAgentId,
  onCoordinatorAgentIdChange,
  hierarchyMode,
  onHierarchyModeChange,
  planApprovalPolicy,
  onPlanApprovalPolicyChange,
  members,
  onMembersChange,
  membersTab,
  onMembersTabChange,
  agentOptions,
  allAgents,
  previewRoot,
  onAddAgent,
  autoFocusName = false,
  onDelete,
}) => {
  const { t } = useTranslation("integrations");

  // The actual confirm prompt is the native Tauri ask() dialog raised by
  // the parent's `onOrgDelete` handler (see AgentOrgs/index.tsx). Do not
  // add an inline confirm step here — that would double-confirm and
  // routes around the platform dialog the user expects.
  const handleDeleteClick = useCallback(() => {
    onDelete?.();
  }, [onDelete]);

  const membersTabs = useMemo(
    () => [
      { key: "edit", label: t("agentOrgs.orgWizard.tabs.edit") },
      { key: "preview", label: t("agentOrgs.orgWizard.tabs.previewDiagram") },
    ],
    [t]
  );

  const tableLabels = useMemo(
    () => ({
      name: t("agentOrgs.orgWizard.memberName"),
      role: t("agentOrgs.orgWizard.role"),
      agent: t("agentOrgs.orgWizard.agent"),
      reportsTo: t("agentOrgs.orgWizard.reportsTo"),
      reportsToCoordinator: t("agentOrgs.orgWizard.reportsToCoordinator"),
      addMember: t("agentOrgs.orgWizard.addMember"),
      namePlaceholder: t("agentOrgs.orgWizard.memberNamePlaceholder"),
      rolePlaceholder: t("agentOrgs.orgWizard.rolePlaceholder"),
      empty: t("agentOrgs.orgWizard.noMembers"),
    }),
    [t]
  );

  const handleMembersTabChange = useCallback(
    (key: string) => {
      onMembersTabChange(key as "edit" | "preview");
    },
    [onMembersTabChange]
  );

  const membersTabPill = useMemo(
    () => (
      <TabPill
        tabs={membersTabs}
        activeTab={membersTab}
        onChange={handleMembersTabChange}
        variant="pill"
        fillWidth={false}
      />
    ),
    [membersTabs, membersTab, handleMembersTabChange]
  );

  const duplicateNameIds = useMemo(
    () => findDuplicateMemberNameIds(members),
    [members]
  );

  // In strict mode, members without a `parentId` can only reach the
  // coordinator at runtime via the escape hatch. Surface that as a
  // per-row warning so users notice before saving.
  const missingParentIds = useMemo<ReadonlySet<string>>(
    () =>
      new Set(
        members
          .filter((member) => !member.parentId || member.parentId.length === 0)
          .map((member) => member.id)
      ),
    [members]
  );

  return (
    <>
      <SectionContainer>
        <SectionRow
          label={t("agentOrgs.orgWizard.orgName")}
          description={t("agentOrgs.orgWizard.orgNameDesc")}
          required
        >
          <Input
            value={orgName}
            onChange={onOrgNameChange}
            placeholder={t("agentOrgs.orgWizard.orgNamePlaceholder")}
            size="default"
            style={SECTION_CONTROL_STYLE}
            autoFocus={autoFocusName}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            data-testid="agent-orgs-org-name-input"
          />
        </SectionRow>
        <SectionRow
          label={t("agentOrgs.orgWizard.orgDescription")}
          description={t("agentOrgs.orgWizard.orgDescriptionDesc")}
          layout="vertical"
        >
          <Textarea
            value={orgDescription}
            onChange={onOrgDescriptionChange}
            placeholder={t("agentOrgs.orgWizard.orgDescriptionPlaceholder")}
            size="default"
            rows={3}
            autoSize={{ minRows: 3, maxRows: 6 }}
            data-testid="agent-orgs-org-description-input"
          />
        </SectionRow>
      </SectionContainer>

      <SectionContainer>
        <SectionRow
          label={t("agentOrgs.orgWizard.coordinator")}
          description={t("agentOrgs.orgWizard.coordinatorDesc")}
          required
        >
          <Select
            value={coordinatorAgentId || undefined}
            onChange={(value) => onCoordinatorAgentIdChange(String(value))}
            options={agentOptions}
            placeholder={t("agentOrgs.orgWizard.coordinatorPlaceholder")}
            size="default"
            style={SECTION_CONTROL_STYLE}
            showSearch
            dataTestId="agent-orgs-org-coordinator-select"
          />
        </SectionRow>
        <SectionRow
          label={t("agentOrgs.orgWizard.hierarchyMode.label")}
          description={t("agentOrgs.orgWizard.hierarchyMode.description")}
          required
        >
          <HierarchyModeSelector
            value={hierarchyMode}
            onChange={onHierarchyModeChange}
          />
        </SectionRow>
        <SectionRow
          label={t("agentOrgs.orgWizard.planApprovalPolicy.label")}
          description={t("agentOrgs.orgWizard.planApprovalPolicy.description")}
          required
        >
          <PlanApprovalPolicySelector
            value={planApprovalPolicy}
            onChange={onPlanApprovalPolicyChange}
          />
        </SectionRow>
      </SectionContainer>

      <SectionContainer>
        <div className="flex flex-col gap-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className={SECTION_LABEL_CLASSES}>
                {t("agentOrgs.orgWizard.membersLabel")}
                <span className="ml-0.5 text-danger-6">*</span>
              </div>
              <div className={SECTION_DESCRIPTION_CLASSES}>
                {t("agentOrgs.orgWizard.membersDesc")}
              </div>
            </div>
            <div className="flex shrink-0 items-center">{membersTabPill}</div>
          </div>
        </div>
        {membersTab === "edit" ? (
          <>
            {hierarchyMode === "strict" ? (
              <SectionRow label="" showHeader={false}>
                <div className="rounded-md border border-solid border-warning-3 bg-warning-1 px-3 py-2 text-xs text-warning-6">
                  {t("agentOrgs.orgWizard.strictBanner")}
                </div>
              </SectionRow>
            ) : null}
            <SectionRow label="" showHeader={false}>
              <TeamMemberTable
                members={members}
                onChange={onMembersChange}
                agentOptions={agentOptions}
                onAddAgent={onAddAgent}
                labels={tableLabels}
                invalidNameRowIds={duplicateNameIds}
                invalidNameMessage={t(
                  "agentOrgs.orgWizard.memberNameDuplicate"
                )}
                hideReportsTo={hierarchyMode === "flat"}
                warnReportsToRowIds={
                  hierarchyMode === "strict" ? missingParentIds : undefined
                }
                warnReportsToMessage={t(
                  "agentOrgs.orgWizard.missingParentWarn"
                )}
                dataTestIdPrefix="agent-orgs-member"
              />
            </SectionRow>
          </>
        ) : (
          <SectionRow label="" showHeader={false}>
            {members.length > 0 ? (
              <div className="overflow-x-auto">
                <OrgChart
                  root={previewRoot}
                  hideRoot
                  agents={allAgents}
                  selectedId={null}
                  onSelect={NOOP}
                  onAddChild={NOOP}
                  onEdit={NOOP}
                  onDelete={NOOP}
                  readOnly
                />
              </div>
            ) : (
              <Placeholder
                variant="empty"
                title={t("agentOrgs.orgWizard.previewEmpty")}
              />
            )}
          </SectionRow>
        )}
      </SectionContainer>

      {hierarchyMode === "strict" ? (
        <SectionContainer>
          <SectionRow
            label={t("agentOrgs.orgWizard.reachability.label")}
            description={t("agentOrgs.orgWizard.reachability.description")}
          />
          <SectionRow label="" showHeader={false}>
            <ReachabilityPreview root={previewRoot} />
          </SectionRow>
        </SectionContainer>
      ) : null}

      {onDelete ? (
        <SectionContainer title={t("agentOrgs.orgWizard.dangerZone")}>
          <SectionRow
            label={t("agentOrgs.orgWizard.deleteOrg")}
            description={t("agentOrgs.orgWizard.deleteOrgDesc")}
          >
            <Button
              variant="secondary"
              size="small"
              onClick={handleDeleteClick}
              data-testid="agent-orgs-org-delete-button"
            >
              {t("agentOrgs.orgWizard.deleteThisOrg")}
            </Button>
          </SectionRow>
        </SectionContainer>
      ) : null}
    </>
  );
};

// Stable noop reference so OrgChart memoization isn't busted on every render.
const NOOP = () => {};

export default AgentTeamFormSections;

/**
 * Shared validation predicate. A draft is "valid" iff:
 *  - team name is non-empty
 *  - coordinator agent is set
 *  - at least one member exists
 *  - every member has a non-empty name AND an agent assigned
 *  - no two members share a name (within this team)
 *
 * Both OrgWizard.canSave and OrgDetailView.isValid resolve to exactly
 * this predicate; centralising it keeps the two flows in sync.
 */
export function isOrgDraftValid(args: {
  orgName: string;
  coordinatorAgentId: string;
  members: TeamMember[];
}): boolean {
  const { orgName, coordinatorAgentId, members } = args;
  if (orgName.trim().length === 0) return false;
  if (coordinatorAgentId.trim().length === 0) return false;
  if (members.length === 0) return false;
  if (
    !members.every(
      (m) => m.name.trim().length > 0 && m.agentId.trim().length > 0
    )
  )
    return false;
  if (findDuplicateMemberNameIds(members).size > 0) return false;
  return true;
}
