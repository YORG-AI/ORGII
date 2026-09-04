/**
 * ChatHistoryListEquality
 *
 * Prop/value equality helpers backing `ChatHistoryList`'s `React.memo`
 * comparator. Extracted from `ChatHistoryList.tsx` to keep that file under
 * the 600-line limit.
 */
import {
  LLM_USAGE_ARGS_KEY,
  TOOL_USAGE_ARGS_KEY,
} from "@src/engines/SessionCore/core/types";

import type { OptimizedChatItem } from "../chatItemPipeline/types";
import { CHAT_FOOTER_SPACER } from "../config/chatFooterSpacer";
import type {
  ChatHistoryListProps,
  EventSummary,
} from "./ChatHistoryListTypes";

function sameNumberArray(
  left: readonly number[],
  right: readonly number[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameNullableStringArray(
  left: readonly (string | null)[],
  right: readonly (string | null)[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

const RESULT_RENDER_KEYS = [
  "type",
  "message",
  "content",
  "observation",
  "success",
  "failure",
  "error",
  "images",
  "call_id",
  "output",
  "stdout",
  "stderr",
  "interleaved_output",
  "interleavedOutput",
  "diff",
  "diffString",
  "segments",
  "filePaths",
  "linesAdded",
  "linesRemoved",
  "status",
] as const;

const ARG_RENDER_KEYS = [
  "command",
  "streamOutput",
  "streamContent",
  "title",
  "action",
  "content",
  "path",
  "file_path",
  "target_file",
  "patch_text",
  "old_str",
  "old_string",
  "old_content",
  "new_str",
  "new_string",
  "new_content",
  "subagentSessionId",
  TOOL_USAGE_ARGS_KEY,
  LLM_USAGE_ARGS_KEY,
] as const;

function sameRecordKeys(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
  keys: readonly string[]
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return keys.every((key) => left[key] === right[key]);
}

function sameEventSummary(
  left: EventSummary | undefined,
  right: EventSummary | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.id === right.id &&
    left.actionType === right.actionType &&
    left.functionName === right.functionName &&
    left.uiCanonical === right.uiCanonical &&
    left.displayText === right.displayText &&
    left.displayStatus === right.displayStatus &&
    left.displayVariant === right.displayVariant &&
    left.activityStatus === right.activityStatus &&
    left.shellPid === right.shellPid &&
    left.shellProcessStatus === right.shellProcessStatus &&
    left.shellExitCode === right.shellExitCode &&
    left.shellLogPath === right.shellLogPath &&
    left.extracted === right.extracted &&
    left.payloadRefs === right.payloadRefs &&
    sameRecordKeys(left.result, right.result, RESULT_RENDER_KEYS) &&
    sameRecordKeys(left.args, right.args, ARG_RENDER_KEYS)
  );
}

function sameEventList(
  left: readonly EventSummary[] | undefined,
  right: readonly EventSummary[] | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((leftEvent, index) =>
    sameEventSummary(leftEvent, right[index])
  );
}

function sameFlatItems(
  left: readonly OptimizedChatItem[],
  right: readonly OptimizedChatItem[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((leftItem, index) => {
    const rightItem = right[index];
    return (
      rightItem !== undefined &&
      leftItem.chunk_id === rightItem.chunk_id &&
      leftItem.type === rightItem.type &&
      leftItem.consolidatedParts === rightItem.consolidatedParts &&
      leftItem.structuralOnly === rightItem.structuralOnly &&
      sameEventSummary(leftItem.event, rightItem.event) &&
      sameEventList(leftItem.readFileEvents, rightItem.readFileEvents) &&
      sameEventList(
        leftItem.activityStackGroup?.events,
        rightItem.activityStackGroup?.events
      ) &&
      sameEventList(
        leftItem.actionSummaryItems?.map((item) => item.event),
        rightItem.actionSummaryItems?.map((item) => item.event)
      )
    );
  });
}

export function sameChatHistoryListProps(
  previous: ChatHistoryListProps,
  next: ChatHistoryListProps
): boolean {
  const sameFooterSpacer =
    Math.abs(previous.footerSpacerHeight - next.footerSpacerHeight) <
    CHAT_FOOTER_SPACER.UPDATE_THRESHOLD_PX;
  const checks: Array<[string, boolean]> = [
    ["flatItems", sameFlatItems(previous.flatItems, next.flatItems)],
    ["groupCounts", sameNumberArray(previous.groupCounts, next.groupCounts)],
    ["turnIds", sameNullableStringArray(previous.turnIds, next.turnIds)],
    ["totalFlatItems", previous.totalFlatItems === next.totalFlatItems],
    [
      "codeBlockContainerWidth",
      previous.codeBlockContainerWidth === next.codeBlockContainerWidth,
    ],
    ["footerSpacerHeight", sameFooterSpacer],
    ["bottomInset", previous.bottomInset === next.bottomInset],
    ["topPaddingPx", previous.topPaddingPx === next.topPaddingPx],
    [
      "planningIndicatorCount",
      previous.planningIndicatorCount === next.planningIndicatorCount,
    ],
    [
      "planningVariantIndex",
      previous.planningVariantIndex === next.planningVariantIndex,
    ],
    [
      "planningFooterMode",
      previous.planningFooterMode === next.planningFooterMode,
    ],
    ["virtualListRef", previous.virtualListRef === next.virtualListRef],
    [
      "virtualListDataKey",
      previous.virtualListDataKey === next.virtualListDataKey,
    ],
    [
      "getIsWpGeneWorking",
      previous.getIsWpGeneWorking === next.getIsWpGeneWorking,
    ],
    ["getIsExploring", previous.getIsExploring === next.getIsExploring],
    [
      "renderGroupHeader",
      previous.renderGroupHeader === next.renderGroupHeader,
    ],
    [
      "onAtBottomStateChange",
      previous.onAtBottomStateChange === next.onAtBottomStateChange,
    ],
    ["onRangeChanged", previous.onRangeChanged === next.onRangeChanged],
    [
      "onActiveGroupIndexChange",
      previous.onActiveGroupIndexChange === next.onActiveGroupIndexChange,
    ],
    [
      "hideActiveGroupHeader",
      previous.hideActiveGroupHeader === next.hideActiveGroupHeader,
    ],
    ["onEndReached", previous.onEndReached === next.onEndReached],
    ["onRegenerate", previous.onRegenerate === next.onRegenerate],
    ["onSubmit", previous.onSubmit === next.onSubmit],
    ["onSkip", previous.onSkip === next.onSkip],
    [
      "onEditUserMessage",
      previous.onEditUserMessage === next.onEditUserMessage,
    ],
    [
      "virtualScrollerRef",
      previous.virtualScrollerRef === next.virtualScrollerRef,
    ],
    [
      "staticScrollerRef",
      previous.staticScrollerRef === next.staticScrollerRef,
    ],
    [
      "newEventDividerLabel",
      previous.newEventDividerLabel === next.newEventDividerLabel,
    ],
  ];
  return checks.every(([, same]) => same);
}
