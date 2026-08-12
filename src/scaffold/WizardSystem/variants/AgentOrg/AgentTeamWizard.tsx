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
  DEFAULT_PLAN_APPROVAL_POLICY,
  type OrgDefinition,
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
import {
  linksToPairSet,
  sortedLinksFromPairSet,
  toFlatOrgMembers,
  toTeamMembers,
} from "./orgTree";

interface AgentTeamWizardProps {
  onSave: (org: OrgDefinition) => void;
  onCancel: () => void;
  initialOrg?: OrgDefinition;
  customAgents?: AgentDefinition[];
  onAgentCreate?: (agent: AgentDefinition) => void | Promise<void>;
}

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
  const [coordinatorAgentId, setCoordinatorAgentId] = useState(
    initialOrg?.agentId ?? ""
  );
  const [planApprovalPolicy, setPlanApprovalPolicy] =
    useState<PlanApprovalPolicy>(
      initialOrg?.planApprovalPolicy ?? DEFAULT_PLAN_APPROVAL_POLICY
    );
  const [members, setMembers] = useState<TeamMember[]>(() =>
    initialOrg ? toTeamMembers(initialOrg.members) : []
  );
  const [writerMemberIds, setWriterMemberIds] = useState<Set<string>>(
    () => new Set(initialOrg?.additionalTaskGraphWriterMemberIds ?? [])
  );
  const [communicationPairKeys, setCommunicationPairKeys] = useState<
    Set<string>
  >(() => linksToPairSet(initialOrg?.memberCommunicationLinks ?? []));
  const [showAgentWizard, setShowAgentWizard] = useState(false);

  const canSave = isOrgDraftValid({ orgName, coordinatorAgentId, members });
  const agentOptions = useMemo(
    () => buildAgentOptions(customAgents, builtInAgents),
    [customAgents, builtInAgents]
  );

  const handleSave = useCallback(() => {
    const trimmedDescription = orgDescription.trim();
    onSave({
      id: initialOrg?.id ?? crypto.randomUUID(),
      name: orgName.trim(),
      role: "Coordinator",
      agentId: coordinatorAgentId,
      description:
        trimmedDescription.length > 0 ? trimmedDescription : undefined,
      planApprovalPolicy,
      members: toFlatOrgMembers(members),
      additionalTaskGraphWriterMemberIds: [...writerMemberIds].sort(),
      memberCommunicationLinks: sortedLinksFromPairSet(communicationPairKeys),
    });
  }, [
    communicationPairKeys,
    coordinatorAgentId,
    initialOrg?.id,
    members,
    onSave,
    orgDescription,
    orgName,
    planApprovalPolicy,
    writerMemberIds,
  ]);

  const handleAgentWizardSave = useCallback(
    (agent: AgentDefinition) => {
      onAgentCreate?.(agent);
      setShowAgentWizard(false);
    },
    [onAgentCreate]
  );

  if (showAgentWizard) {
    return (
      <AgentWizard
        onSave={handleAgentWizardSave}
        onCancel={() => setShowAgentWizard(false)}
      />
    );
  }

  return (
    <WizardShell
      title={
        isEditMode ? t("common:actions.edit") : t("agentOrgs.orgWizard.title")
      }
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
              {isEditMode
                ? t("common:actions.save")
                : t("common:actions.create")}
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
                planApprovalPolicy={planApprovalPolicy}
                onPlanApprovalPolicyChange={setPlanApprovalPolicy}
                members={members}
                onMembersChange={setMembers}
                writerMemberIds={writerMemberIds}
                onWriterMemberIdsChange={setWriterMemberIds}
                communicationPairKeys={communicationPairKeys}
                onCommunicationPairKeysChange={setCommunicationPairKeys}
                agentOptions={agentOptions}
                onAddAgent={() => setShowAgentWizard(true)}
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
