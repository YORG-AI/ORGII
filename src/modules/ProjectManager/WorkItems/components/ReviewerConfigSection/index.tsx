import { useAtomValue } from "jotai";
import React from "react";

import type {
  OrchestratorConfig,
  ReviewConfig,
  ReviewerRefType,
} from "@src/api/http/project";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import { builtInAgentsAtom } from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";

const REVIEWER_TYPE_OPTIONS: ReviewerRefType[] = [
  "self_review",
  "agent",
  "human",
];

const REVIEWER_TYPE_LABEL_KEYS: Record<ReviewerRefType, string> = {
  self_review: "workItems.agentSettings.reviewerSelfReview",
  agent: "workItems.agentSettings.reviewerAgent",
  human: "workItems.agentSettings.reviewerHuman",
  org: "workItems.agentSettings.reviewerAgent",
};

interface ReviewerConfigSectionProps {
  config: OrchestratorConfig;
  onUpdateConfig: (updates: Partial<OrchestratorConfig>) => void;
  availableAgents: AgentDefinition[];
  t: (key: string) => string;
}

const ReviewerConfigSection: React.FC<ReviewerConfigSectionProps> = ({
  config,
  onUpdateConfig,
  availableAgents,
  t,
}) => {
  const builtInAgents = useAtomValue(builtInAgentsAtom);

  const reviewConfig: ReviewConfig = config.review_config ?? {
    reviewer: { type: "self_review" },
    max_rounds: 3,
  };

  const handleReviewerTypeChange = (
    value: string | number | (string | number)[]
  ) => {
    const newType = value as ReviewerRefType;
    onUpdateConfig({
      review_config: {
        ...reviewConfig,
        reviewer: { type: newType, id: undefined },
      },
    });
  };

  const handleAgentSelect = (value: string | number | (string | number)[]) => {
    const id = (value as string) || undefined;
    onUpdateConfig({
      review_config: {
        ...reviewConfig,
        reviewer: { type: "agent", id },
      },
    });
  };

  const handleMaxRoundsChange = (value: string) => {
    const rounds = Math.max(1, Math.min(10, Number(value) || 1));
    onUpdateConfig({
      review_config: { ...reviewConfig, max_rounds: rounds },
    });
  };

  const allAgents = [
    ...builtInAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
    })),
    ...availableAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
    })),
  ];

  return (
    <div className="space-y-2 rounded-md bg-fill-1 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-text-3">
          {t("workItems.agentSettings.reviewerType")}
        </span>
        <Select
          value={reviewConfig.reviewer.type}
          options={REVIEWER_TYPE_OPTIONS.map((type) => ({
            value: type,
            label: t(REVIEWER_TYPE_LABEL_KEYS[type]),
          }))}
          onChange={handleReviewerTypeChange}
          size="mini"
          dropdownWidthMode="match"
        />
      </div>
      {reviewConfig.reviewer.type === "agent" && allAgents.length > 0 && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-text-3">Agent</span>
          <Select
            value={reviewConfig.reviewer.id ?? ""}
            options={[
              { value: "", label: "—" },
              ...allAgents.map((agent) => ({
                value: agent.id,
                label: agent.name,
              })),
            ]}
            onChange={handleAgentSelect}
            size="mini"
            className="max-w-[140px]"
            dropdownWidthMode="match"
          />
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-text-3">
          {t("workItems.agentSettings.maxReviewRounds")}
        </span>
        <Input
          type="number"
          min={1}
          max={10}
          value={String(reviewConfig.max_rounds)}
          onChange={handleMaxRoundsChange}
          size="mini"
          className="w-14"
          inputClassName="text-center"
        />
      </div>
    </div>
  );
};

export default ReviewerConfigSection;
