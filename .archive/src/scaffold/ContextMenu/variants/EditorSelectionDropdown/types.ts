/**
 * Types for EditorSelectionDropdown
 */

export interface SelectionInfo {
  /** Selected text content */
  text: string;
  /** Start line number (1-based) */
  fromLine: number;
  /** End line number (1-based) */
  toLine: number;
  /** File path */
  filePath: string;
}

export interface EditorSelectionDropdownProps {
  /** Whether the dropdown is visible */
  visible: boolean;
  /** Position of the dropdown */
  position: { x: number; y: number };
  /** Selection information */
  selection: SelectionInfo;
  /** Callback when dropdown should close */
  onClose: () => void;
  /** Callback when "Add this file to agent" is selected */
  onAddFile?: (filePath: string) => void;
  /** Callback when "Add line x ~ y to agent" is selected */
  onAddLines?: (
    filePath: string,
    fromLine: number,
    toLine: number,
    text: string
  ) => void;
  /** Optional class name */
  className?: string;
}
