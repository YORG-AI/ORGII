/**
 * OrgDetailView — Inline-editable detail view for a saved Agent Team.
 *
 * Layout mirrors AgentTeamWizard (same `AgentTeamFormSections` body — see that file).
 * Edits are buffered locally; a sticky Save / Cancel footer appears once
 * the form is dirty (same UX as the markdown / JSON editors in this app).
 * Cancel reverts to the persisted value; Save invokes `onOrgSave`.
 */
import { useAtomValue } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import TabPill from "@src/components/TabPill";
import { type TeamMember } from "@src/components/TeamMemberTable";
import { SECTION_GAP_CLASSES } from "@src/modules/shared/layouts/SectionLayout";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  InternalHeader,
  PanelFooter,
} from "@src/modules/shared/layouts/blocks";
import AgentTeamFormSections, {
  isOrgDraftValid,
} from "@src/scaffold/WizardSystem/variants/AgentOrg/AgentTeamFormSections";
import {
  buildOrgTreeFromMembers,
  flattenOrgToMembers,
} from "@src/scaffold/WizardSystem/variants/AgentOrg/orgTree";

import { builtInAgentsAtom } from "../store/builtInAgentsAtom";
import {
  type AgentDefinition,
  DEFAULT_HIERARCHY_MODE,
  DEFAULT_PLAN_APPROVAL_POLICY,
  type HierarchyMode,
  type OrgMember,
  type PlanApprovalPolicy,
} from "../types";
import { buildAgentOptions } from "./org/config";
import "./org/index.scss";

interface OrgDetailViewProps {
  selectedOrg: OrgMember;
  customAgents: AgentDefinition[];
  onOrgSave: (org: OrgMember) => void | Promise<void>;
  onOrgDelete: (orgId: string) => void | Promise<void>;
}

const OrgDetailView: React.FC<OrgDetailViewProps> = ({
  selectedOrg,
  customAgents,
  onOrgSave,
  onOrgDelete,
}) => {
  const { t } = useTranslation("integrations");
  const builtInAgents = useAtomValue(builtInAgentsAtom);

  const allAgents = useMemo(
    () => [...builtInAgents, ...customAgents],
    [builtInAgents, customAgents]
  );

  const tabs = useMemo(
    () => [{ key: "core", label: t("agentOrgs.cliAgentDetail.tabCore") }],
    [t]
  );
  const handleCoreTabChange = useCallback(() => {}, []);

  const [orgName, setOrgName] = useState(selectedOrg.name);
  const [orgDescription, setOrgDescription] = useState(
    selectedOrg.description ?? ""
  );
  const [coordinatorAgentId, setCoordinatorAgentId] = useState(
    selectedOrg.agentId
  );
  const [coordinatorRole, setCoordinatorRole] = useState(
    selectedOrg.role || "Coordinator"
  );
  const [coordinatorInstructions, setCoordinatorInstructions] = useState(
    selectedOrg.instructions ?? ""
  );
  const [hierarchyMode, setHierarchyMode] = useState<HierarchyMode>(
    selectedOrg.hierarchyMode ?? DEFAULT_HIERARCHY_MODE
  );
  const [planApprovalPolicy, setPlanApprovalPolicy] =
    useState<PlanApprovalPolicy>(
      selectedOrg.planApprovalPolicy ?? DEFAULT_PLAN_APPROVAL_POLICY
    );
  const [members, setMembers] = useState<TeamMember[]>(() =>
    flattenOrgToMembers(selectedOrg.children)
  );
  const [saving, setSaving] = useState(false);
  const [membersTab, setMembersTab] = useState<"edit" | "preview">("edit");

  const activeOrgIdRef = useRef(selectedOrg.id);

  // When the user picks a different org row, reset the local edit buffer.
  useEffect(() => {
    if (activeOrgIdRef.current === selectedOrg.id) return;
    activeOrgIdRef.current = selectedOrg.id;
    setOrgName(selectedOrg.name);
    setOrgDescription(selectedOrg.description ?? "");
    setCoordinatorAgentId(selectedOrg.agentId);
    setCoordinatorRole(selectedOrg.role || "Coordinator");
    setCoordinatorInstructions(selectedOrg.instructions ?? "");
    setHierarchyMode(selectedOrg.hierarchyMode ?? DEFAULT_HIERARCHY_MODE);
    setPlanApprovalPolicy(
      selectedOrg.planApprovalPolicy ?? DEFAULT_PLAN_APPROVAL_POLICY
    );
    setMembers(flattenOrgToMembers(selectedOrg.children));
    setSaving(false);
  }, [selectedOrg]);

  const agentOptions = useMemo(
    () => buildAgentOptions(customAgents, builtInAgents),
    [customAgents, builtInAgents]
  );

  const persistedMembersJson = useMemo(
    () => JSON.stringify(flattenOrgToMembers(selectedOrg.children)),
    [selectedOrg]
  );
  const draftMembersJson = useMemo(() => JSON.stringify(members), [members]);

  const previewRoot = useMemo<OrgMember>(
    () => ({
      id: selectedOrg.id,
      name: orgName.trim() || selectedOrg.name,
      role: coordinatorRole.trim() || "Coordinator",
      agentId: coordinatorAgentId,
      description: orgDescription.trim() || undefined,
      instructions: coordinatorInstructions.trim() || undefined,
      hierarchyMode,
      planApprovalPolicy,
      children: buildOrgTreeFromMembers(members),
    }),
    [
      selectedOrg,
      orgName,
      orgDescription,
      coordinatorAgentId,
      coordinatorRole,
      coordinatorInstructions,
      hierarchyMode,
      planApprovalPolicy,
      members,
    ]
  );

  const persistedDescription = selectedOrg.description ?? "";
  const persistedInstructions = selectedOrg.instructions ?? "";
  const persistedHierarchyMode =
    selectedOrg.hierarchyMode ?? DEFAULT_HIERARCHY_MODE;
  const persistedPlanApprovalPolicy =
    selectedOrg.planApprovalPolicy ?? DEFAULT_PLAN_APPROVAL_POLICY;
  const isDirty =
    orgName !== selectedOrg.name ||
    orgDescription !== persistedDescription ||
    coordinatorAgentId !== selectedOrg.agentId ||
    coordinatorRole !== (selectedOrg.role || "Coordinator") ||
    coordinatorInstructions !== persistedInstructions ||
    hierarchyMode !== persistedHierarchyMode ||
    planApprovalPolicy !== persistedPlanApprovalPolicy ||
    draftMembersJson !== persistedMembersJson;

  const isValid = isOrgDraftValid({ orgName, coordinatorAgentId, members });

  const handleCancel = useCallback(() => {
    setOrgName(selectedOrg.name);
    setOrgDescription(selectedOrg.description ?? "");
    setCoordinatorAgentId(selectedOrg.agentId);
    setCoordinatorRole(selectedOrg.role || "Coordinator");
    setCoordinatorInstructions(selectedOrg.instructions ?? "");
    setHierarchyMode(selectedOrg.hierarchyMode ?? DEFAULT_HIERARCHY_MODE);
    setPlanApprovalPolicy(
      selectedOrg.planApprovalPolicy ?? DEFAULT_PLAN_APPROVAL_POLICY
    );
    setMembers(flattenOrgToMembers(selectedOrg.children));
  }, [selectedOrg]);

  const handleSave = useCallback(async () => {
    if (!isValid || saving) return;
    setSaving(true);
    try {
      const trimmedDescription = orgDescription.trim();
      const trimmedInstructions = coordinatorInstructions.trim();
      const next: OrgMember = {
        id: selectedOrg.id,
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
      await onOrgSave(next);
      // Keep the local edit buffer aligned with the normalized payload. The
      // selected org keeps the same id after save, so the id-change reset
      // effect intentionally does not run for this case.
      setOrgName(next.name);
      setOrgDescription(next.description ?? "");
      setCoordinatorRole(next.role);
      setCoordinatorInstructions(next.instructions ?? "");
      setMembers(flattenOrgToMembers(next.children));
    } finally {
      setSaving(false);
    }
  }, [
    isValid,
    saving,
    selectedOrg,
    orgName,
    orgDescription,
    coordinatorAgentId,
    coordinatorRole,
    coordinatorInstructions,
    hierarchyMode,
    planApprovalPolicy,
    members,
    onOrgSave,
  ]);

  const headerTabs = useMemo(
    () => (
      <TabPill
        tabs={tabs}
        activeTab="core"
        onChange={handleCoreTabChange}
        variant="simple"
        fillWidth={false}
        size="large"
      />
    ),
    [tabs, handleCoreTabChange]
  );

  const handleDelete = useCallback(() => {
    onOrgDelete(selectedOrg.id);
  }, [onOrgDelete, selectedOrg.id]);

  return (
    <DetailPanelContainer
      testId="agent-orgs-org-detail"
      rootProps={
        {
          "data-dirty": isDirty ? "true" : "false",
          "data-valid": isValid ? "true" : "false",
        } as React.HTMLAttributes<HTMLDivElement>
      }
    >
      <InternalHeader
        noPanelHeader
        contentPadding
        className={DETAIL_PANEL_TOKENS.headerWidth}
        tabs={headerTabs}
      />
      <div className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
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
              onDelete={handleDelete}
            />
          </div>
        </div>
      </div>
      {isDirty && (
        <PanelFooter
          secondaryActions={[
            {
              label: t("common:actions.cancel"),
              onClick: handleCancel,
              disabled: saving,
              dataTestId: "agent-orgs-org-detail-cancel-button",
            },
          ]}
          primaryAction={{
            label: saving
              ? `${t("common:actions.save")}...`
              : t("common:actions.save"),
            onClick: handleSave,
            disabled: !isValid || saving,
            loading: saving,
            dataTestId: "agent-orgs-org-detail-save-button",
          }}
        />
      )}
    </DetailPanelContainer>
  );
};

export default OrgDetailView;
