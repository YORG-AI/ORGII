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
import type { TeamMember } from "@src/components/TeamMemberTable";
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
  linksToPairSet,
  sortedLinksFromPairSet,
  toFlatOrgMembers,
  toTeamMembers,
} from "@src/scaffold/WizardSystem/variants/AgentOrg/orgTree";

import { builtInAgentsAtom } from "../store/builtInAgentsAtom";
import {
  type AgentDefinition,
  DEFAULT_PLAN_APPROVAL_POLICY,
  type OrgDefinition,
  type PlanApprovalPolicy,
} from "../types";
import { buildAgentOptions } from "./org/config";
import "./org/index.scss";

interface OrgDetailViewProps {
  selectedOrg: OrgDefinition;
  customAgents: AgentDefinition[];
  onOrgSave: (org: OrgDefinition) => void | Promise<void>;
  onOrgDelete: (orgId: string) => void | Promise<void>;
}

function setSignature(values: ReadonlySet<string>): string {
  return JSON.stringify([...values].sort());
}

const OrgDetailView: React.FC<OrgDetailViewProps> = ({
  selectedOrg,
  customAgents,
  onOrgSave,
  onOrgDelete,
}) => {
  const { t } = useTranslation("integrations");
  const builtInAgents = useAtomValue(builtInAgentsAtom);
  const [orgName, setOrgName] = useState(selectedOrg.name);
  const [orgDescription, setOrgDescription] = useState(
    selectedOrg.description ?? ""
  );
  const [coordinatorAgentId, setCoordinatorAgentId] = useState(
    selectedOrg.agentId
  );
  const [planApprovalPolicy, setPlanApprovalPolicy] =
    useState<PlanApprovalPolicy>(
      selectedOrg.planApprovalPolicy ?? DEFAULT_PLAN_APPROVAL_POLICY
    );
  const [members, setMembers] = useState<TeamMember[]>(() =>
    toTeamMembers(selectedOrg.members)
  );
  const [writerMemberIds, setWriterMemberIds] = useState<Set<string>>(
    () => new Set(selectedOrg.additionalTaskGraphWriterMemberIds)
  );
  const [communicationPairKeys, setCommunicationPairKeys] = useState<
    Set<string>
  >(() => linksToPairSet(selectedOrg.memberCommunicationLinks));
  const [saving, setSaving] = useState(false);
  const activeOrgIdRef = useRef(selectedOrg.id);

  const resetDraft = useCallback(() => {
    setOrgName(selectedOrg.name);
    setOrgDescription(selectedOrg.description ?? "");
    setCoordinatorAgentId(selectedOrg.agentId);
    setPlanApprovalPolicy(
      selectedOrg.planApprovalPolicy ?? DEFAULT_PLAN_APPROVAL_POLICY
    );
    setMembers(toTeamMembers(selectedOrg.members));
    setWriterMemberIds(new Set(selectedOrg.additionalTaskGraphWriterMemberIds));
    setCommunicationPairKeys(
      linksToPairSet(selectedOrg.memberCommunicationLinks)
    );
  }, [selectedOrg]);

  useEffect(() => {
    if (activeOrgIdRef.current === selectedOrg.id) return;
    activeOrgIdRef.current = selectedOrg.id;
    resetDraft();
    setSaving(false);
  }, [resetDraft, selectedOrg.id]);

  const agentOptions = useMemo(
    () => buildAgentOptions(customAgents, builtInAgents),
    [customAgents, builtInAgents]
  );
  const draftMembersJson = JSON.stringify(members);
  const persistedMembersJson = JSON.stringify(
    toTeamMembers(selectedOrg.members)
  );
  const isDirty =
    orgName !== selectedOrg.name ||
    orgDescription !== (selectedOrg.description ?? "") ||
    coordinatorAgentId !== selectedOrg.agentId ||
    planApprovalPolicy !== selectedOrg.planApprovalPolicy ||
    draftMembersJson !== persistedMembersJson ||
    setSignature(writerMemberIds) !==
      setSignature(new Set(selectedOrg.additionalTaskGraphWriterMemberIds)) ||
    setSignature(communicationPairKeys) !==
      setSignature(linksToPairSet(selectedOrg.memberCommunicationLinks));
  const isValid = isOrgDraftValid({ orgName, coordinatorAgentId, members });

  const handleSave = useCallback(async () => {
    if (!isValid || saving) return;
    setSaving(true);
    try {
      const trimmedDescription = orgDescription.trim();
      await onOrgSave({
        id: selectedOrg.id,
        name: orgName.trim(),
        role: selectedOrg.role,
        agentId: coordinatorAgentId,
        description:
          trimmedDescription.length > 0 ? trimmedDescription : undefined,
        planApprovalPolicy,
        members: toFlatOrgMembers(members),
        additionalTaskGraphWriterMemberIds: [...writerMemberIds].sort(),
        memberCommunicationLinks: sortedLinksFromPairSet(communicationPairKeys),
      });
    } finally {
      setSaving(false);
    }
  }, [
    communicationPairKeys,
    coordinatorAgentId,
    isValid,
    members,
    onOrgSave,
    orgDescription,
    orgName,
    planApprovalPolicy,
    saving,
    selectedOrg.id,
    selectedOrg.role,
    writerMemberIds,
  ]);

  const tabs = useMemo(
    () => [{ key: "core", label: t("agentOrgs.cliAgentDetail.tabCore") }],
    [t]
  );

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
        tabs={
          <TabPill
            tabs={tabs}
            activeTab="core"
            onChange={() => {}}
            variant="simple"
            fillWidth={false}
            size="large"
          />
        }
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
              planApprovalPolicy={planApprovalPolicy}
              onPlanApprovalPolicyChange={setPlanApprovalPolicy}
              members={members}
              onMembersChange={setMembers}
              writerMemberIds={writerMemberIds}
              onWriterMemberIdsChange={setWriterMemberIds}
              communicationPairKeys={communicationPairKeys}
              onCommunicationPairKeysChange={setCommunicationPairKeys}
              agentOptions={agentOptions}
              onDelete={() => onOrgDelete(selectedOrg.id)}
            />
          </div>
        </div>
      </div>
      {isDirty ? (
        <PanelFooter
          secondaryActions={[
            {
              label: t("common:actions.cancel"),
              onClick: resetDraft,
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
      ) : null}
    </DetailPanelContainer>
  );
};

export default OrgDetailView;
