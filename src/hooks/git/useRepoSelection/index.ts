/**
 * useRepoSelection - Modular hook for repo/branch selection
 *
 * Structure:
 * - types.ts       - Shared types and interfaces
 * - singleton.ts   - Module-level state for cross-instance coordination
 * - useRepoLoader.ts     - Repo loading and caching
 * - useBranchLoader.ts   - Branch loading (fast + full)
 * - useBranchCheckout.ts - Branch checkout with conflict resolution
 * - useRepoSelection.ts  - Main orchestrating hook
 */
export { useRepoSelection, default } from "./useRepoSelection";

// Sub-hooks for advanced use cases
export { useRepoLoader } from "./useRepoLoader";
export { useBranchLoader } from "./useBranchLoader";
export { useBranchCheckout } from "./useBranchCheckout";
