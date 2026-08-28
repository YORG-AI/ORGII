/**
 * Icons for Tool Preview sidebar rows. Keys are mock registry ids from
 * {@link MOCK_EVENT_DATA}; use {@link getToolIcon} with the underlying tool name when the id
 * is not a registered tool (avoids falling through to Wrench).
 */
import React from "react";

import { getToolIcon } from "@src/config/toolIcons";
import { HugeiconsIcon, Message01Icon } from "@src/icons";

import { isChatPreviewType } from "../single-event/chatPreviewTypes";

const PLAYGROUND_ROW_ICON_SIZE = 13;

// Some mock keys are synthetic variants of a real tool (e.g.
// `await_output_subagent`). Map them back to the underlying tool + action
// so the icon resolver can pick the right action-specific icon.
const SYNTHETIC_MOCK_TO_TOOL: Record<
  string,
  { toolName: string; action?: string }
> = {
  await_output_subagent: { toolName: "await_output", action: "monitor" },
  await_output_multi: { toolName: "await_output", action: "monitor" },
  await_output_list: { toolName: "await_output", action: "list" },
};

export function getPlaygroundMockEventRowIcon(
  eventTypeKey: string
): React.ReactNode {
  if (isChatPreviewType(eventTypeKey)) {
    return (
      <HugeiconsIcon
        icon={Message01Icon}
        data-icon="message-square"
        size={PLAYGROUND_ROW_ICON_SIZE}
      />
    );
  }

  const synthetic = SYNTHETIC_MOCK_TO_TOOL[eventTypeKey];
  if (synthetic) {
    return getToolIcon(synthetic.toolName, {
      size: PLAYGROUND_ROW_ICON_SIZE,
      action: synthetic.action,
    });
  }
  return getToolIcon(eventTypeKey, { size: PLAYGROUND_ROW_ICON_SIZE });
}
