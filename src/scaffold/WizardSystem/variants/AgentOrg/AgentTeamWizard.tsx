/**
 * AgentTeamWizard — Single-page wizard for creating or editing an agent
 * team. Sections: Team name, Coordinator (root agent), Preview, and
 * Team members.
 *
 * Follows the WizardShell → WizardStepLayout → SectionLayout pattern.
 *
 * The form body itself lives in `AgentTeamFormSections` so this wizard and
 * OrgDetailView render the exact same controls; this file owns only the
 * single-step submit chrome and the inline-create AgentWizard overlay.
 */
import { useAtomValue } from "jotai";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import type { TeamMember } from "@src/components/TeamMemberTable";
import { buildAgentOptions } from "@src/modules/MainApp/AgentOrgs/components/org/config";
import "@src/modules/MainApp/AgentOrgs/components/org/index.scss";
import { builtInAgentsAtom } from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import {
  type AgentDefinition,
  DEFAULT_HIERARCHY_MODE,
  DEFAULT_PLAN_APPROVAL_POLICY,
  type HierarchyMode,
  type OrgMember,
  type PlanApprovalPolicy,
} from "@src/modules/MainApp/AgentOrgs/types";
import { SECTION_GAP_CLASSES } from "@src/modules/shared/layouts/SectionLayout";
import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";
import {
  WizardShell,
  WizardStepLayout,
} from "@src/scaffold/WizardSystem/primitives";
import AgentWizard from "@src/scaffold/WizardSystem/variants/Agent/AgentWizard";

import AgentTeamFormSections, {
  isOrgDraftValid,
} from "./AgentTeamFormSections";
import { buildOrgTreeFromMembers, flattenOrgToMembers } from "./orgTree";

// ── Types ──

interface AgentTeamWizardProps {
  onSave: (org: OrgMember) => void;
  onCancel: () => void;
  /** When provided, wizard opens in single-step edit mode */
  initialOrg?: OrgMember;
  /** Custom agents created by user (from Agents tab + inline) */
  customAgents?: AgentDefinition[];
  /** Called when a new custom agent is created inline */
  onAgentCreate?: (agent: AgentDefinition) => void | Promise<void>;
}

// ── Component ──

const AgentTeamWizard: React.FC<AgentTeamWizardProps> = ({
  onSave,
  onCancel,
  initialOrg,
  customAgents = [],
  onAgentCreate,
}) => {
  const { t } = useTranslation("integrations");
  const builtInAgents = useAtomValue(builtInAgentsAtom);
  const isEditMode = !!initialOrg;

  const [orgName, setOrgName] = useState(initialOrg?.name ?? "");
  const [orgDescription, setOrgDescription] = useState(
    initialOrg?.description ?? ""
  );
  const [coordinatorAgentId, setCoordinatorAgentId] = useState<string>(
    initialOrg?.agentId ?? ""
  );
  const [coordinatorRole, setCoordinatorRole] = useState(
    initialOrg?.role ?? "Coordinator"
  );
  const [coordinatorInstructions, setCoordinatorInstructions] = useState(
    initialOrg?.instructions ?? ""
  );
  const [hierarchyMode, setHierarchyMode] = useState<HierarchyMode>(
    initialOrg?.hierarchyMode ?? DEFAULT_HIERARCHY_MODE
  );
  const [planApprovalPolicy, setPlanApprovalPolicy] =
    useState<PlanApprovalPolicy>(
      initialOrg?.planApprovalPolicy ?? DEFAULT_PLAN_APPROVAL_POLICY
    );
  const [members, setMembers] = useState<TeamMember[]>(() =>
    initialOrg ? flattenOrgToMembers(initialOrg.children) : []
  );

  const [showAgentWizard, setShowAgentWizard] = useState(false);
  const [membersTab, setMembersTab] = useState<"edit" | "preview">("edit");

  const canSave = isOrgDraftValid({ orgName, coordinatorAgentId, members });

  const allAgents = useMemo(
    () => [...builtInAgents, ...customAgents],
    [builtInAgents, customAgents]
  );

  const agentOptions = useMemo(
    () => buildAgentOptions(customAgents, builtInAgents),
    [customAgents, builtInAgents]
  );

  const previewRoot = useMemo<OrgMember>(
    () => ({
      id: initialOrg?.id ?? "preview-root",
      name: orgName.trim() || "Org",
      role: coordinatorRole.trim() || "Coordinator",
      agentId: coordinatorAgentId,
      description: orgDescription.trim() || undefined,
      instructions: coordinatorInstructions.trim() || undefined,
      hierarchyMode,
      planApprovalPolicy,
      children: buildOrgTreeFromMembers(members),
    }),
    [
      orgName,
      orgDescription,
      coordinatorAgentId,
      coordinatorRole,
      coordinatorInstructions,
      hierarchyMode,
      planApprovalPolicy,
      members,
      initialOrg,
    ]
  );

  const handleSave = useCallback(() => {
    const trimmedDescription = orgDescription.trim();
    const trimmedInstructions = coordinatorInstructions.trim();
    const root: OrgMember = {
      id: initialOrg?.id ?? crypto.randomUUID(),
      name: orgName.trim(),
      role: coordinatorRole.trim() || "Coordinator",
      agentId: coordinatorAgentId,
      description:
        trimmedDescription.length > 0 ? trimmedDescription : undefined,
      instructions:
        trimmedInstructions.length > 0 ? trimmedInstructions : undefined,
      hierarchyMode,
      planApprovalPolicy,
      children: buildOrgTreeFromMembers(members),
    };
    onSave(root);
  }, [
    orgName,
    orgDescription,
    coordinatorAgentId,
    coordinatorRole,
    coordinatorInstructions,
    hierarchyMode,
    planApprovalPolicy,
    members,
    onSave,
    initialOrg,
  ]);

  // ── Inline agent creation ──

  const handleAddAgent = useCallback(() => {
    setShowAgentWizard(true);
  }, []);

  const handleAgentWizardSave = useCallback(
    (agent: AgentDefinition) => {
      onAgentCreate?.(agent);
      setShowAgentWizard(false);
    },
    [onAgentCreate]
  );

  const handleAgentWizardCancel = useCallback(() => {
    setShowAgentWizard(false);
  }, []);

  const wizardTitle = isEditMode
    ? t("common:actions.edit")
    : t("agentOrgs.orgWizard.title");

  // ── Inline agent wizard overlay ──
  if (showAgentWizard) {
    return (
      <AgentWizard
        onSave={handleAgentWizardSave}
        onCancel={handleAgentWizardCancel}
      />
    );
  }

  const primaryLabel = isEditMode
    ? t("common:actions.save")
    : t("common:actions.create");

  return (
    <WizardShell
      title={wizardTitle}
      onCancel={onCancel}
      testId="agent-orgs-org-wizard-root"
    >
      <WizardStepLayout
        currentStep={1}
        totalSteps={1}
        fillWidth
        noPadding
        hideStepIndicator
        contentWidthFooter
        actions={
          <>
            <Button
              variant="secondary"
              size="small"
              data-testid="agent-orgs-org-wizard-cancel-button"
              onClick={onCancel}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant="primary"
              size="small"
              disabled={!canSave}
              data-testid="agent-orgs-org-wizard-save-button"
              onClick={handleSave}
            >
              {primaryLabel}
            </Button>
          </>
        }
      >
        <div className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
          <div
            className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}
            data-testid="agent-orgs-org-wizard-content"
          >
            <div className={SECTION_GAP_CLASSES}>
              <AgentTeamFormSections
                orgName={orgName}
                onOrgNameChange={setOrgName}
                orgDescription={orgDescription}
                onOrgDescriptionChange={setOrgDescription}
                coordinatorAgentId={coordinatorAgentId}
                onCoordinatorAgentIdChange={setCoordinatorAgentId}
                coordinatorRole={coordinatorRole}
                onCoordinatorRoleChange={setCoordinatorRole}
                coordinatorInstructions={coordinatorInstructions}
                onCoordinatorInstructionsChange={setCoordinatorInstructions}
                hierarchyMode={hierarchyMode}
                onHierarchyModeChange={setHierarchyMode}
                planApprovalPolicy={planApprovalPolicy}
                onPlanApprovalPolicyChange={setPlanApprovalPolicy}
                members={members}
                onMembersChange={setMembers}
                membersTab={membersTab}
                onMembersTabChange={setMembersTab}
                agentOptions={agentOptions}
                allAgents={allAgents}
                previewRoot={previewRoot}
                onAddAgent={handleAddAgent}
                autoFocusName
              />
            </div>
          </div>
        </div>
      </WizardStepLayout>
    </WizardShell>
  );
};

export default AgentTeamWizard;
