/**
 * Palettes
 *
 * Spotlight-based palettes for selecting repos, branches, modes, agents, etc.
 * Each palette is a self-contained module extending BasePaletteProps.
 *
 * For internal primitives, import `useSelectorKernel` from "./core" and
 * `SpotlightShell` / `PaletteBody` from "../shell".
 */

export { WorkspacePalette } from "./WorkspacePalette";
export type { WorkspacePaletteProps } from "./WorkspacePalette/types";

export { WorkspaceDropdown } from "./WorkspacePalette/WorkspaceDropdown";

export { BranchPalette, WorktreePalette } from "./BranchPalette";
export type { BranchPaletteProps, WorktreePaletteProps } from "./BranchPalette";

export { BranchDropdown } from "./BranchPalette/BranchDropdown";

export { DatabasePalette } from "./DatabasePalette";

export { UnifiedModelPalette } from "./UnifiedModelPalette";
export type { UnifiedModelPaletteProps } from "./UnifiedModelPalette";

export { UnifiedModelDropdown } from "./UnifiedModelPalette/UnifiedModelDropdown";
export type { UnifiedModelDropdownProps } from "./UnifiedModelPalette/UnifiedModelDropdown";

export { DispatchCategoryPalette } from "./DispatchCategoryPalette";
export type {
  AgentSelection,
  DispatchCategoryPaletteProps,
} from "./DispatchCategoryPalette";

export { DispatchCategoryDropdown } from "./DispatchCategoryPalette/DispatchCategoryDropdown";

export { EditorPalette } from "./EditorPalette";

export { ContentSearchPalette } from "./ContentSearchPalette";

export { AllSessionsSearchPalette } from "./AllSessionsSearchPalette";

export { AgentSessionSearchPalette } from "./AgentSessionSearchPalette";

export { AgentControlPalette } from "./AgentControlPalette";

export { SessionCreatorPalette } from "./SessionCreatorPalette";
