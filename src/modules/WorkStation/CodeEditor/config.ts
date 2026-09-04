/**
 * CodeEditor Configuration
 *
 * Configuration constants and icons for the CodeEditor component.
 */
import { FileScriptIcon, FolderOpenIcon, Search01Icon } from "@src/icons";

// ============================================
// Icon Configuration
// ============================================

export const CODE_EDITOR_ICONS = {
  fileCode: FileScriptIcon,
  folderOpen: FolderOpenIcon,
  search: Search01Icon,
} as const;

// ============================================
// Default Configuration
// ============================================

export const CODE_EDITOR_CONFIG = {
  // File tree
  defaultTreeWidth: 300,
  minTreeWidth: 200,
  maxTreeWidth: 500,

  // Search
  maxSearchResults: 50,
  searchDebounceMs: 300,

  // Excluded directories
  excludeDirs: [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "target",
    ".cache",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    ".DS_Store",
  ],
} as const;
