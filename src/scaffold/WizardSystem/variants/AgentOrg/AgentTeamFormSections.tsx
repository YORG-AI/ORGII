import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import TeamMemberTable, {
  type TeamMember,
} from "@src/components/TeamMemberTable";
import Textarea from "@src/components/Textarea";
import { MAX_AGENT_ORG_MEMBERS } from "@src/modules/MainApp/AgentOrgs/config/agentConstants";
import type { PlanApprovalPolicy } from "@src/modules/MainApp/AgentOrgs/types";
import {
  SECTION_DESCRIPTION_CLASSES,
  SECTION_LABEL_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { SECTION_CONTROL_STYLE } from "@src/modules/shared/layouts/SectionLayout/tokens";

import MemberCommunicationPanel from "./MemberCommunicationPanel";
import PlanApprovalPolicySelector from "./PlanApprovalPolicySelector";
import {
  canonicalPairKey,
  connectedCountByMemberId,
  findDuplicateMemberNameIds,
  pairKeysWithNewMember,
  pairKeysWithoutMember,
} from "./orgTree";

type AgentOption = ReturnType<
  typeof import("@src/modules/MainApp/AgentOrgs/components/org/config").buildAgentOptions
>[number];

export interface AgentTeamFormSectionsProps {
  orgName: string;
  onOrgNameChange: (value: string) => void;
  orgDescription: string;
  onOrgDescriptionChange: (value: string) => void;
  coordinatorAgentId: string;
  onCoordinatorAgentIdChange: (value: string) => void;
  planApprovalPolicy: PlanApprovalPolicy;
  onPlanApprovalPolicyChange: (policy: PlanApprovalPolicy) => void;
  members: TeamMember[];
  onMembersChange: (members: TeamMember[]) => void;
  writerMemberIds: ReadonlySet<string>;
  onWriterMemberIdsChange: (memberIds: Set<string>) => void;
  communicationPairKeys: ReadonlySet<string>;
  onCommunicationPairKeysChange: (pairKeys: Set<string>) => void;
  agentOptions: AgentOption[];
  onAddAgent?: () => void;
  autoFocusName?: boolean;
  onDelete?: () => void | Promise<void>;
}

const AgentTeamFormSections: React.FC<AgentTeamFormSectionsProps> = ({
  orgName,
  onOrgNameChange,
  orgDescription,
  onOrgDescriptionChange,
  coordinatorAgentId,
  onCoordinatorAgentIdChange,
  planApprovalPolicy,
  onPlanApprovalPolicyChange,
  members,
  onMembersChange,
  writerMemberIds,
  onWriterMemberIdsChange,
  communicationPairKeys,
  onCommunicationPairKeysChange,
  agentOptions,
  onAddAgent,
  autoFocusName = false,
  onDelete,
}) => {
  const { t } = useTranslation("integrations");
  const [selectedCommunicationMemberId, setSelectedCommunicationMemberId] =
    useState<string | null>(null);
  const duplicateNameIds = useMemo(
    () => findDuplicateMemberNameIds(members),
    [members]
  );
  const connectedCounts = useMemo(
    () => connectedCountByMemberId(members, communicationPairKeys),
    [communicationPairKeys, members]
  );
  const tableLabels = useMemo(
    () => ({
      name: t("agentOrgs.orgWizard.memberName"),
      role: t("agentOrgs.orgWizard.role"),
      agent: t("agentOrgs.orgWizard.agent"),
      writer: t("agentOrgs.orgWizard.writer"),
      connected: t("agentOrgs.orgWizard.connected"),
      connectedCount: (count: number) =>
        t("agentOrgs.orgWizard.connectedCount", { count }),
      manageCommunication: t("agentOrgs.orgWizard.manageCommunication"),
      addMember: t("agentOrgs.orgWizard.addMember"),
      namePlaceholder: t("agentOrgs.orgWizard.memberNamePlaceholder"),
      rolePlaceholder: t("agentOrgs.orgWizard.rolePlaceholder"),
      empty: t("agentOrgs.orgWizard.noMembers"),
    }),
    [t]
  );

  const handleWriterChange = useCallback(
    (memberId: string, checked: boolean) => {
      const next = new Set(writerMemberIds);
      if (checked) next.add(memberId);
      else next.delete(memberId);
      onWriterMemberIdsChange(next);
    },
    [onWriterMemberIdsChange, writerMemberIds]
  );
  const handlePairChange = useCallback(
    (memberAId: string, memberBId: string, checked: boolean) => {
      const next = new Set(communicationPairKeys);
      const key = canonicalPairKey(memberAId, memberBId);
      if (checked) next.add(key);
      else next.delete(key);
      onCommunicationPairKeysChange(next);
    },
    [communicationPairKeys, onCommunicationPairKeysChange]
  );
  const handleMemberAdded = useCallback(
    (memberId: string) => {
      onCommunicationPairKeysChange(
        pairKeysWithNewMember(members, communicationPairKeys, memberId)
      );
    },
    [communicationPairKeys, members, onCommunicationPairKeysChange]
  );
  const handleMemberRemoved = useCallback(
    (memberId: string) => {
      onWriterMemberIdsChange(
        new Set([...writerMemberIds].filter((id) => id !== memberId))
      );
      onCommunicationPairKeysChange(
        pairKeysWithoutMember(communicationPairKeys, memberId)
      );
      if (selectedCommunicationMemberId === memberId) {
        setSelectedCommunicationMemberId(null);
      }
    },
    [
      communicationPairKeys,
      onCommunicationPairKeysChange,
      onWriterMemberIdsChange,
      selectedCommunicationMemberId,
      writerMemberIds,
    ]
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
          <div className={SECTION_LABEL_CLASSES}>
            {t("agentOrgs.orgWizard.membersLabel")}
            <span className="ml-0.5 text-danger-6">*</span>
          </div>
          <div className={SECTION_DESCRIPTION_CLASSES}>
            {t("agentOrgs.orgWizard.membersDesc")}
          </div>
          <div className="border-info-3 bg-info-1 text-info-6 rounded-md border border-solid px-3 py-2 text-xs">
            {t("agentOrgs.orgWizard.futureTeamsOnly")}
          </div>
        </div>
        <SectionRow label="" showHeader={false}>
          <TeamMemberTable
            members={members}
            onChange={onMembersChange}
            agentOptions={agentOptions}
            writerMemberIds={writerMemberIds}
            connectedCountByMemberId={connectedCounts}
            onWriterChange={handleWriterChange}
            onManageCommunication={setSelectedCommunicationMemberId}
            onMemberAdded={handleMemberAdded}
            onMemberRemoved={handleMemberRemoved}
            onAddAgent={onAddAgent}
            labels={tableLabels}
            invalidNameRowIds={duplicateNameIds}
            invalidNameMessage={t("agentOrgs.orgWizard.memberNameDuplicate")}
            dataTestIdPrefix="agent-orgs-member"
          />
        </SectionRow>
      </SectionContainer>

      {onDelete ? (
        <SectionContainer title={t("agentOrgs.orgWizard.dangerZone")}>
          <SectionRow
            label={t("agentOrgs.orgWizard.deleteOrg")}
            description={t("agentOrgs.orgWizard.deleteOrgDesc")}
          >
            <Button
              variant="secondary"
              size="small"
              onClick={onDelete}
              data-testid="agent-orgs-org-delete-button"
            >
              {t("agentOrgs.orgWizard.deleteThisOrg")}
            </Button>
          </SectionRow>
        </SectionContainer>
      ) : null}

      <MemberCommunicationPanel
        key={selectedCommunicationMemberId ?? "closed"}
        selectedMemberId={selectedCommunicationMemberId}
        members={members}
        pairKeys={communicationPairKeys}
        onPairChange={handlePairChange}
        onClose={() => setSelectedCommunicationMemberId(null)}
      />
    </>
  );
};

export default AgentTeamFormSections;

export function isOrgDraftValid(args: {
  orgName: string;
  coordinatorAgentId: string;
  members: TeamMember[];
}): boolean {
  const { orgName, coordinatorAgentId, members } = args;
  return (
    orgName.trim().length > 0 &&
    coordinatorAgentId.trim().length > 0 &&
    members.length > 0 &&
    members.length <= MAX_AGENT_ORG_MEMBERS &&
    members.every(
      (member) =>
        member.name.trim().length > 0 && member.agentId.trim().length > 0
    ) &&
    findDuplicateMemberNameIds(members).size === 0
  );
}
