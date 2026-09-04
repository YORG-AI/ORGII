/**
 * useWebDevToolsElementsPanel
 *
 * Manages all state and effects for the Elements panel inside WebDevTools:
 * - DOM tree (webview DOM hook, expand/collapse, reveal on selection)
 * - Style editor (computed styles, live edits, pending count)
 * - Source navigation (direct metadata + bounded filename/content search)
 * - Selection sync from inspector → tree
 *
 * Extracted from WebDevTools/index.tsx to keep that component under the
 * UI component line limit.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useRefreshSpin } from "@src/hooks/ui";
import { useSourceNavigation } from "@src/modules/WorkStation/Browser/hooks/useSourceNavigation";
import { useWebviewDOMTree } from "@src/modules/WorkStation/Browser/hooks/useWebviewDOMTree";
import type { SourceLocation } from "@src/modules/WorkStation/Browser/hooks/useWebviewInspector";
import { useWebviewStyleEditor } from "@src/modules/WorkStation/Browser/hooks/useWebviewStyleEditor";

import type { WebDevToolsProps } from "../types";

const DOM_TREE_DIRTY_POLL_MS = 1500;

interface UseWebDevToolsElementsPanelOptions {
  isOpen: boolean;
  activeTab: string;
  repoPath: string;
  webviewLabel: string;
  currentUrl: string;
  selectedElement: WebDevToolsProps["selectedElement"];
}

export interface UseWebDevToolsElementsPanelReturn {
  // DOM tree
  domTree: ReturnType<typeof useWebviewDOMTree>["tree"];
  treeLoading: boolean;
  treeError: string | null;
  expandedNodes: Set<string>;
  highlightedXpath: string | null;
  refreshTreeSpinClass: string | undefined;
  handleRefreshTreeClick: () => void;
  collapseAll: () => void;
  toggleExpanded: (xpath: string) => void;
  revealState: { xpath: string | null; key: number };
  highlightNode: (xpath: string | null) => void;

  // Selection
  effectiveSelectedXPath: string | null;
  handleTreeSelect: (xpath: string) => Promise<void>;

  // Style editor
  computedStyles: ReturnType<typeof useWebviewStyleEditor>["styles"];
  stylesLoading: boolean;
  stylesPending: boolean;
  styleEditCount: number;
  handleStyleChange: (property: string, value: string) => Promise<void>;
  handleStyleEditsUndo: () => void;
  handleStyleEditsSend: () => void;

  // Source navigation
  sourceLocation: SourceLocation | null;
  openFileAtLine: ReturnType<typeof useSourceNavigation>["openFileAtLine"];
  searchForComponent: ReturnType<
    typeof useSourceNavigation
  >["searchForComponent"];
  canSearchForComponent: ReturnType<
    typeof useSourceNavigation
  >["canSearchForComponent"];
}

export function useWebDevToolsElementsPanel({
  isOpen,
  activeTab,
  repoPath,
  webviewLabel,
  currentUrl,
  selectedElement,
}: UseWebDevToolsElementsPanelOptions): UseWebDevToolsElementsPanelReturn {
  // ---- Source Navigation ----
  const { openFileAtLine, canSearchForComponent, searchForComponent } =
    useSourceNavigation({ repoPath });
  const sourceLocation = selectedElement?.sourceLocation ?? null;

  // ---- DOM Tree ----
  const {
    tree: domTree,
    loading: treeLoading,
    error: treeError,
    refresh: refreshTree,
    expandedNodes,
    toggleExpanded,
    expandToNode,
    collapseAll,
    highlightNode,
    selectNode,
    highlightedXpath,
  } = useWebviewDOMTree({
    webviewLabel,
    enabled: isOpen && activeTab === "elements" && !!webviewLabel,
    pollInterval: DOM_TREE_DIRTY_POLL_MS,
  });

  const {
    spinClass: refreshTreeSpinClass,
    handleClick: handleRefreshTreeClick,
  } = useRefreshSpin(refreshTree, treeLoading);

  // ---- Selection ----
  const [localSelectedXPath, setLocalSelectedXPath] = useState<string | null>(
    null
  );
  const [revealState, setRevealState] = useState<{
    xpath: string | null;
    key: number;
  }>({
    xpath: null,
    key: 0,
  });

  // Auto-refresh DOM tree on URL changes
  const prevUrlRef = useRef(currentUrl);
  useEffect(() => {
    if (currentUrl && currentUrl !== prevUrlRef.current) {
      prevUrlRef.current = currentUrl;
      const timer = setTimeout(() => {
        setLocalSelectedXPath(null);
        refreshTree();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [currentUrl, refreshTree]);

  const triggerReveal = useCallback((xpath: string) => {
    setRevealState((prev) => ({ xpath, key: prev.key + 1 }));
  }, []);

  const effectiveSelectedXPath =
    localSelectedXPath || selectedElement?.xpath || null;

  // Sync selection when inspector picks an element (adjusting state during render)
  const [prevSelectedElement, setPrevSelectedElement] =
    useState(selectedElement);
  if (selectedElement && selectedElement !== prevSelectedElement) {
    setPrevSelectedElement(selectedElement);
    if (selectedElement.xpath) {
      setLocalSelectedXPath(selectedElement.xpath);
    }
  } else if (!selectedElement && prevSelectedElement) {
    setPrevSelectedElement(null);
  }

  // Two-phase expand → reveal
  const prevXpathForExpandRef = useRef<string | null>(null);
  const pendingRevealXpathRef = useRef<string | null>(null);

  useEffect(() => {
    const xpath = selectedElement?.xpath;
    if (!xpath) {
      prevXpathForExpandRef.current = null;
      pendingRevealXpathRef.current = null;
      return;
    }
    if (xpath !== prevXpathForExpandRef.current) {
      prevXpathForExpandRef.current = xpath;
      expandToNode(xpath);
      pendingRevealXpathRef.current = xpath;
    }
  }, [selectedElement?.xpath, expandToNode]);

  useEffect(() => {
    const pendingRevealXpath = pendingRevealXpathRef.current;
    if (!pendingRevealXpath || !domTree) return;

    const parts = pendingRevealXpath.split("/").filter(Boolean);
    if (parts.length > 1) {
      let parentPath = "";
      for (let index = 0; index < parts.length - 1; index++) {
        parentPath += "/" + parts[index];
      }
      if (!expandedNodes.has(parentPath)) return;
    }

    pendingRevealXpathRef.current = null;
    triggerReveal(pendingRevealXpath);
  }, [selectedElement?.xpath, domTree, expandedNodes, triggerReveal]);

  // ---- Style Editor ----
  const {
    styles: computedStyles,
    loading: stylesLoading,
    setStyle,
    refresh: refreshStyles,
    isPending: stylesPending,
  } = useWebviewStyleEditor({
    webviewLabel,
    selectedXPath: effectiveSelectedXPath,
    enabled: isOpen && !!webviewLabel && !!effectiveSelectedXPath,
  });

  // Handle tree node selection
  const handleTreeSelect = useCallback(
    async (xpath: string) => {
      setLocalSelectedXPath(xpath);
      await selectNode(xpath);
      setTimeout(() => refreshStyles(), 150);
    },
    [selectNode, refreshStyles]
  );

  const prevEffectiveXPathRef = useRef(effectiveSelectedXPath);
  useEffect(() => {
    if (
      effectiveSelectedXPath &&
      effectiveSelectedXPath !== prevEffectiveXPathRef.current
    ) {
      prevEffectiveXPathRef.current = effectiveSelectedXPath;
      const timer = setTimeout(() => refreshStyles(), 150);
      return () => clearTimeout(timer);
    }
  }, [effectiveSelectedXPath, refreshStyles]);

  const [styleEditState, setStyleEditState] = useState<{
    xpath: string | null;
    count: number;
  }>({ xpath: effectiveSelectedXPath, count: 0 });
  const styleEditCount =
    styleEditState.xpath === effectiveSelectedXPath ? styleEditState.count : 0;

  const handleStyleChange = useCallback(
    async (property: string, value: string) => {
      const success = await setStyle(property, value);
      if (success) {
        setStyleEditState((current) => ({
          xpath: effectiveSelectedXPath,
          count:
            current.xpath === effectiveSelectedXPath ? current.count + 1 : 1,
        }));
      }
    },
    [effectiveSelectedXPath, setStyle]
  );

  const handleStyleEditsUndo = useCallback(() => {
    setStyleEditState((current) => ({
      xpath: effectiveSelectedXPath,
      count:
        current.xpath === effectiveSelectedXPath
          ? Math.max(0, current.count - 1)
          : 0,
    }));
  }, [effectiveSelectedXPath]);

  const handleStyleEditsSend = useCallback(() => {
    setStyleEditState({ xpath: effectiveSelectedXPath, count: 0 });
  }, [effectiveSelectedXPath]);

  return {
    domTree,
    treeLoading,
    treeError,
    expandedNodes,
    highlightedXpath,
    refreshTreeSpinClass,
    handleRefreshTreeClick,
    collapseAll,
    toggleExpanded,
    revealState,
    highlightNode,
    effectiveSelectedXPath,
    handleTreeSelect,
    computedStyles,
    stylesLoading,
    stylesPending,
    styleEditCount,
    handleStyleChange,
    handleStyleEditsUndo,
    handleStyleEditsSend,
    sourceLocation,
    openFileAtLine,
    searchForComponent,
    canSearchForComponent,
  };
}
