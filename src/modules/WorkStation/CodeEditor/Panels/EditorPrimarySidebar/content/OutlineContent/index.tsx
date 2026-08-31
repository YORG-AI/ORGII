/**
 * OutlineContent Component
 *
 * Displays a tree of symbols (functions, classes, exports) from the current file.
 * Uses tree-sitter parsing via Tauri command for accurate symbol extraction.
 * Similar to VS Code's Outline view.
 *
 * - Uses the shared tree pattern for consistency
 * - Flattens tree for virtualization support (large files)
 * - Debounces file path changes to prevent rapid API calls
 * - Uses ref to track fetch state and prevent stale closures
 */
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";

import { type SymbolInfo, getFileSymbols } from "@src/api/tauri/search";
import { Placeholder } from "@src/components/Placeholder";
import { createLogger } from "@src/hooks/logger";
import {
  DEBOUNCE_DELAYS,
  useDebouncedCallback,
} from "@src/hooks/perf/useDebouncedCallback";

import SymbolTreeNode from "./SymbolTreeNode";
import {
  buildSymbolTree,
  isExtensionSupported,
  mapToOutlineSymbol,
} from "./outlineHelpers";
import type { OutlineSymbol } from "./types";

const log = createLogger("OutlineContent");

// ============================================
// Types
// ============================================

export interface OutlineContentProps {
  /** Current file path (absolute) */
  filePath: string | null;
  /** Callback when a symbol is clicked (navigate to line) */
  onSymbolClick?: (line: number) => void;
}

interface FlattenedSymbol {
  symbol: OutlineSymbol;
  depth: number;
}

// ============================================
// Main Component
// ============================================

export const OutlineContent: React.FC<OutlineContentProps> = memo(
  ({ filePath, onSymbolClick }) => {
    const { t } = useTranslation();

    const [fetchState, setFetchState] = useState<{
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

    const [selectionState, setSelectionState] = useState<{
      filePath: string | null;
      selectedId: string | null;
    }>({
      filePath: null,
      selectedId: null,
    });

    const selectedSymbolId =
      selectionState.filePath === filePath ? selectionState.selectedId : null;

    const fetchedPathRef = useRef<string | null>(null);
    const fetchIdRef = useRef(0);

    const isSupported = filePath ? isExtensionSupported(filePath) : false;

    useEffect(() => {
      if (!filePath || !isSupported) {
        fetchedPathRef.current = null;
      }
    }, [filePath, isSupported]);

    const debouncedFetchSymbols = useDebouncedCallback(
      (path: string, fetchId: number) => {
        setFetchState((prev) => ({
          ...prev,
          isLoading: true,
          error: null,
        }));
        getFileSymbols(path)
          .then((symbols) => {
            if (fetchIdRef.current !== fetchId) return;
            fetchedPathRef.current = path;
            setFetchState({
              symbols,
              isLoading: false,
              error: null,
              fetchedPath: path,
            });
          })
          .catch((err) => {
            if (fetchIdRef.current !== fetchId) return;
            const errorMsg = err instanceof Error ? err.message : String(err);
            log.error("[OutlineContent] Error for:", path, "Error:", errorMsg);
            fetchedPathRef.current = path;
            setFetchState({
              symbols: [],
              isLoading: false,
              error: errorMsg,
              fetchedPath: path,
            });
          });
      },
      DEBOUNCE_DELAYS.SEARCH
    );

    useEffect(() => {
      if (!filePath || !isSupported) return;
      if (fetchedPathRef.current === filePath) return;

      const fetchId = ++fetchIdRef.current;
      debouncedFetchSymbols(filePath, fetchId);

      return () => {
        debouncedFetchSymbols.cancel();
      };
    }, [filePath, isSupported, debouncedFetchSymbols]);

    const { symbols: rawSymbols, isLoading, error } = fetchState;

    const symbols = useMemo(() => {
      if (!rawSymbols.length || !filePath) return [];
      const flatSymbols = rawSymbols.map((sym) =>
        mapToOutlineSymbol(sym, filePath)
      );
      return buildSymbolTree(flatSymbols);
    }, [rawSymbols, filePath]);

    const allSymbolIds = useMemo(() => {
      const ids = new Set<string>();
      const collectIds = (syms: OutlineSymbol[]) => {
        syms.forEach((sym) => {
          ids.add(sym.id);
          if (sym.children) collectIds(sym.children);
        });
      };
      collectIds(symbols);
      return ids;
    }, [symbols]);

    const [toggleState, setToggleState] = useState<{
      filePath: string | null;
      toggles: Set<string>;
    }>({
      filePath: null,
      toggles: new Set(),
    });

    const expandedSymbols = useMemo(() => {
      if (toggleState.filePath !== filePath) return allSymbolIds;
      return toggleState.toggles;
    }, [toggleState, filePath, allSymbolIds]);

    const handleToggle = useCallback(
      (symbolId: string) => {
        setToggleState((prev) => {
          const base = prev.filePath === filePath ? prev.toggles : allSymbolIds;
          const next = new Set(base);
          if (next.has(symbolId)) {
            next.delete(symbolId);
          } else {
            next.add(symbolId);
          }
          return { filePath, toggles: next };
        });
      },
      [filePath, allSymbolIds]
    );

    const handleSelect = useCallback(
      (symbol: OutlineSymbol) => {
        setSelectionState({ filePath, selectedId: symbol.id });
        onSymbolClick?.(symbol.line);
      },
      [filePath, onSymbolClick]
    );

    const flattenedSymbols = useMemo(() => {
      const result: FlattenedSymbol[] = [];

      function flatten(syms: OutlineSymbol[], depth = 0) {
        for (const sym of syms) {
          const symbolWithExpansion = {
            ...sym,
            expanded: expandedSymbols.has(sym.id),
          };
          result.push({ symbol: symbolWithExpansion, depth });
          if (sym.children?.length && expandedSymbols.has(sym.id)) {
            flatten(sym.children, depth + 1);
          }
        }
      }

      flatten(symbols);
      return result;
    }, [symbols, expandedSymbols]);

    const useVirtualization = flattenedSymbols.length > 50;

    const renderSymbolNode = useCallback(
      (item: FlattenedSymbol) => (
        <SymbolTreeNode
          symbol={item.symbol}
          depth={item.depth}
          isSelected={selectedSymbolId === item.symbol.id}
          onToggle={handleToggle}
          onSelect={handleSelect}
        />
      ),
      [selectedSymbolId, handleToggle, handleSelect]
    );

    if (!filePath) {
      return (
        <Placeholder
          variant="empty"
          placement="sidebar"
          title={t("placeholders.noFileSelected")}
          fillParentHeight
        />
      );
    }

    if (!isSupported) {
      return (
        <Placeholder
          variant="empty"
          placement="sidebar"
          title={t("placeholders.outlineNotAvailable")}
          fillParentHeight
        />
      );
    }

    if (isLoading && flattenedSymbols.length === 0) {
      return (
        <Placeholder
          variant="loading"
          placement="sidebar"
          title={t("placeholders.parsingSymbols")}
          fillParentHeight
        />
      );
    }

    if (error) {
      log.error(
        "[OutlineContent] Symbol parse error:",
        error,
        "filePath:",
        filePath
      );

      const isScopeGraphError =
        error.includes("scope graph") || error.includes("QueryError");

      return (
        <Placeholder
          variant={isScopeGraphError ? "empty" : "error"}
          title={
            isScopeGraphError
              ? t("placeholders.outlineParseError")
              : t("placeholders.failedToParseSymbols")
          }
          placement="sidebar"
          fillParentHeight
        />
      );
    }

    if (flattenedSymbols.length === 0) {
      return (
        <Placeholder
          variant="empty"
          placement="sidebar"
          title={t("placeholders.noSymbolsFound")}
          fillParentHeight
        />
      );
    }

    return (
      <div className="tree-guide-scope h-full overflow-y-auto pb-2 scrollbar-hide">
        {useVirtualization ? (
          <Virtuoso
            totalCount={flattenedSymbols.length}
            itemContent={(index) => (
              <div key={flattenedSymbols[index].symbol.id}>
                {renderSymbolNode(flattenedSymbols[index])}
              </div>
            )}
            computeItemKey={(index) => flattenedSymbols[index].symbol.id}
            overscan={20}
            increaseViewportBy={{ top: 100, bottom: 100 }}
            style={{ height: "100%" }}
            defaultItemHeight={28}
          />
        ) : (
          flattenedSymbols.map((item) => (
            <div key={item.symbol.id}>{renderSymbolNode(item)}</div>
          ))
        )}
      </div>
    );
  }
);

OutlineContent.displayName = "OutlineContent";

export default OutlineContent;
