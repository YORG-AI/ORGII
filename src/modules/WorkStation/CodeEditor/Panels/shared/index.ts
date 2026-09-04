/**
 * Shared Panel Components
 *
 * Components shared across CodeEditor panels (Primary sidebar, editor tabs).
 */

// Search components (VSCode-style find/replace)
export { SearchInput } from "@src/components/SearchInput";
export type {
  SearchInputProps,
  SearchInputVariant,
} from "@src/components/SearchInput";

export { ReplaceInput } from "./ReplaceInput";

export { SearchFilters } from "./SearchFilters";

// Search mode select dropdown (shared between sidebar and editor tab)
export { SearchModeSelect } from "./SearchModeSelect";
export type { SearchMode } from "./SearchModeSelect";
