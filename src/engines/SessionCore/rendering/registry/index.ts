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
  getBuiltinToolIconId,
  getToolDisplayBehavior,
  getActionLabels,
  getToolLabel,
  getCliUiCanonical,
  // Types
  type AppSubtool,
  type ChatBlock,
} from "./initToolRegistry";

export {
  statusToLifecycle,
  useLifecycleLabels,
  useToolLabelText,
} from "./useToolLabel";

export { resolveToolName } from "./toolAliases";
export { getIDEEventType } from "./toolRegistryDomain";
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
export { getActionConfig, prefetchCommonComponents } from "./registryAccessors";
