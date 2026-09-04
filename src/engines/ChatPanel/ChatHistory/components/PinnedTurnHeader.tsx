import React, { memo } from "react";

import type { OptimizedChatItem } from "../chatItemPipeline/types";
import type { ChatGroupMeta } from "../hooks/useChatGroups";
import {
  GroupHeaderRenderer,
  type GroupHeaderRendererProps,
} from "../renderers/GroupHeaderRenderer";

interface PinnedTurnHeaderProps {
  visible: boolean;
  sourceGroupIndex?: number;
  sourceGroupCount: number;
  header: OptimizedChatItem | null | undefined;
  meta: ChatGroupMeta | undefined;
  collapseLabelVariant?: GroupHeaderRendererProps["collapseLabelVariant"];
  tailTurnPhase: GroupHeaderRendererProps["tailTurnPhase"];
  hideUserMessage: boolean;
  defaultTurnCollapsed: boolean;
  turnCollapseInteractionAtRef: React.MutableRefObject<number>;
  onEditSubmit: GroupHeaderRendererProps["onEditSubmit"];
  onRestoreCheckpoint: GroupHeaderRendererProps["onRestoreCheckpoint"];
}

function samePinnedHeader(
  left: OptimizedChatItem | null | undefined,
  right: OptimizedChatItem | null | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.chunk_id === right.chunk_id &&
    left.type === right.type &&
    left.event?.id === right.event?.id &&
    left.event?.displayText === right.event?.displayText &&
    left.event?.createdAt === right.event?.createdAt
  );
}

function samePinnedMeta(
  left: ChatGroupMeta | undefined,
  right: ChatGroupMeta | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.turnId === right.turnId &&
    left.durationMs === right.durationMs &&
    left.itemCount === right.itemCount &&
    left.bodyEventCount === right.bodyEventCount &&
    left.previewText === right.previewText &&
    left.startMs === right.startMs &&
    left.endMs === right.endMs &&
    left.unloadedTurn?.turnId === right.unloadedTurn?.turnId
  );
}

function samePinnedTurnHeaderProps(
  previous: PinnedTurnHeaderProps,
  next: PinnedTurnHeaderProps
): boolean {
  return (
    previous.visible === next.visible &&
    previous.sourceGroupIndex === next.sourceGroupIndex &&
    previous.sourceGroupCount === next.sourceGroupCount &&
    previous.collapseLabelVariant === next.collapseLabelVariant &&
    previous.tailTurnPhase === next.tailTurnPhase &&
    previous.hideUserMessage === next.hideUserMessage &&
    previous.defaultTurnCollapsed === next.defaultTurnCollapsed &&
    previous.turnCollapseInteractionAtRef ===
      next.turnCollapseInteractionAtRef &&
    previous.onEditSubmit === next.onEditSubmit &&
    previous.onRestoreCheckpoint === next.onRestoreCheckpoint &&
    samePinnedHeader(previous.header, next.header) &&
    samePinnedMeta(previous.meta, next.meta)
  );
}

const PinnedTurnHeaderComponent: React.FC<PinnedTurnHeaderProps> = ({
  visible,
  sourceGroupIndex,
  sourceGroupCount,
  header,
  meta,
  collapseLabelVariant = "agent",
  tailTurnPhase,
  hideUserMessage,
  defaultTurnCollapsed,
  turnCollapseInteractionAtRef,
  onEditSubmit,
  onRestoreCheckpoint,
}) => {
  if (!visible || !header) return null;

  return (
    <div className="relative z-70">
      <GroupHeaderRenderer
        groupIndex={0}
        sourceGroupIndex={sourceGroupIndex}
        sourceGroupCount={sourceGroupCount}
        groupHeaders={[header]}
        groupMeta={meta ? [meta] : []}
        groupCount={1}
        collapseLabelVariant={collapseLabelVariant}
        tailTurnPhase={tailTurnPhase}
        hideUserMessage={hideUserMessage}
        defaultTurnCollapsed={defaultTurnCollapsed}
        suppressRoundGap
        turnCollapseInteractionAtRef={turnCollapseInteractionAtRef}
        onEditSubmit={onEditSubmit}
        onRestoreCheckpoint={onRestoreCheckpoint}
      />
    </div>
  );
};

const PinnedTurnHeader = memo(
  PinnedTurnHeaderComponent,
  samePinnedTurnHeaderProps
);

PinnedTurnHeader.displayName = "PinnedTurnHeader";

export default PinnedTurnHeader;
