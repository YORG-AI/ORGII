/**
 * WorkItems Hooks - Public API
 *
 * Only exports hooks that are intended for external consumption.
 * Internal implementation hooks (useWorkItemsState, useWorkItemsData, etc.)
 * are intentionally not exported.
 */

// Main orchestrator hook - combines all state, data, and handlers
export { useWorkItems } from "./useWorkItems";

// Agent session orchestration (SDE/Review agent lifecycle)
export { useWorkItemActiveSession } from "./useWorkItemActiveSession";

// Work item CRUD actions
export { default as useWorkItemActions } from "./useWorkItemActions";
