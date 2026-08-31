import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import { AtIcon, HugeiconsIcon } from "@src/icons";
import type { Person } from "@src/types/core/shared";

import { ALL_MENTION_REF, type MentionCandidate } from "./workItemMentions";

interface WorkItemMentionPickerProps {
  members: readonly Person[];
  agents?: readonly MentionCandidate[];
  agentOrgs?: readonly MentionCandidate[];
  currentUserId: string;
  value: readonly string[];
  disabled?: boolean;
  onChange: (mentionRefs: string[]) => void;
}

/**
 * Explicit Work Item comment recipients. Option values are encoded mention
 * refs ("member:x" / "agent:y" / "agent_org:z" / "all"), never display names,
 * so renames do not break routing or notifications.
 */
const WorkItemMentionPicker: React.FC<WorkItemMentionPickerProps> = ({
  members,
  agents = [],
  agentOrgs = [],
  currentUserId,
  value,
  disabled,
  onChange,
}) => {
  const { t } = useTranslation("projects");
  const options = useMemo<SelectOption[]>(() => {
    const memberOptions = members
      .filter((member) => member.id !== currentUserId)
      .map((member) => ({
        value: `member:${member.id}`,
        label: member.name,
      }));
    const agentOptions = agents.map((agent) => ({
      value: `agent:${agent.id}`,
      label: t("workItems.activity.mentionAgentOption", {
        defaultValue: "{{name}} (agent)",
        name: agent.name,
      }),
    }));
    const orgOptions = agentOrgs.map((org) => ({
      value: `agent_org:${org.id}`,
      label: t("workItems.activity.mentionAgentOrgOption", {
        defaultValue: "{{name}} (agent org)",
        name: org.name,
      }),
    }));
    const allOption =
      memberOptions.length + agentOptions.length + orgOptions.length > 0
        ? [
            {
              value: ALL_MENTION_REF,
              label: t("workItems.activity.mentionAll", {
                defaultValue: "@all — everyone on this item",
              }),
            },
          ]
        : [];
    return [...allOption, ...agentOptions, ...orgOptions, ...memberOptions];
  }, [agentOrgs, agents, currentUserId, members, t]);

  if (options.length === 0) return null;

  return (
    <Select
      mode="multiple"
      size="mini"
      appearance="ghost"
      value={[...value]}
      options={options}
      prefix={
        <HugeiconsIcon
          icon={AtIcon}
          data-icon="at-sign"
          size={13}
          aria-hidden
        />
      }
      placeholder={t("workItems.activity.mentionPeople")}
      maxTagCount={2}
      showSearch
      disabled={disabled}
      panelZIndex={10001}
      dropdownWidthMode="min-match"
      onChange={(next) =>
        onChange(Array.isArray(next) ? next.map((ref) => String(ref)) : [])
      }
      dataTestId="work-item-comment-mentions"
      className="max-w-full self-start"
    />
  );
};

export default WorkItemMentionPicker;
