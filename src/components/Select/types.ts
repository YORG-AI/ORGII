import type { CSSProperties, FocusEvent, ReactNode } from "react";

import type {
  DropdownOption,
  DropdownOptionGroup,
} from "@src/components/Dropdown/types";

/**
 * SelectOption is an alias for DropdownOption.
 * Both Dropdown (options mode) and Select share the same option shape.
 */
export type SelectOption = DropdownOption;

/**
 * SelectOptionGroup is an alias for DropdownOptionGroup.
 */
export type SelectOptionGroup = DropdownOptionGroup;

export interface SelectProps {
  value?: string | number | (string | number)[];
  defaultValue?: string | number | (string | number)[];
  onChange?: (
    value: string | number | (string | number)[],
    option: SelectOption | SelectOption[]
  ) => void;
  /** @default 'single' */
  mode?: "single" | "multiple";
  options?: (SelectOption | SelectOptionGroup)[];
  /** @default 'Please select' */
  placeholder?: ReactNode;
  /** @default 'default' */
  size?: "mini" | "small" | "default" | "large";
  disabled?: boolean;
  error?: boolean;
  loading?: boolean;
  allowClear?: boolean;
  showSearch?: boolean;
  filterOption?: (inputValue: string, option: SelectOption) => boolean;
  maxTagCount?: number;
  dropdownRender?: (menu: ReactNode) => ReactNode;
  className?: string;
  selectorClassName?: string;
  style?: CSSProperties;
  getPopupContainer?: () => HTMLElement;
  /** @default 'click' */
  trigger?: "click" | "hover";
  popupVisible?: boolean;
  defaultPopupVisible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
  onSearch?: (value: string) => void;
  onClear?: () => void;
  onFocus?: (event: FocusEvent) => void;
  onBlur?: (event: FocusEvent) => void;
  prefix?: ReactNode;
  /** @default 'auto' */
  placement?: "top" | "bottom" | "auto";
  /** Horizontal alignment of dropdown panel: "right" aligns right edges */
  dropdownAlign?: "left" | "right";
  dropdownMinWidth?: number;
  /** Exact dropdown panel width in pixels. */
  dropdownWidth?: number;
  /** @default 'min-match' */
  dropdownWidthMode?: "match" | "min-match" | "auto";
  /**
   * Override the dropdown panel z-index. Defaults to the dropdown token
   * (1050). Set higher when the Select is rendered inside a modal
   * (modal wrapper is 9999) so the panel sits above the modal mask.
   */
  panelZIndex?: number;
  /** @default 'lg' */
  radius?: "none" | "sm" | "md" | "lg" | "pill";
  /** @default 'default' */
  variant?: "default" | "ghost";
  /** Stable selector for rendered UI tests. */
  dataTestId?: string;
}
