import { AtSign, Network, User } from "lucide-react";
import React from "react";

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
import type {
  AgentDefinition,
  OrgMember,
} from "@src/modules/MainApp/AgentOrgs/types";
import type { Person } from "@src/types/core/shared";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

interface AssigneeDropdownProps {
  workItem: WorkItemExtended;
  availableMembers: Person[];
  availableAgents: AgentDefinition[];
  availableOrgs: OrgMember[];
  allAgentList: { id: string; name: string }[];
  onAssigneeChange: (person: Person | null, assigneeType?: string) => void;
  t: (key: string) => string;
  fieldVariant?: FieldRowVariant;
}

export const AssigneeDropdown: React.FC<AssigneeDropdownProps> = ({
  workItem,
  availableMembers,
  availableAgents: _availableAgents,
  availableOrgs,
  allAgentList,
  onAssigneeChange,
  t,
  fieldVariant = "row",
}) => (
  <SearchableDropdown
    placeholder={t("properties.searchAssignee")}
    widthMode={fieldVariant === "pill" ? "menu" : "match-parent"}
    align={fieldVariant === "pill" ? "auto" : "left"}
  >
    {(searchQuery) => {
      const query = searchQuery?.toLowerCase() ?? "";
      const filteredMembers = query
        ? availableMembers.filter((person) =>
            person.name.toLowerCase().includes(query)
          )
        : availableMembers;
      const filteredAgents = query
        ? allAgentList.filter((agent) =>
            agent.name.toLowerCase().includes(query)
          )
        : allAgentList;
      const filteredOrgs = query
        ? availableOrgs.filter((org) => org.name.toLowerCase().includes(query))
        : availableOrgs;

      return (
        <>
          <Option
            icon={<User size={DROPDOWN_ITEM.iconSize} />}
            label={t("workItems.properties.noAssignee")}
            isSelected={!workItem.assignee}
            onClick={() => onAssigneeChange(null)}
          />
          {filteredMembers.length > 0 && (
            <div className={DROPDOWN_CLASSES.sectionLabel}>
              {t("workItems.properties.membersGroup")}
            </div>
          )}
          {filteredMembers.map((person) => (
            <Option
              key={person.id}
              isSelected={workItem.assignee?.id === person.id}
              label={person.name}
              onClick={() => onAssigneeChange(person)}
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
          ))}
          {filteredAgents.length > 0 && (
            <div className={DROPDOWN_CLASSES.sectionLabel}>
              {t("workItems.properties.agentsGroup")}
            </div>
          )}
          {filteredAgents.map((agent) => {
            const isAssigned =
              workItem.assignee?.id === agent.id &&
              workItem.assigneeType === "agent";
            const isRunning =
              isAssigned && workItem.workItemStatus === "in_progress";
            return (
              <Option
                key={`agent-${agent.id}`}
                isSelected={isAssigned}
                label={agent.name}
                onClick={() =>
                  onAssigneeChange({ id: agent.id, name: agent.name }, "agent")
                }
              >
                <div className="relative shrink-0">
                  <AtSign
                    size={DROPDOWN_ITEM.iconSize}
                    className="text-primary-6"
                  />
                  {isRunning && (
                    <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-green-500 ring-1 ring-bg-1">
                      <span className="absolute inset-0 animate-ping rounded-full bg-green-400 opacity-75" />
                    </span>
                  )}
                </div>
                <span className="flex-1 truncate">{agent.name}</span>
              </Option>
            );
          })}
          {filteredOrgs.length > 0 && (
            <div className={DROPDOWN_CLASSES.sectionLabel}>
              {t("workItems.properties.orgsGroup")}
            </div>
          )}
          {filteredOrgs.map((org) => {
            const memberCount = org.children?.length ?? 0;
            return (
              <Option
                key={`org-${org.id}`}
                isSelected={
                  workItem.assignee?.id === org.id &&
                  workItem.assigneeType === "org"
                }
                label={org.name}
                onClick={() =>
                  onAssigneeChange({ id: org.id, name: org.name }, "org")
                }
              >
                <Network
                  size={DROPDOWN_ITEM.iconSize}
                  className="text-primary-6"
                />
                <span className="flex-1 truncate">{org.name}</span>
                {memberCount > 0 && (
                  <span className="rounded bg-fill-3 px-1 py-0.5 text-[10px] text-text-3">
                    {memberCount}
                  </span>
                )}
              </Option>
            );
          })}
          {availableMembers.length === 0 &&
            allAgentList.length === 0 &&
            filteredOrgs.length === 0 &&
            !searchQuery && (
              <div className={DROPDOWN_CLASSES.listMessage}>
                {t("workItems.properties.noMembersHint")}
              </div>
            )}
        </>
      );
    }}
  </SearchableDropdown>
);
