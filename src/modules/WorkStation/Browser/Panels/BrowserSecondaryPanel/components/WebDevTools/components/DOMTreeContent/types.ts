import type { DOMTreeNode } from "@src/modules/WorkStation/Browser/hooks/useWebviewDOMTree";

/** Flattened DOM node for list and virtualized rendering. */
export interface FlattenedDOMNode {
  node: DOMTreeNode;
  depth: number;
}

export interface DOMTreeContentProps {
  tree: DOMTreeNode | null;
  expandedNodes: Set<string>;
  selectedXPath: string | null;
  highlightedXPath?: string | null;
  onToggle: (xpath: string) => void;
  onSelect: (xpath: string) => void;
  onHover: (xpath: string | null) => void;
  loading?: boolean;
  error?: string | null;
  emptyMessage?: string;
  revealXPath?: string | null;
  revealKey?: number;
}
