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
export type { ReplaceInputProps } from "./ReplaceInput";

export { SearchFilters } from "./SearchFilters";
export type { SearchFiltersProps } from "./SearchFilters";

// Search mode select dropdown (shared between sidebar and editor tab)
export { SearchModeSelect, SEARCH_MODE_OPTIONS } from "./SearchModeSelect";
export type { SearchModeSelectProps, SearchMode } from "./SearchModeSelect";
