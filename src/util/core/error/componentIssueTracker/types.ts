import { ComponentSuggestion } from "../../../config/componentMapping";

interface BoundingRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ComponentIssuePayload {
  componentLabel: string;
  tagName: string;
  id?: string;
  classList: string[];
  attributes: Record<string, string>;
  dataAttributes: Record<string, string>;
  textSample: string;
  htmlSnippet: string;
  cssSelector: string;
  domPath: string[];
  boundingRect: BoundingRect;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
  styleSnapshot: Record<string, string>;
  hierarchy: Array<{
    tag: string;
    id?: string;
    classList: string[];
    dataComponent?: string;
    role?: string;
  }>;
  timestamp: string;
  url: string;
  componentSuggestions?: ComponentSuggestion[];
  reactComponent?: {
    name?: string;
    fiber?: string;
  };
  contextClues?: {
    nearbyText?: string;
    siblingElements?: string[];
    eventHandlers?: string[];
    ariaAttributes?: Record<string, string>;
  };
  position?: {
    top: string;
    left: string;
    right: string;
    bottom: string;
    position: string;
  };
}
