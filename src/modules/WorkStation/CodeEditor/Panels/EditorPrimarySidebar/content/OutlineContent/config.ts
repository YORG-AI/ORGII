/**
 * OutlineView Configuration
 *
 * Icons and constants for the outline view
 */
import {
  BoxIcon,
  CodeIcon,
  FileScriptIcon,
  FirstBracketIcon,
  FunctionSquareIcon,
  HashtagIcon,
  type IconSvgElement,
  TypeIcon,
  VariableIcon,
} from "@src/icons";

import type { SymbolKind } from "./types";

/**
 * Icon configuration for different symbol kinds
 */
export const SYMBOL_ICONS: Record<SymbolKind, IconSvgElement> = {
  function: FunctionSquareIcon,
  class: BoxIcon,
  interface: FirstBracketIcon,
  type: TypeIcon,
  const: VariableIcon,
  let: VariableIcon,
  var: VariableIcon,
  export: FileScriptIcon,
  import: FileScriptIcon,
  method: CodeIcon,
  property: HashtagIcon,
  enum: FirstBracketIcon,
};

/**
 * Color classes for different symbol kinds
 * Uses design system colors for proper light/dark theme support
 */
export const SYMBOL_COLORS: Record<SymbolKind, string> = {
  function: "text-primary-6",
  class: "text-warning-6",
  interface: "text-primary-6",
  type: "text-purple-6",
  const: "text-success-6",
  let: "text-success-6",
  var: "text-success-6",
  export: "text-warning-5",
  import: "text-warning-5",
  method: "text-primary-5",
  property: "text-text-2",
  enum: "text-danger-6",
};

/**
 * Display names for symbol kinds
 */
export const SYMBOL_LABELS: Record<SymbolKind, string> = {
  function: "Function",
  class: "Class",
  interface: "Interface",
  type: "Type",
  const: "Constant",
  let: "Variable",
  var: "Variable",
  export: "Export",
  import: "Import",
  method: "Method",
  property: "Property",
  enum: "Enum",
};
