/**
 * Select component configuration and constants
 */

/**
 * Radius to Tailwind class mapping
 */
export const RADIUS_CLASS_MAP = {
  none: "rounded-none",
  sm: "rounded-xs",
  md: "rounded-md",
  lg: "rounded-lg",
  pill: "rounded-full",
} as const;

/**
 * Default prop values
 */
export const SELECT_DEFAULTS = {
  mode: "single",
  placeholder: "",
  size: "default",
  disabled: false,
  error: false,
  loading: false,
  allowClear: false,
  showSearch: false,
  maxTagCount: Infinity,
  trigger: "click",
  defaultPopupVisible: false,
  placement: "auto",
  dropdownWidthMode: "min-match",
  radius: "lg",
} as const;
