import { AtSign } from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import type { Person } from "@src/types/core/shared";

interface WorkItemMentionPickerProps {
  members: readonly Person[];
  currentUserId: string;
  value: readonly string[];
  disabled?: boolean;
  onChange: (memberIds: string[]) => void;
}

/**
 * Explicit Work Item comment recipients.
 *
 * The picker writes member ids, never display names, so account renames do not
 * break notification routing. The visible @ affordance stays compact under the
 * composer and is shared by embedded and full-page Work Item threads.
 */
const WorkItemMentionPicker: React.FC<WorkItemMentionPickerProps> = ({
  members,
  currentUserId,
  value,
  disabled,
  onChange,
}) => {
  const { t } = useTranslation("projects");
  const options = useMemo<SelectOption[]>(
    () =>
      members
        .filter((member) => member.id !== currentUserId)
        .map((member) => ({
          value: member.id,
          label: member.name,
        })),
    [currentUserId, members]
  );

  if (options.length === 0) return null;

  return (
    <Select
      mode="multiple"
      size="mini"
      appearance="ghost"
      value={[...value]}
      options={options}
      prefix={<AtSign size={13} aria-hidden />}
      placeholder={t("workItems.activity.mentionPeople")}
      maxTagCount={2}
      showSearch
      disabled={disabled}
      panelZIndex={10001}
      dropdownWidthMode="min-match"
      onChange={(next) =>
        onChange(
          Array.isArray(next) ? next.map((memberId) => String(memberId)) : []
        )
      }
      dataTestId="work-item-comment-mentions"
      className="max-w-full self-start"
    />
  );
};

export default WorkItemMentionPicker;
