/**
 * Types for the CanvasInlineCard chat block.
 *
 * Three rendering modes mirror the WorkStation Canvas app:
 *   html   — Agent-provided HTML sanitized and rendered in Shadow DOM
 *   url    — External URL shown as an open action, not embedded in chat
 *   a2ui   — Agent-to-UI JSONL stream, rendered incrementally as native React
 *   react  — Generated React App source compiled and executed in a sandboxed
 *            canvas-artifact iframe (ReactArtifactRunner)
 */

export type CanvasInlineMode = "html" | "url" | "a2ui" | "react";

/**
 * Payload emitted by a `render_inline_canvas` tool call and stored in
 * `canvasPreviewAtom`. Shared by the streaming overlay (ChatVariant) and
 * the Simulator canvas jump.
 */
export interface CanvasInlinePayload {
  mode: CanvasInlineMode;
  content?: string;
  url?: string;
  title?: string;
  streaming?: boolean;
  eventId?: string;
  /** Event id of the prior Canvas version when this payload is a revision. */
  revisesEventId?: string;
}

export interface CanvasInlineCardProps {
  /** Rendering mode — determines how `content` / `url` are used. */
  mode: CanvasInlineMode;
  /**
   * Raw HTML string (mode="html"), JavaScript React component source
   * (mode="react"), or JSONL content (mode="a2ui"). Ignored when mode="url".
   */
  content?: string;
  /** Target URL for mode="url". */
  url?: string;
  /**
   * Optional display title shown in the card toolbar.
   * Defaults to a locale string like "Agent Preview".
   */
  title?: string;
  /** Initial height in px. Defaults to 280. */
  initialHeight?: number;
  /** Whether the agent is still streaming content into this card. */
  isStreaming?: boolean;
  /** Event id used by the header jump-to-simulator action. */
  eventId?: string;
  /**
   * Session ID for the canvas preview. When provided together with the
   * card's content, the toolbar shows a "View in Simulator" button that
   * jumps the Simulator panel to the CANVAS app.
   */
  sessionId?: string;
  /**
   * Called when a button is clicked or form is submitted inside the A2UI
   * renderer. Receives the actionId and an optional payload.
   */
  onAction?: (actionId: string, payload?: unknown) => void;
}

/** A single A2UI JSONL element. */
export type A2UIElement =
  | A2UIHeading
  | A2UIText
  | A2UICode
  | A2UIImage
  | A2UIButton
  | A2UIDivider
  | A2UIList
  | A2UIHtml
  | A2UITable
  | A2UIChart
  | A2UIForm;

interface A2UIBase {
  style?: string;
}

export interface A2UIHeading extends A2UIBase {
  type: "heading";
  content?: string;
}

export interface A2UIText extends A2UIBase {
  type: "text";
  content?: string;
}

export interface A2UICode extends A2UIBase {
  type: "code";
  content?: string;
}

export interface A2UIImage extends A2UIBase {
  type: "image";
  content?: string;
}

export interface A2UIButton extends A2UIBase {
  type: "button";
  content?: string;
  /** Identifies the action to fire when this button is clicked. */
  actionId?: string;
}

export interface A2UIDivider extends A2UIBase {
  type: "divider";
  content?: string;
}

export interface A2UIList extends A2UIBase {
  type: "list";
  content?: string;
  items?: string[];
}

export interface A2UIHtml extends A2UIBase {
  type: "html";
  content?: string;
}

export interface A2UITable extends A2UIBase {
  type: "table";
  headers: string[];
  rows: string[][];
}

export interface A2UIChart extends A2UIBase {
  type: "chart";
  chartType: "line" | "bar";
  data: {
    labels: string[];
    datasets: { label: string; values: number[] }[];
  };
  title?: string;
}

export interface A2UIFormField {
  name: string;
  label: string;
  inputType: "text" | "select" | "checkbox";
  options?: string[];
  defaultValue?: string;
}

export interface A2UIForm extends A2UIBase {
  type: "form";
  fields: A2UIFormField[];
  submitLabel?: string;
  actionId?: string;
}
