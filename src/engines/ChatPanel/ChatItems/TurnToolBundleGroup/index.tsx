import { Bot } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import type { OptimizedChatItem } from "@src/engines/ChatPanel/ChatHistory/chatItemPipeline/types";
import {
  buildTurnToolBundleTypeSummary,
  countTurnToolBundleItems,
  findFirstBundledEventId,
} from "@src/engines/ChatPanel/ChatHistory/turnToolBundle";
import { StackedBlock } from "@src/engines/ChatPanel/blocks/primitives";
import { EventBlockHeaderInfo } from "@src/engines/ChatPanel/blocks/primitives/EventBlockHeaderTextSlots";

export interface TurnToolBundleGroupProps {
  items: OptimizedChatItem[];
  renderItem: (item: OptimizedChatItem, index: number) => React.ReactNode;
}

const TurnToolBundleGroup: React.FC<TurnToolBundleGroupProps> = ({
  items,
  renderItem,
}) => {
  const { t } = useTranslation("sessions");
  const count = countTurnToolBundleItems(items);
  const firstEventId = findFirstBundledEventId(items);
  const typeSummary = buildTurnToolBundleTypeSummary(items, t);

  if (count === 0) {
    return null;
  }

  return (
    <StackedBlock
      items={items}
      icon={<Bot size={14} className="text-text-2" />}
      label={t("chat.collapseToolBlocksLabel")}
      groupSummary={t("chat.collapseToolBlocksSummary", { count })}
      showGroupSummaryWhenCollapsed={true}
      defaultCollapsed={true}
      eventId={firstEventId}
      contentMaxHeightPx={null}
      rightContent={
        typeSummary ? (
          <EventBlockHeaderInfo className="max-w-[min(50vw,16rem)] truncate">
            <span title={typeSummary}>{typeSummary}</span>
          </EventBlockHeaderInfo>
        ) : undefined
      }
      renderItem={renderItem}
    />
  );
};

export default TurnToolBundleGroup;
