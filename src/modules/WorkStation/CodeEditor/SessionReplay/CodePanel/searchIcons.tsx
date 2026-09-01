import React from "react";

import { getToolIcon } from "@src/config/toolIcons";
import { resolveToolName } from "@src/engines/SessionCore/rendering/registry/toolAliases";

export const SEARCH_ROW_ICON_CLASS = "shrink-0 text-text-3";
export const SEARCH_ROW_ICON_SIZE = 14;

/**
 * Resolve the icon for a search operation using the Rust tool registry.
 * Falls back to `functionName` lookup when available; otherwise uses
 * the same `getToolIcon` path as the chat panel's ToolCallBlock.
 */
export function simulatorSearchHeaderIcon(
  functionName?: string
): React.ReactNode {
  const toolName = resolveToolName(functionName ?? "code_search");
  return getToolIcon(toolName, {
    size: SEARCH_ROW_ICON_SIZE,
    className: "shrink-0 text-text-2",
  });
}
