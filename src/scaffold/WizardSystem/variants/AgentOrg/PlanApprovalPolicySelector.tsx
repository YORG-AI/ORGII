import React from "react";
import { useTranslation } from "react-i18next";

import Select from "@src/components/Select";
import {
  PLAN_APPROVAL_POLICIES,
  type PlanApprovalPolicy,
} from "@src/modules/MainApp/AgentOrgs/types";
import { SECTION_CONTROL_STYLE } from "@src/modules/shared/layouts/SectionLayout/tokens";
import { HintWithInfo } from "@src/modules/shared/layouts/blocks";

interface PlanApprovalPolicySelectorProps {
  value: PlanApprovalPolicy;
  onChange: (next: PlanApprovalPolicy) => void;
}

const PlanApprovalPolicySelector: React.FC<PlanApprovalPolicySelectorProps> = ({
  value,
  onChange,
}) => {
  const { t } = useTranslation("integrations");
  const options = PLAN_APPROVAL_POLICIES.map((policy) => ({
    label: t(`agentOrgs.orgWizard.planApprovalPolicy.${policy}.label`),
    value: policy,
    dataTestId: `agent-orgs-plan-approval-policy-${policy}`,
  }));
  const tooltipContent = (
    <div className="flex flex-col gap-2">
      {PLAN_APPROVAL_POLICIES.map((policy) => (
        <div key={policy}>
          <strong>
            {t(`agentOrgs.orgWizard.planApprovalPolicy.${policy}.label`)}
          </strong>
          <div>
            {t(`agentOrgs.orgWizard.planApprovalPolicy.${policy}.description`)}
          </div>
        </div>
      ))}
    </div>
  );
  return (
    <div className="flex items-center gap-2">
      <HintWithInfo content={tooltipContent} position="left" />
      <Select
        value={value}
        size="default"
        onChange={(next) => onChange(next as PlanApprovalPolicy)}
        options={options}
        style={SECTION_CONTROL_STYLE}
        dataTestId="agent-orgs-plan-approval-policy-select"
      />
    </div>
  );
};

export default PlanApprovalPolicySelector;
