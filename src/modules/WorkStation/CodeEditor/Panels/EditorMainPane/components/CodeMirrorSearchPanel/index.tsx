/**
 * Find & Replace Panel for CodeMirror
 *
 * Custom implementation using unified SearchInput/ReplaceInput components
 * - Cmd+F for Find
 * - Cmd+H for Replace
 * - Regex support
 * - Case-sensitive toggle
 * - Whole word match toggle
 * - Match counter
 * - Next/Previous navigation
 */
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { Extension, StateEffect, StateField } from "@codemirror/state";
import { EditorView, Panel } from "@codemirror/view";
import React from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";

import { createLogger } from "@src/hooks/logger";
import {
  DEBOUNCE_DELAYS,
  useDebouncedCallback,
} from "@src/hooks/perf/useDebouncedCallback";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  HugeiconsIcon,
} from "@src/icons";
import {
  HEADER_BUTTON,
  HEADER_ICON_SIZE,
} from "@src/modules/WorkStation/shared/tokens";

import { ReplaceInput, SearchInput } from "../../../shared";

const log = createLogger("CodeMirrorSearchPanel");

// ============================================
// Types
// ============================================

interface SearchState {
  /** Whether replace section is expanded */
  replaceMode: boolean;
}

// ============================================
// State Effects
// ============================================

const toggleReplaceEffect = StateEffect.define<boolean>();

// ============================================
// Search State Field (minimal - just for replace mode)
// ============================================

const searchStateField = StateField.define<SearchState>({
  create: () => ({
    replaceMode: false,
  }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(toggleReplaceEffect)) {
        return { ...value, replaceMode: effect.value };
      }
    }
    return value;
  },
});

// ============================================
// Search Actions
// ============================================

/**
 * Apply search query to editor
 */
function applySearch(
  view: EditorView,
  query: string,
  replaceText: string,
  caseSensitive: boolean,
  wholeWord: boolean,
  useRegex: boolean
) {
  try {
    const searchQueryObj = new SearchQuery({
      search: query,
      caseSensitive,
      regexp: useRegex,
      wholeWord,
      replace: replaceText,
    });

    view.dispatch({
      effects: setSearchQuery.of(searchQueryObj),
    });
  } catch (error) {
    log.error("Search error:", error);
  }
}

/**
 * Get match count for current search
 */
function getMatchCount(view: EditorView): { current: number; total: number } {
  const query = getSearchQuery(view.state);
  if (!query || !query.valid) {
    return { current: 0, total: 0 };
  }

  let total = 0;
  let current = 0;
  const cursorPos = view.state.selection.main.head;
  let foundCurrent = false;

  const iter = query.getCursor(view.state.doc);
  let next = iter.next();
  while (!next.done) {
    total++;
    // Check if cursor is within or at the start of this match
    if (
      !foundCurrent &&
      next.value.from <= cursorPos &&
      cursorPos <= next.value.to
    ) {
      current = total;
      foundCurrent = true;
    }
    // If cursor is before this match and we haven't found current yet, this is the next match
    if (!foundCurrent && cursorPos < next.value.from) {
      current = total;
      foundCurrent = true;
    }
    next = iter.next();
  }

  // If cursor is after all matches, current is 0 (or could be set to total)
  if (!foundCurrent && total > 0) {
    current = 1; // Wrap to first match
  }

  return { current, total };
}

// ============================================
// Search Panel Component
// ============================================

interface SearchPanelProps {
  view: EditorView;
  initialReplaceMode?: boolean;
}

const SearchPanel: React.FC<SearchPanelProps> = ({
  view,
  initialReplaceMode = false,
}) => {
  const { t } = useTranslation();
  // Get current search query from CodeMirror
  const currentQuery = getSearchQuery(view.state);

  const [localQuery, setLocalQuery] = React.useState(
    currentQuery?.search || ""
  );
  const [localReplace, setLocalReplace] = React.useState(
    currentQuery?.replace || ""
  );
  const [localCaseSensitive, setLocalCaseSensitive] = React.useState(
    currentQuery?.caseSensitive || false
  );
  const [localWholeWord, setLocalWholeWord] = React.useState(
    currentQuery?.wholeWord || false
  );
  const [localUseRegex, setLocalUseRegex] = React.useState(
    currentQuery?.regexp || false
  );
  const [localReplaceMode, setLocalReplaceMode] =
    React.useState(initialReplaceMode);
  const [matchCount, setMatchCount] = React.useState({ current: 0, total: 0 });

  const searchInputRef = React.useRef<HTMLTextAreaElement>(null);

  // Focus search input on mount
  React.useEffect(() => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, []);

  // Debounced search - waits 500ms after user stops typing for large file performance
  const debouncedApplySearch = useDebouncedCallback(() => {
    applySearch(
      view,
      localQuery,
      localReplace,
      localCaseSensitive,
      localWholeWord,
      localUseRegex
    );
    const count = getMatchCount(view);
    setMatchCount(count);
  }, DEBOUNCE_DELAYS.EXPENSIVE);

  React.useEffect(() => {
    debouncedApplySearch();
  }, [
    localQuery,
    localReplace,
    localCaseSensitive,
    localWholeWord,
    localUseRegex,
    debouncedApplySearch,
  ]);

  // Update replace mode in state (no debounce needed)
  React.useEffect(() => {
    view.dispatch({
      effects: toggleReplaceEffect.of(localReplaceMode),
    });
  }, [localReplaceMode, view]);

  const handleClose = () => {
    // Close the search panel using CodeMirror's close function
    closeSearchPanel(view);
    view.focus();
  };

  const handleToggleReplace = () => {
    setLocalReplaceMode(!localReplaceMode);
  };

  const handleFindNext = () => {
    findNext(view);
    // Update match count after navigation
    setTimeout(() => {
      const count = getMatchCount(view);
      setMatchCount(count);
    }, 10);
  };

  const handleFindPrevious = () => {
    findPrevious(view);
    // Update match count after navigation
    setTimeout(() => {
      const count = getMatchCount(view);
      setMatchCount(count);
    }, 10);
  };

  const handleReplace = () => {
    replaceNext(view);
    // Update match count after replace
    setTimeout(() => {
      const count = getMatchCount(view);
      setMatchCount(count);
    }, 50);
  };

  const handleReplaceAll = () => {
    replaceAll(view);
    // Update match count after replace all
    setTimeout(() => {
      const count = getMatchCount(view);
      setMatchCount(count);
    }, 50);
  };

  // Handle Cmd+F/Cmd+H to close panel when focused inside it
  const handlePanelKeyDown = (event: React.KeyboardEvent) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      (event.key === "f" || event.key === "h")
    ) {
      event.preventDefault();
      handleClose();
    }
  };

  return (
    <div
      className="flex w-full border-b border-border-2 shadow-sm"
      onKeyDown={handlePanelKeyDown}
    >
      {/* Left column - Chevron toggle (centered vertically) */}
      <button
        onClick={handleToggleReplace}
        className="flex items-center justify-center self-center px-3 text-text-3"
        title={localReplaceMode ? "Collapse replace" : "Expand replace"}
      >
        {localReplaceMode ? (
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            data-icon="chevron-down"
            size={14}
          />
        ) : (
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            data-icon="chevron-right"
            size={14}
          />
        )}
      </button>

      {/* Center column - Input fields (stacked, left-aligned) */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-1.5">
        {/* Search row: input + up/down (inside SearchInput) + match counter */}
        <div className="flex items-center gap-2">
          <SearchInput
            variant="sidebar"
            value={localQuery}
            onChange={setLocalQuery}
            placeholder={t("actions.find")}
            caseSensitive={localCaseSensitive}
            wholeWord={localWholeWord}
            useRegex={localUseRegex}
            onCaseSensitiveToggle={() =>
              setLocalCaseSensitive(!localCaseSensitive)
            }
            onWholeWordToggle={() => setLocalWholeWord(!localWholeWord)}
            onRegexToggle={() => setLocalUseRegex(!localUseRegex)}
            onPrevious={handleFindPrevious}
            onNext={handleFindNext}
            inputRef={searchInputRef}
            inputBoxClassName="flex-none w-[320px]"
            hideChevron
          />
          {localQuery && (
            <span className="shrink-0 whitespace-nowrap text-[12px] text-text-3">
              {matchCount.total > 0
                ? `${matchCount.current > 0 ? matchCount.current : "?"} of ${matchCount.total}`
                : t("common:common.noResults")}
            </span>
          )}
        </div>

        {/* Replace row */}
        {localReplaceMode && (
          <ReplaceInput
            variant="sidebar"
            value={localReplace}
            onChange={setLocalReplace}
            placeholder={t("actions.replace")}
            onReplace={handleReplace}
            onReplaceAll={handleReplaceAll}
            disabled={!localQuery || matchCount.total === 0}
            inputBoxClassName="flex-none w-[320px]"
            hideSpacer
          />
        )}
      </div>

      {/* Right column - Close button */}
      <div className="flex items-start py-1.5 pr-3">
        <div className="flex h-7 items-center">
          <button
            onClick={handleClose}
            className={HEADER_BUTTON.action}
            title={t("tooltips.closeEsc")}
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              data-icon="x"
              size={HEADER_ICON_SIZE.sm}
            />
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================
// Panel Factory
// ============================================

function createSearchPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-search-panel-wrapper";
  dom.style.fontFamily = "var(--app-font-family)";

  // Get replace mode from state
  const state = view.state.field(searchStateField, false);
  const initialReplaceMode = state?.replaceMode || false;

  const root = createRoot(dom);
  root.render(
    <SearchPanel view={view} initialReplaceMode={initialReplaceMode} />
  );

  return {
    dom,
    top: true,
  };
}

// ============================================
// Keyboard Shortcuts
// ============================================

/**
 * Check if search panel is currently open
 * The panel is rendered in CodeMirror's panels container (sibling of view.dom)
 */
function isSearchPanelOpen(view: EditorView): boolean {
  // Look in the scrollDOM's parent (cm-editor) for the panels container
  const cmEditor = view.dom;
  // Panels are siblings of the scroll container, inside .cm-editor
  return (
    cmEditor.querySelector(".cm-search-panel-wrapper") !== null ||
    cmEditor.parentElement?.querySelector(".cm-search-panel-wrapper") !== null
  );
}

const searchKeymap = EditorView.domEventHandlers({
  keydown(event, view) {
    // Cmd+F - Toggle find (without replace)
    if ((event.metaKey || event.ctrlKey) && event.key === "f") {
      event.preventDefault();
      if (isSearchPanelOpen(view)) {
        closeSearchPanel(view);
        view.focus();
      } else {
        view.dispatch({
          effects: toggleReplaceEffect.of(false),
        });
        openSearchPanel(view);
      }
      return true;
    }

    // Cmd+H - Toggle find & replace
    if ((event.metaKey || event.ctrlKey) && event.key === "h") {
      event.preventDefault();
      if (isSearchPanelOpen(view)) {
        closeSearchPanel(view);
        view.focus();
      } else {
        view.dispatch({
          effects: toggleReplaceEffect.of(true),
        });
        openSearchPanel(view);
      }
      return true;
    }

    return false;
  },
});

// ============================================
// Extension Export
// ============================================

/**
 * Find & Replace extension with keyboard shortcuts
 *
 * This includes:
 * - The search() extension from CodeMirror for highlighting
 * - Our custom panel (which replaces the default panel)
 * - Keyboard shortcuts
 */
export function findReplaceExtension(): Extension {
  return [
    // Include CodeMirror's search extension with custom panel
    search({
      createPanel: createSearchPanel,
    }),
    // Our state field for managing panel state
    searchStateField,
    // Keyboard shortcuts
    searchKeymap,
  ];
}
