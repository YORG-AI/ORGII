/**
 * Unified Event Registry
 *
 * Exports for the unified event registry system.
 *
 * NOTE: Runtime maps only - no static fallbacks. Tests inject fixtures via vitest.setup.ts.
 */
export * from "./types";
export * from "./constants";

// Unified tool registry (single source of truth)
export {
  // Init
  initToolRegistry,
  // Getters
  getAppTypeForTool,
  getAppSubtool,
  getActionChatBlock,
  getBuiltinSimulatorApp,
  getBuiltinToolIconId,
  getBuiltinToolActionIconId,
  getBuiltinToolStatusIconId,
  getToolActions,
  getToolDisplayBehavior,
  getActionLabels,
  getToolLabel,
  getCliSimulatorApp,
  getCliUiCanonical,
  getCliStorageCanonical,
  resolveCliAlias,
  getAllCliAliasKeys,
  // Test utilities
  _resetToolRegistry,
  _setBuiltinSimulatorMap,
  _setBuiltinIconIdMap,
  _setBuiltinAppSubtoolMap,
  _setBuiltinChatBlockMap,
  _setBuiltinDisplayBehaviorMap,
  _setBuiltinLabelsMap,
  _setBuiltinActionsMap,
  _setCliToolAliasMap,
  // Types
  type AppSubtool,
  type ChatBlock,
  type AliasEntry,
  type ToolActionInfo,
  type ToolDisplayBehavior,
} from "./initToolRegistry";

export {
  statusToLifecycle,
  useLifecycleLabels,
  useToolLabelText,
  type LifecycleState,
  type LifecycleLabelText,
} from "./useToolLabel";

export { resolveToolName } from "./toolAliases";
export { getIDEEventType, isDeleteTool } from "./toolRegistryDomain";
export {
  // Tool type detection
  isBrowserTool,
  isSearchTool,
  isFileTool,
  isShellTool,
  isMessageTool,
  hasStyledOutput,
  // Activity grouping
  getActivitySummaryCategory,
  type ActivitySummaryCategory,
} from "./toolCategories";

// React-coupled event component registry (COMPONENT_LOADERS / CONTEXT_CONFIG etc.)
export * from "./events";
export {
  getActionConfig,
  shouldShowStatusLine,
  requiresItemIndex,
  getRegisteredActionTypes,
  prefetchCommonComponents,
} from "./registryAccessors";
export type { ComponentOption } from "./registryAccessors";
