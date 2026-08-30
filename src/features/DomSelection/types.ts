export interface DomSelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DomSelectionComputedStyle {
  display: string | null;
  position: string | null;
  color: string | null;
  backgroundColor: string | null;
  fontSize: string | null;
  fontFamily: string | null;
}

export interface DomSelectionSourcePoint {
  path: string;
  line: number;
}

export interface DomSelectionComponentStackEntry {
  name: string;
  source: DomSelectionSourcePoint | null;
}

export interface DomSelectionSourceLocation {
  method:
    | "code-inspector"
    | "debug-attr"
    | "react-fiber"
    | "vue-file"
    | "svelte"
    | "styled";
  path: string | null;
  line: number | null;
  column: number | null;
  componentName: string | null;
  componentStack: DomSelectionComponentStackEntry[] | null;
  searchHint: string | null;
}

/**
 * Execution-surface-neutral DOM capture. Browser supplies it through Tauri
 * IPC; Canvas builds the same contract directly from its scoped DOM root.
 */
export interface DomSelectionElementInfo {
  tagName: string;
  selector: string;
  id: string | null;
  className: string | null;
  attributes: Record<string, string>;
  innerText: string;
  innerHTML: string;
  rect: DomSelectionRect;
  computedStyle: DomSelectionComputedStyle;
  role: string;
  xpath: string;
  sourceLocation: DomSelectionSourceLocation | null;
}

export interface CanvasDomSelectionTargetSummary {
  label: string;
  selector: string;
  tagName: string;
  rect: DomSelectionRect;
}

export interface CanvasDomSelectionMetadata {
  schemaVersion: 1;
  origin: "canvas-design";
  canvas: {
    sessionId: string;
    eventId: string;
    mode: string;
    title: string;
  };
  selection: {
    kind: "element" | "region";
    label: string;
    rect: DomSelectionRect;
    targets?: CanvasDomSelectionTargetSummary[];
  };
  /** Sanitized, bounded snapshot used by history and preview surfaces only. */
  previewHtml?: string;
}

export interface BuiltDomComponent {
  jsonText: string;
  fileName: string;
  displayLabel: string;
}
