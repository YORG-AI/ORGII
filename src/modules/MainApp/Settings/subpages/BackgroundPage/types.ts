/**
 * Background Page Types
 */

export interface BackgroundSettingsProps {
  /** Whether to show the back button and header */
  showHeader?: boolean;
  /**
   * When true, renders as inline section content (parent provides scroll).
   * Use inside Appearance settings; omit outer full-height shell and ScrollFadeContainer.
   */
  embedded?: boolean;
  /** Optional custom translation namespace (defaults to "settings") */
  translationNamespace?: string;
}
