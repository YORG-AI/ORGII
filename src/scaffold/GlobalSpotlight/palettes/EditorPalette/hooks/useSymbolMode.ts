/**
 * useSymbolMode Hook
 *
 * Symbol search mode for EditorPalette - search and navigate to symbols
 * (functions, classes, interfaces, types, etc.) in the current file.
 *
 * Uses the getFileSymbols() API (tree-sitter based) for symbol extraction.
 * Reuses symbol icon/color config from OutlineContent for visual consistency.
 */
import {
  Fragment,
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { type SymbolInfo, getFileSymbols } from "@src/api/tauri/search";
import {
  DEBOUNCE_DELAYS,
  useDebouncedCallback,
} from "@src/hooks/perf/useDebouncedCallback";
import {
  SYMBOL_ICONS,
  SYMBOL_LABELS,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/OutlineContent/config";
import type { SymbolKind } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/OutlineContent/types";

import type { SpotlightItem } from "../../../shared";

// ============================================
// Types
// ============================================

interface UseSymbolModeOptions {
  searchTerm: string;
  enabled: boolean;
  currentFile?: string | null;
  /** Callback when a symbol is selected (navigate to line) */
  onSymbolSelect: (line: number) => void;
}

interface UseSymbolModeReturn {
  items: SpotlightItem[];
  isLoading: boolean;
}

// ============================================
// Constants
// ============================================

const VALID_SYMBOL_KINDS: SymbolKind[] = [
  "function",
  "class",
  "interface",
  "type",
  "const",
  "let",
  "var",
  "export",
  "import",
  "method",
  "property",
  "enum",
];

/** Max symbols to display in the spotlight list */
const MAX_DISPLAY_SYMBOLS = 100;

/** File extensions supported by tree-sitter symbol extraction */
function isExtensionSupported(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return ["ts", "tsx", "js", "jsx", "py", "rs"].includes(ext);
}

// ============================================
// Helpers
// ============================================

/** Normalize symbol kind to a known SymbolKind */
function normalizeSymbolKind(kind: string): SymbolKind {
  return VALID_SYMBOL_KINDS.includes(kind as SymbolKind)
    ? (kind as SymbolKind)
    : "function";
}

/** Simple fuzzy match - checks if all characters in query appear in name in order */
function fuzzyMatch(query: string, name: string): boolean {
  if (!query) return true;
  const lowerQuery = query.toLowerCase();
  const lowerName = name.toLowerCase();

  let queryIdx = 0;
  for (let nameIdx = 0; nameIdx < lowerName.length; nameIdx++) {
    if (lowerName[nameIdx] === lowerQuery[queryIdx]) {
      queryIdx++;
      if (queryIdx === lowerQuery.length) return true;
    }
  }
  return false;
}

/** Score a fuzzy match - higher is better */
function fuzzyScore(query: string, name: string): number {
  if (!query) return 0;
  const lowerQuery = query.toLowerCase();
  const lowerName = name.toLowerCase();

  // Exact match gets highest score
  if (lowerName === lowerQuery) return 1000;

  // Starts with gets high score
  if (lowerName.startsWith(lowerQuery)) return 500;

  // Contains gets medium score
  if (lowerName.includes(lowerQuery)) return 200;

  // Fuzzy match scoring based on character positions
  let score = 0;
  let queryIdx = 0;
  let prevMatchIdx = -2;

  for (let nameIdx = 0; nameIdx < lowerName.length; nameIdx++) {
    if (
      queryIdx < lowerQuery.length &&
      lowerName[nameIdx] === lowerQuery[queryIdx]
    ) {
      score += 10;
      // Consecutive matches get bonus
      if (nameIdx === prevMatchIdx + 1) {
        score += 5;
      }
      // Start-of-word matches get bonus (after _, -, or uppercase boundary)
      if (
        nameIdx === 0 ||
        name[nameIdx - 1] === "_" ||
        name[nameIdx - 1] === "-" ||
        (name[nameIdx] === name[nameIdx].toUpperCase() &&
          name[nameIdx - 1] === name[nameIdx - 1].toLowerCase())
      ) {
        score += 3;
      }
      prevMatchIdx = nameIdx;
      queryIdx++;
    }
  }

  return score;
}

// ============================================
// Hook
// ============================================

/**
 * Hook to search for symbols in the current file
 */
export function useSymbolMode({
  searchTerm,
  enabled,
  currentFile,
  onSymbolSelect,
}: UseSymbolModeOptions): UseSymbolModeReturn {
  const { t } = useTranslation("common");

  // Cached symbols for the current file
  const [symbolState, setSymbolState] = useState<{
    symbols: SymbolInfo[];
    isLoading: boolean;
    error: string | null;
    fetchedPath: string | null;
  }>({
    symbols: [],
    isLoading: false,
    error: null,
    fetchedPath: null,
  });

  // Track current fetch to prevent stale results
  const fetchIdRef = useRef(0);
  const fetchedPathRef = useRef<string | null>(null);

  // Invalidate cache when spotlight closes (enabled becomes false)
  // so symbols are always refetched with fresh content on next open
  useEffect(() => {
    if (!enabled) {
      fetchedPathRef.current = null;
    }
  }, [enabled]);

  // Debounced fetch for file symbols
  const debouncedFetch = useDebouncedCallback(
    (filePath: string, fetchId: number) => {
      setSymbolState((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
      }));

      getFileSymbols(filePath)
        .then((symbols) => {
          if (fetchIdRef.current !== fetchId) return;
          fetchedPathRef.current = filePath;
          setSymbolState({
            symbols,
            isLoading: false,
            error: null,
            fetchedPath: filePath,
          });
        })
        .catch((err) => {
          if (fetchIdRef.current !== fetchId) return;
          fetchedPathRef.current = filePath;
          setSymbolState({
            symbols: [],
            isLoading: false,
            error: err instanceof Error ? err.message : String(err),
            fetchedPath: filePath,
          });
        });
    },
    DEBOUNCE_DELAYS.SEARCH
  );

  // Fetch symbols when enabled and file changes
  useEffect(() => {
    if (!enabled || !currentFile) return;
    if (!isExtensionSupported(currentFile)) return;
    if (fetchedPathRef.current === currentFile) return;

    const fetchId = ++fetchIdRef.current;
    debouncedFetch(currentFile, fetchId);

    return () => {
      debouncedFetch.cancel();
    };
  }, [enabled, currentFile, debouncedFetch]);

  // Stable action callback factory
  const createSelectAction = useCallback(
    (line: number) => () => {
      onSymbolSelect(line);
    },
    [onSymbolSelect]
  );

  // Filter and sort symbols based on search term
  const items: SpotlightItem[] = useMemo(() => {
    if (!enabled) return [];

    // No file selected
    if (!currentFile) {
      return [
        {
          id: "symbol-no-file",
          label: t("selectors.editorSpotlight.modes.symbol.noFile"),
          desc: t("selectors.editorSpotlight.modes.symbol.noFileDesc"),
          type: "option",
        },
      ];
    }

    // Unsupported file type
    if (!isExtensionSupported(currentFile)) {
      const ext = currentFile.split(".").pop() || "unknown";
      return [
        {
          id: "symbol-unsupported",
          label: t("selectors.editorSpotlight.modes.symbol.unsupported", {
            ext,
          }),
          desc: t("selectors.editorSpotlight.modes.symbol.unsupportedDesc"),
          type: "option",
        },
      ];
    }

    // Still loading (no cached data)
    if (symbolState.isLoading && symbolState.symbols.length === 0) {
      return [
        {
          id: "symbol-loading",
          label: t("selectors.editorSpotlight.modes.symbol.loading"),
          type: "option",
        },
      ];
    }

    // Error
    if (symbolState.error) {
      return [
        {
          id: "symbol-error",
          label: t("selectors.editorSpotlight.modes.symbol.loadFailed"),
          desc: symbolState.error,
          type: "option",
        },
      ];
    }

    // No symbols
    if (symbolState.symbols.length === 0 && !symbolState.isLoading) {
      return [
        {
          id: "symbol-empty",
          label: t("selectors.editorSpotlight.modes.symbol.empty"),
          desc: t("selectors.editorSpotlight.modes.symbol.emptyDesc"),
          type: "option",
        },
      ];
    }

    // Filter by search term (fuzzy match)
    const filtered = searchTerm
      ? symbolState.symbols.filter((sym) => fuzzyMatch(searchTerm, sym.name))
      : symbolState.symbols;

    if (filtered.length === 0) {
      return [
        {
          id: "symbol-no-match",
          label: t("selectors.editorSpotlight.modes.symbol.noMatch", {
            query: searchTerm,
          }),
          type: "option",
        },
      ];
    }

    // Sort by relevance if searching, otherwise by line number
    const sorted = searchTerm
      ? [...filtered].sort(
          (symbolA, symbolB) =>
            fuzzyScore(searchTerm, symbolB.name) -
            fuzzyScore(searchTerm, symbolA.name)
        )
      : [...filtered].sort((symbolA, symbolB) => symbolA.line - symbolB.line);

    // Map to SpotlightItems (cap at MAX_DISPLAY_SYMBOLS)
    return sorted.slice(0, MAX_DISPLAY_SYMBOLS).map((sym) => {
      const kind = normalizeSymbolKind(sym.kind);
      const Icon = SYMBOL_ICONS[kind];
      const kindLabel = SYMBOL_LABELS[kind];

      return {
        id: `symbol-${sym.line}-${sym.column}-${sym.name}`,
        label: sym.name,
        icon: Icon,
        type: "option" as const,
        data: {
          labelContent: createElement(
            Fragment,
            null,
            createElement(
              "span",
              { className: "shrink-0 font-medium text-text-1" },
              sym.name
            ),
            createElement(
              "span",
              { className: "ml-1.5 min-w-0 truncate text-[12px] text-text-2" },
              kindLabel
            )
          ),
          rightLabel: `Ln ${sym.line}`,
          symbolKind: kind,
          line: sym.line,
        },
        action: createSelectAction(sym.line),
      };
    });
  }, [enabled, currentFile, symbolState, searchTerm, createSelectAction, t]);

  return {
    items,
    isLoading: symbolState.isLoading,
  };
}

export default useSymbolMode;
