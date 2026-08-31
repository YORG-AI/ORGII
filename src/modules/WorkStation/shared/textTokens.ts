/**
 * Workstation Text Tokens
 *
 * Centralized i18n keys for user-facing text in Workstation.
 * Components use these constants instead of magic strings.
 *
 * Resolve with t() at render time:
 *   const { t } = useTranslation();
 *   t(HUMANTOOLS_TEXT_KEYS.placeholders.noTestsFound)
 */

// ============================================
// Placeholders (common namespace)
// ============================================

export const HUMANTOOLS_TEXT_KEYS = {
  placeholders: {
    noItems: "placeholders.noItems",
    noFileOpen: "placeholders.noFileOpen",
    selectFileToEdit: "placeholders.selectFileToEdit",
    noTabsOpen: "placeholders.noTabsOpen",
    selectItemToStart: "placeholders.selectItemToStart",
    noDatabaseConnected: "placeholders.noDatabaseConnected",
    addConnectionToQuery: "placeholders.addConnectionToQuery",
    noQueryResults: "placeholders.noQueryResults",
    runQueryToSeeResults: "placeholders.runQueryToSeeResults",
    noTestsFound: "placeholders.noTestsFound",
    loading: "placeholders.loading",
    pleaseTryAgain: "placeholders.pleaseTryAgain",
    noFilesFound: "placeholders.noFilesFound",
    noResults: "placeholders.noResults",
    noChanges: "placeholders.noChanges",
    noTables: "placeholders.noTables",
    connectionError: "placeholders.connectionError",
    noConnections: "placeholders.noConnections",
    selectRowsToDelete: "placeholders.selectRowsToDelete",
    filterFiles: "placeholders.filterFiles",
    searchFiles: "placeholders.searchFiles",
    filterSearch: "placeholders.filterSearch",
    filterChanges: "placeholders.filterChanges",
    noMatchingFiles: "placeholders.noMatchingFiles",
    noFilesMatchingFilter: "placeholders.noFilesMatchingFilter",
    unsavedChanges: "placeholders.unsavedChanges",
    unsavedEdits: "placeholders.unsavedEdits",
    unsavedConflictResolutions: "placeholders.unsavedConflictResolutions",
  },

  // Search panel (expand/collapse replace)
  search: {
    expandReplace: "workstation.expandReplace",
    collapseReplace: "workstation.collapseReplace",
  },

  // Actions (common namespace)
  actions: {
    retry: "actions.retry",
    filter: "actions.filter",
    newFile: "actions.newFile",
    newFolder: "actions.newFolder",
    refresh: "actions.refresh",
  },

  // Tooltips
  tooltips: {
    filter: "actions.filter",
    newFile: "actions.newFile",
    newFolder: "actions.newFolder",
    refreshExplorer: "workstation.tooltipRefreshExplorer",
    collapseAll: "workstation.tooltipCollapseAll",
    refresh: "actions.refresh",
  },

  // Errors (common namespace)
  errors: {
    generic: "errors.generic",
  },
} as const;
