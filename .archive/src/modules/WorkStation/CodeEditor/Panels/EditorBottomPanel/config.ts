/**
 * EditorBottomPanel Configuration
 *
 * Icons, constants, and tab configuration.
 */

// Re-export from store for convenience
export {
  BOTTOM_PANEL_TABS,
  BOTTOM_PANEL_TAB_LABELS,
  BOTTOM_PANEL_TAB_ORDER,
} from "@src/store/ui/workStationAtom";

export const ICON_CONFIG = {
  terminal: "Terminal",
  problems: "CircleAlert",
  output: "FileText",
  testResults: "FlaskConical",
} as const;
