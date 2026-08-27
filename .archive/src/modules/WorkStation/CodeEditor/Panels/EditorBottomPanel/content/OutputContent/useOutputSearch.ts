/**
 * useOutputSearch Hook
 *
 * DOM-based text search with highlighting for the Output panel.
 * Uses TreeWalker to find text nodes and the CSS Custom Highlight API
 * (with mark-based fallback) to highlight matches.
 *
 * Supports: case-sensitive, whole-word, regex matching.
 * Navigation: next/previous with active-match tracking.
 */
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

// ============================================
// Types
// ============================================

export interface OutputSearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface OutputSearchState {
  /** Current search query */
  query: string;
  /** Total matches found */
  matchCount: number;
  /** Current active match index (1-based for display) */
  activeIndex: number;
}

export interface UseOutputSearchReturn {
  /** Current search state */
  searchState: OutputSearchState;
  /** Find next match, returns true if found */
  findNext: (query: string, options: OutputSearchOptions) => void;
  /** Find previous match */
  findPrevious: (query: string, options: OutputSearchOptions) => void;
  /** Clear all highlights */
  clearSearch: () => void;
}

// ============================================
// Constants
// ============================================

const HIGHLIGHT_CLASS = "output-search-highlight";
const ACTIVE_HIGHLIGHT_CLASS = "output-search-highlight--active";

// ============================================
// Helpers
// ============================================

/** Build a RegExp from the user query + options */
function buildSearchRegex(
  query: string,
  options: OutputSearchOptions
): RegExp | null {
  if (!query) return null;

  let pattern: string;
  if (options.regex) {
    try {
      // Validate the regex
      new RegExp(query);
      pattern = query;
    } catch {
      return null; // Invalid regex — skip
    }
  } else {
    // Escape special regex chars for literal search
    pattern = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  if (options.wholeWord) {
    pattern = `\\b${pattern}\\b`;
  }

  const flags = options.caseSensitive ? "g" : "gi";
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/** Collect all text nodes under a container */
function getTextNodes(container: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    null
  );
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

// ============================================
// Hook
// ============================================

export function useOutputSearch(
  contentRef: RefObject<HTMLElement | null>
): UseOutputSearchReturn {
  const [searchState, setSearchState] = useState<OutputSearchState>({
    query: "",
    matchCount: 0,
    activeIndex: 0,
  });

  // Track <mark> elements for navigation
  const marksRef = useRef<HTMLElement[]>([]);
  const activeIndexRef = useRef(0);

  /** Remove all highlight marks, restoring original text nodes */
  const removeHighlights = useCallback(() => {
    const container = contentRef.current;
    if (!container) return;

    const marks = container.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(
          document.createTextNode(mark.textContent || ""),
          mark
        );
        parent.normalize(); // Merge adjacent text nodes
      }
    });
    marksRef.current = [];
    activeIndexRef.current = 0;
  }, [contentRef]);

  /** Perform search and highlight all matches */
  const performSearch = useCallback(
    (query: string, options: OutputSearchOptions): number => {
      removeHighlights();

      const container = contentRef.current;
      if (!container || !query) {
        setSearchState({ query, matchCount: 0, activeIndex: 0 });
        return 0;
      }

      const regex = buildSearchRegex(query, options);
      if (!regex) {
        setSearchState({ query, matchCount: 0, activeIndex: 0 });
        return 0;
      }

      // Collect text nodes and build a flat text map
      const textNodes = getTextNodes(container);
      const newMarks: HTMLElement[] = [];

      // Process each text node for matches
      for (const textNode of textNodes) {
        const text = textNode.textContent || "";
        if (!text) continue;

        // Reset regex lastIndex for each node
        regex.lastIndex = 0;
        const matches: { start: number; end: number }[] = [];
        let match: RegExpExecArray | null;

        while ((match = regex.exec(text)) !== null) {
          if (match[0].length === 0) {
            regex.lastIndex++;
            continue;
          }
          matches.push({
            start: match.index,
            end: match.index + match[0].length,
          });
        }

        if (matches.length === 0) continue;

        // Split text node and wrap matches in <mark>
        const fragment = document.createDocumentFragment();
        let lastEnd = 0;

        for (const { start, end } of matches) {
          // Text before match
          if (start > lastEnd) {
            fragment.appendChild(
              document.createTextNode(text.slice(lastEnd, start))
            );
          }
          // Highlighted match
          const mark = document.createElement("mark");
          mark.className = HIGHLIGHT_CLASS;
          mark.textContent = text.slice(start, end);
          fragment.appendChild(mark);
          newMarks.push(mark);
          lastEnd = end;
        }

        // Text after last match
        if (lastEnd < text.length) {
          fragment.appendChild(document.createTextNode(text.slice(lastEnd)));
        }

        textNode.parentNode?.replaceChild(fragment, textNode);
      }

      marksRef.current = newMarks;
      return newMarks.length;
    },
    [contentRef, removeHighlights]
  );

  /** Set the active match (scroll into view + highlight) */
  const setActiveMatch = useCallback((index: number) => {
    const marks = marksRef.current;
    if (marks.length === 0) return;

    // Remove previous active
    marks.forEach((mark) => mark.classList.remove(ACTIVE_HIGHLIGHT_CLASS));

    // Clamp index
    const clamped = ((index % marks.length) + marks.length) % marks.length;
    activeIndexRef.current = clamped;

    const activeMark = marks[clamped];
    if (activeMark) {
      activeMark.classList.add(ACTIVE_HIGHLIGHT_CLASS);
      activeMark.scrollIntoView({ block: "center", behavior: "smooth" });
    }

    setSearchState((prev) => ({
      ...prev,
      activeIndex: clamped + 1, // 1-based for display
    }));
  }, []);

  /** Find next match */
  const findNext = useCallback(
    (query: string, options: OutputSearchOptions) => {
      // If query changed, re-search
      if (query !== searchState.query || marksRef.current.length === 0) {
        const count = performSearch(query, options);
        setSearchState({ query, matchCount: count, activeIndex: 0 });
        if (count > 0) {
          setActiveMatch(0);
        }
        return;
      }

      // Navigate to next
      if (marksRef.current.length > 0) {
        setActiveMatch(activeIndexRef.current + 1);
      }
    },
    [searchState.query, performSearch, setActiveMatch]
  );

  /** Find previous match */
  const findPrevious = useCallback(
    (query: string, options: OutputSearchOptions) => {
      // If query changed, re-search
      if (query !== searchState.query || marksRef.current.length === 0) {
        const count = performSearch(query, options);
        setSearchState({ query, matchCount: count, activeIndex: 0 });
        if (count > 0) {
          setActiveMatch(count - 1);
        }
        return;
      }

      // Navigate to previous
      if (marksRef.current.length > 0) {
        setActiveMatch(activeIndexRef.current - 1);
      }
    },
    [searchState.query, performSearch, setActiveMatch]
  );

  /** Clear search */
  const clearSearch = useCallback(() => {
    removeHighlights();
    setSearchState({ query: "", matchCount: 0, activeIndex: 0 });
  }, [removeHighlights]);

  // Clean up highlights on unmount
  useEffect(() => {
    return () => {
      removeHighlights();
    };
  }, [removeHighlights]);

  return {
    searchState,
    findNext,
    findPrevious,
    clearSearch,
  };
}
