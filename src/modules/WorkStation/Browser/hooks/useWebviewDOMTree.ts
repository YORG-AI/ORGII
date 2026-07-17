/**
 * useWebviewDOMTree - Hook for DOM tree inspection in webviews
 *
 * Provides functionality to:
 * - Fetch DOM tree structure from webview
 * - Manage expanded/collapsed state of tree nodes
 * - Highlight elements on hover (from React tree)
 * - Select elements on click (from React tree)
 * - Expand tree to show selected element
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { useVisiblePolling } from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";
import {
  DEBOUNCE_DELAYS,
  useDebouncedCallback,
} from "@src/hooks/perf/useDebouncedCallback";

const log = createLogger("useWebviewDOMTree");

// ============================================
// Types
// ============================================

export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DOMNodeKind = "element" | "shadow-root" | "iframe-document";

export interface DOMTreeNode {
  /** HTML tag name (lowercase), or `#shadow-root` / `#document` for pseudo-nodes */
  tagName: string;
  /** Element ID attribute */
  id: string | null;
  /** Element class attribute (space-separated) */
  className: string | null;
  /** XPath to this element (pseudo-nodes carry synthetic suffixes) */
  xpath: string;
  /** Bounding rectangle */
  rect: ElementRect;
  /** Number of child elements */
  childCount: number;
  /** Child nodes (recursive) */
  children: DOMTreeNode[];
  /** Node category — real element vs shadow/iframe boundary marker */
  nodeKind?: DOMNodeKind;
}

export interface UseWebviewDOMTreeOptions {
  /** Webview label to inspect */
  webviewLabel: string;
  /** Whether the hook is enabled */
  enabled?: boolean;
  /**
   * Dirty-check poll interval in ms (0 = disabled).
   *
   * When > 0, the hook polls `check_webview_dom_dirty` (a cheap boolean
   * read set by MutationObserver in the webview). Full tree refetches
   * only happen when the flag says the DOM actually mutated, so idle
   * pages cost a single boolean read per tick.
   */
  pollInterval?: number;
  /** Maximum depth to fetch */
  maxDepth?: number;
  /** Callback when tree is fetched */
  onTreeFetched?: (tree: DOMTreeNode | null) => void;
}

export interface UseWebviewDOMTreeReturn {
  /** The DOM tree structure */
  tree: DOMTreeNode | null;
  /** Whether tree is loading */
  loading: boolean;
  /** Error message if fetch failed */
  error: string | null;
  /** Manually refresh the tree */
  refresh: () => Promise<void>;
  /** Set of expanded node xpaths */
  expandedNodes: Set<string>;
  /** Toggle a node's expanded state */
  toggleExpanded: (xpath: string) => void;
  /** Expand all nodes to a specific xpath */
  expandToNode: (xpath: string) => void;
  /** Collapse all nodes */
  collapseAll: () => void;
  /** Expand first N levels */
  expandToDepth: (depth: number) => void;
  /** Highlight element by xpath (hover preview) */
  highlightNode: (xpath: string | null) => Promise<void>;
  /** Select element by xpath (click) */
  selectNode: (xpath: string) => Promise<unknown>;
  /** Currently highlighted xpath */
  highlightedXpath: string | null;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Collect all xpaths up to a certain depth
 */
function collectXpathsToDepth(
  node: DOMTreeNode,
  depth: number,
  currentDepth: number = 0
): string[] {
  if (currentDepth >= depth) return [];

  const result: string[] = [node.xpath];
  for (const child of node.children) {
    result.push(...collectXpathsToDepth(child, depth, currentDepth + 1));
  }
  return result;
}

/**
 * Pseudo xpaths mark synthetic nodes (shadow-root, iframe-document) inserted
 * by the walker. They cannot be resolved via `document.evaluate` in the
 * webview, so highlight/select calls must skip them.
 */
function isPseudoXPath(xpath: string): boolean {
  return xpath.endsWith("/__shadow__") || xpath.endsWith("/__iframedoc__");
}

function isMissingWebviewError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Webview '") && message.includes("not found");
}

/**
 * Get parent xpaths from a full xpath
 */
function getParentXpaths(xpath: string): string[] {
  const paths: string[] = [];
  const parts = xpath.split("/").filter(Boolean);

  let current = "";
  for (let index = 0; index < parts.length - 1; index++) {
    current += "/" + parts[index];
    paths.push(current);
  }

  return paths;
}

// ============================================
// Hook
// ============================================

export function useWebviewDOMTree(
  options: UseWebviewDOMTreeOptions
): UseWebviewDOMTreeReturn {
  const {
    webviewLabel,
    enabled = true,
    pollInterval = 0,
    maxDepth = 12,
    onTreeFetched,
  } = options;

  const [tree, setTree] = useState<DOMTreeNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(
    new Set(["/body"])
  );
  const [highlightedXpath, setHighlightedXpath] = useState<string | null>(null);

  // In-flight guard — prevents dirty-poll tick or navigation from stacking
  // concurrent refetches on slow pages (YouTube search with 10k nodes).
  const inFlightRef = useRef(false);

  // Keep callback ref up to date
  const onTreeFetchedRef = useRef(onTreeFetched);
  useEffect(() => {
    onTreeFetchedRef.current = onTreeFetched;
  }, [onTreeFetched]);

  // Fetch DOM tree
  const refresh = useCallback(async () => {
    if (!webviewLabel || !enabled) return;
    if (inFlightRef.current) return;

    inFlightRef.current = true;
    setLoading(true);
    setError(null);

    try {
      const result = await invoke<DOMTreeNode | null>("get_webview_dom_tree", {
        label: webviewLabel,
        maxDepth,
      });

      setTree(result);
      onTreeFetchedRef.current?.(result);

      // Auto-expand first 2 levels on initial fetch only.
      // Functional update preserves prior expandToNode changes made during
      // an overlapping async fetch.
      if (result) {
        setExpandedNodes((currentExpanded) => {
          if (currentExpanded.size <= 1) {
            return new Set(collectXpathsToDepth(result, 2));
          }
          return currentExpanded;
        });
      }
    } catch (err) {
      if (isMissingWebviewError(err)) {
        setTree(null);
        onTreeFetchedRef.current?.(null);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      }
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, [webviewLabel, enabled, maxDepth]);

  // Initial fetch
  useEffect(() => {
    if (!enabled || !webviewLabel) return;

    let cancelled = false;

    const doFetch = async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setLoading(true);
      setError(null);

      try {
        const result = await invoke<DOMTreeNode | null>(
          "get_webview_dom_tree",
          {
            label: webviewLabel,
            maxDepth,
          }
        );

        if (cancelled) return;

        setTree(result);
        onTreeFetchedRef.current?.(result);

        if (result) {
          setExpandedNodes((currentExpanded) => {
            if (currentExpanded.size <= 1) {
              return new Set(collectXpathsToDepth(result, 2));
            }
            return currentExpanded;
          });
        }
      } catch (err) {
        if (cancelled) return;
        if (isMissingWebviewError(err)) {
          setTree(null);
          onTreeFetchedRef.current?.(null);
        } else {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
        }
      } finally {
        if (!cancelled) setLoading(false);
        inFlightRef.current = false;
      }
    };

    doFetch();

    return () => {
      cancelled = true;
    };
  }, [enabled, webviewLabel, maxDepth]);

  const checkForDomChanges = useCallback(async () => {
    if (inFlightRef.current) return;
    try {
      const dirty = await invoke<boolean>("check_webview_dom_dirty", {
        label: webviewLabel,
      });
      if (dirty) await refresh();
    } catch {
      // The webview may have been torn down between scheduling and invocation.
    }
  }, [refresh, webviewLabel]);

  useVisiblePolling({
    enabled: enabled && !!webviewLabel && pollInterval > 0,
    intervalMs: pollInterval,
    poll: checkForDomChanges,
  });

  // Toggle expanded state
  const toggleExpanded = useCallback((xpath: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(xpath)) {
        next.delete(xpath);
      } else {
        next.add(xpath);
      }
      return next;
    });
  }, []);

  // Expand all nodes to a specific xpath
  const expandToNode = useCallback((xpath: string) => {
    const parentPaths = getParentXpaths(xpath);
    setExpandedNodes((prev) => {
      const combined = Array.from(prev);
      combined.push(...parentPaths, xpath);
      return new Set(combined);
    });
  }, []);

  // Collapse all nodes
  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set(["/body"]));
  }, []);

  // Expand first N levels
  const expandToDepth = useCallback(
    (depth: number) => {
      if (!tree) return;
      const xpaths = collectXpathsToDepth(tree, depth);
      setExpandedNodes(new Set(xpaths));
    },
    [tree]
  );

  // Debounced highlight clearing — prevents flicker when moving between elements
  const debouncedClearHighlight = useDebouncedCallback(
    async () => {
      setHighlightedXpath(null);
      try {
        await invoke("clear_element_highlight", {
          label: webviewLabel,
        });
      } catch (err) {
        if (!isMissingWebviewError(err)) {
          log.error("[useWebviewDOMTree] Clear highlight failed:", err);
        }
      }
    },
    DEBOUNCE_DELAYS.SEARCH // 150ms allows moving between rows
  );

  // Highlight element by xpath (hover preview)
  const highlightNode = useCallback(
    async (xpath: string | null) => {
      if (!webviewLabel) return;
      if (xpath && isPseudoXPath(xpath)) return;

      // Cancel any pending clear
      debouncedClearHighlight.cancel();

      if (xpath) {
        // Immediate highlight
        setHighlightedXpath(xpath);
        try {
          await invoke("highlight_element_by_xpath", {
            label: webviewLabel,
            xpath,
          });
        } catch (err) {
          if (!isMissingWebviewError(err)) {
            log.error("[useWebviewDOMTree] Highlight failed:", err);
          }
        }
      } else {
        // Debounce clearing to prevent flicker
        debouncedClearHighlight();
      }
    },
    [webviewLabel, debouncedClearHighlight]
  );

  // Select element by xpath (click)
  const selectNode = useCallback(
    async (xpath: string) => {
      if (!webviewLabel) return null;
      if (isPseudoXPath(xpath)) return null;

      try {
        const result = await invoke("select_element_by_xpath", {
          label: webviewLabel,
          xpath,
        });

        // Expand tree to show selected node
        expandToNode(xpath);

        return result;
      } catch (err) {
        if (!isMissingWebviewError(err)) {
          log.error("[useWebviewDOMTree] Select failed:", err);
        }
        return null;
      }
    },
    [webviewLabel, expandToNode]
  );

  // Cleanup highlight on unmount
  useEffect(() => {
    return () => {
      if (webviewLabel && highlightedXpath) {
        invoke("clear_element_highlight", { label: webviewLabel }).catch(
          () => {}
        );
      }
    };
  }, [webviewLabel, highlightedXpath]);

  return {
    tree,
    loading,
    error,
    refresh,
    expandedNodes,
    toggleExpanded,
    expandToNode,
    collapseAll,
    expandToDepth,
    highlightNode,
    selectNode,
    highlightedXpath,
  };
}

export default useWebviewDOMTree;
