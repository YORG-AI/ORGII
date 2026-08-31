/**
 * SearchEditorContent Configuration
 *
 * Constants and configuration for the search editor tab
 */
import {
  BlendIcon,
  BrainIcon,
  type IconSvgElement,
  Search01Icon,
} from "@src/icons";

import type { SearchMode } from "./types";

// ============================================
// Search Mode Configuration
// ============================================

export interface SearchModeConfig {
  id: SearchMode;
  label: string;
  shortLabel: string;
  icon: IconSvgElement;
  description: string;
  color: string;
}

export const SEARCH_MODES: SearchModeConfig[] = [
  {
    id: "regex",
    label: "Regex Search",
    shortLabel: "Regex",
    icon: Search01Icon,
    description: "Fast literal text search using ripgrep",
    color: "text-text-3",
  },
  {
    id: "semantic",
    label: "Semantic Search",
    shortLabel: "Semantic",
    icon: BrainIcon,
    description: "Embedding-based meaning search",
    color: "text-text-3",
  },
  {
    id: "hybrid",
    label: "Hybrid Search",
    shortLabel: "Hybrid",
    icon: BlendIcon,
    description: "Combined semantic and full-text search",
    color: "text-text-3",
  },
];

// ============================================
// Search Constants
// ============================================

export const SEARCH_EDITOR_CONSTANTS = {
  /** Debounce delay for search input (ms) */
  DEBOUNCE_MS: 300,
  /** Initial results batch size */
  INITIAL_BATCH_SIZE: 100,
  /** Threshold to show "refine query" warning */
  WARNING_THRESHOLD: 1000,
} as const;

// ============================================
// Icon Configuration
// ============================================

export const ICON_CONFIG = {
  search: "Search",
  clear: "X",
  caseSensitive: "CaseSensitive",
  wholeWord: "WholeWord",
  regex: "Regex",
} as const;
