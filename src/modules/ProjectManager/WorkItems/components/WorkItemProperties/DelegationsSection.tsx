import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import {
  FieldRow,
  type FieldRowVariant,
} from "@src/components/PropertyField/PropertyFieldEditable";
import { BotIcon, HugeiconsIcon } from "@src/icons";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

import type { WorkItemPropertyTranslator } from "./types";

interface DelegationsSectionProps {
  workItem: WorkItemExtended;
  t: WorkItemPropertyTranslator;
  fieldVariant?: FieldRowVariant;
}

export function DelegationsSection({
  workItem,
  t,
  fieldVariant = "row",
}: DelegationsSectionProps) {
  if (!workItem.delegations || workItem.delegations.length === 0) return null;

  return (
    <div
      className={
        fieldVariant === "pill"
          ? "relative flex min-h-7 min-w-0 max-w-[220px] items-center"
          : "relative flex min-h-8 w-full items-center"
      }
    >
      <FieldRow
        icon={
          <HugeiconsIcon
            icon={BotIcon}
            data-icon="bot"
            size={DROPDOWN_ITEM.iconSize}
          />
        }
        value={`${workItem.delegations.length} ${t("workItems.properties.delegations")}`}
        isSelected
        showChevron={false}
        variant={fieldVariant}
        suffix={
          <span className="rounded bg-primary-1 px-1.5 py-0.5 text-xs font-medium text-primary-6">
            {
              workItem.delegations.filter(
                (delegation) => delegation.status === "completed"
              ).length
            }{" "}
            {t("workItems.properties.delegationsCompleted")}
          </span>
        }
        onClick={() => {}}
      />
    </div>
  );
}
