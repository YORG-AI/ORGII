import { AtSign, ScanEye, User } from "lucide-react";
import React from "react";

import type { ReviewerRefType } from "@src/api/http/project";
import Avatar from "@src/components/Avatar";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import {
  type FieldRowVariant,
  Option,
  SearchableDropdown,
} from "@src/components/PropertyField/PropertyFieldEditable";
import type { Person } from "@src/types/core/shared";

interface ReviewerRef {
  type?: string;
  id?: string;
}

interface ReviewerDropdownProps {
  allAgentList: { id: string; name: string }[];
  availableMembers: Person[];
  currentReviewer: ReviewerRef | undefined;
  onReviewerChange: (
    reviewerType: ReviewerRefType | null,
    reviewerId?: string
  ) => void;
  t: (key: string) => string;
  fieldVariant?: FieldRowVariant;
}

export const ReviewerDropdown: React.FC<ReviewerDropdownProps> = ({
  allAgentList,
  availableMembers,
  currentReviewer,
  onReviewerChange,
  t,
  fieldVariant = "row",
}) => (
  <SearchableDropdown
    placeholder={t("common:actions.search")}
    widthMode={fieldVariant === "pill" ? "menu" : "match-parent"}
    align={fieldVariant === "pill" ? "auto" : "left"}
  >
    {(searchQuery) => {
      const query = searchQuery?.toLowerCase() ?? "";
      const filteredAgents = query
        ? allAgentList.filter((agent) =>
            agent.name.toLowerCase().includes(query)
          )
        : allAgentList;
      const filteredMembers = query
        ? availableMembers.filter((person) =>
            person.name.toLowerCase().includes(query)
          )
        : availableMembers;

      return (
        <>
          <Option
            icon={<ScanEye size={DROPDOWN_ITEM.iconSize} />}
            label={t("workItems.properties.noReviewer")}
            isSelected={!currentReviewer}
            onClick={() => onReviewerChange(null)}
          />
          {!searchQuery && (
            <Option
              icon={<User size={DROPDOWN_ITEM.iconSize} />}
              label={t("workItems.agentSettings.reviewerSelfReview")}
              isSelected={currentReviewer?.type === "self_review"}
              onClick={() => onReviewerChange("self_review")}
            />
          )}
          {filteredAgents.length > 0 && (
            <div className={DROPDOWN_CLASSES.sectionLabel}>
              {t("workItems.properties.agentsGroup")}
            </div>
          )}
          {filteredAgents.map((agent) => {
            const isSelected =
              currentReviewer?.type === "agent" &&
              currentReviewer?.id === agent.id;
            return (
              <Option
                key={`rev-agent-${agent.id}`}
                isSelected={isSelected}
                label={agent.name}
                onClick={() => onReviewerChange("agent", agent.id)}
              >
                <AtSign
                  size={DROPDOWN_ITEM.iconSize}
                  className="text-primary-6"
                />
                <span className="flex-1 truncate">{agent.name}</span>
              </Option>
            );
          })}
          {filteredMembers.length > 0 && (
            <div className={DROPDOWN_CLASSES.sectionLabel}>
              {t("workItems.properties.membersGroup")}
            </div>
          )}
          {filteredMembers.map((person) => {
            const isSelected =
              currentReviewer?.type === "human" &&
              currentReviewer?.id === person.id;
            return (
              <Option
                key={`rev-human-${person.id}`}
                isSelected={isSelected}
                label={person.name}
                onClick={() => onReviewerChange("human", person.id)}
              >
                <Avatar
                  size={DROPDOWN_ITEM.iconSize}
                  src={person.avatar}
                  style={{
                    backgroundColor: person.color || "var(--color-fill-3)",
                    color: "var(--color-text-white)",
                    fontSize: "11px",
                  }}
                >
                  {person.name.charAt(0).toUpperCase()}
                </Avatar>
                <span className="flex-1 truncate">{person.name}</span>
              </Option>
            );
          })}
        </>
      );
    }}
  </SearchableDropdown>
);
