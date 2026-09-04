/**
 * Checkbox Component
 *
 * Native checkbox with clean styling.
 *
 * Features:
 * - Single checkbox
 * - Checkbox group
 * - Indeterminate state
 * - Controlled/uncontrolled modes
 * - Multiple sizes
 * - Disabled state
 *
 * @example
 * ```tsx
 * import Checkbox from "@src/components/Checkbox";
 *
 * // Single checkbox
 * <Checkbox onCheckedChange={(checked) => {}}>
 *   Accept terms
 * </Checkbox>
 *
 * // Checkbox group
 * <Checkbox.Group
 *   defaultValue={['apple']}
 *   onChange={(values) => {}}
 * >
 *   <Checkbox value="apple">Apple</Checkbox>
 *   <Checkbox value="banana">Banana</Checkbox>
 *   <Checkbox value="orange">Orange</Checkbox>
 * </Checkbox.Group>
 * ```
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { HugeiconsIcon, MinusSignIcon, Tick01Icon } from "@src/icons";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

type CheckboxSize = "mini" | "small" | "default" | "large";

const CHECKBOX_SIZE_LABEL: Record<CheckboxSize, string> = {
  mini: "text-xs",
  small: "text-[13px]",
  default: "text-sm",
  large: "text-[15px]",
};

const CHECKBOX_ICON_BOX: Record<CheckboxSize, string> = {
  mini: "w-3.5 h-3.5",
  small: "w-[15px] h-[15px]",
  default: "w-4 h-4",
  large: "w-[18px] h-[18px]",
};

const CHECKBOX_ICON_PX: Record<CheckboxSize, number> = {
  mini: 10,
  small: 11,
  default: 12,
  large: 14,
};

function getCheckboxIconClassName(options: {
  size: CheckboxSize;
  isDark: boolean;
  disabled: boolean;
  isOn: boolean;
}): string {
  const { size, isDark, disabled, isOn } = options;
  const base = [
    "inline-flex items-center justify-center shrink-0 rounded border transition-[background-color,border-color,box-shadow] duration-200 ease-in-out",
    CHECKBOX_ICON_BOX[size],
    "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary-6",
  ];

  if (isOn) {
    return [...base, "bg-primary-6 border-primary-6"].join(" ");
  }
  if (disabled) {
    return [
      ...base,
      isDark ? "bg-fill-3 border-border-2" : "bg-fill-2 border-border-2",
    ].join(" ");
  }
  if (isDark) {
    return [...base, "bg-bg-2 border-border-2 hover:border-border-3"].join(" ");
  }
  return [...base, "bg-bg-1 border-border-2 hover:border-border-3"].join(" ");
}

function getCheckboxSvgClassName(isOn: boolean): string {
  return [
    "text-white transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.12,0.4,0.29,1.46)]",
    isOn ? "opacity-100 scale-100" : "opacity-0 scale-0",
  ].join(" ");
}

// Checkbox Group Context
interface CheckboxGroupContextValue {
  value: unknown[];
  disabled?: boolean;
  onChange: (value: unknown) => void;
}

const CheckboxGroupContext = createContext<
  CheckboxGroupContextValue | undefined
>(undefined);

interface CheckboxProps {
  /**
   * Checked state (controlled)
   */
  checked?: boolean;

  /**
   * Default checked state (uncontrolled)
   */
  defaultChecked?: boolean;

  /**
   * Indeterminate state
   */
  indeterminate?: boolean;

  /**
   * Disabled state
   */
  disabled?: boolean;

  /**
   * Checkbox value (for use in group)
   */
  value?: unknown;

  /**
   * Checked-state change callback
   */
  onCheckedChange?: (
    checked: boolean,
    event: React.ChangeEvent<HTMLInputElement>
  ) => void;

  /**
   * Checkbox size
   * @default 'default'
   */
  size?: CheckboxSize;

  /**
   * Additional class name
   */
  className?: string;

  /**
   * Additional style
   */
  style?: React.CSSProperties;

  /**
   * Click handler (called on label click, with stopPropagation)
   */
  onClick?: (e: React.MouseEvent<HTMLLabelElement>) => void;

  /**
   * Accessible label for icon-only checkboxes (no visible children)
   */
  ariaLabel?: string;

  /**
   * Children (label)
   */
  children?: React.ReactNode;
}

const Checkbox: React.FC<CheckboxProps> & {
  Group: typeof CheckboxGroup;
} = ({
  checked: controlledChecked,
  defaultChecked = false,
  indeterminate = false,
  disabled: propDisabled = false,
  value,
  onCheckedChange,
  onClick,
  size = "default",
  className = "",
  style,
  ariaLabel,
  children,
}) => {
  const { isDark } = useCurrentTheme();
  const groupContext = useContext(CheckboxGroupContext);
  const inputRef = useRef<HTMLInputElement>(null);

  // Determine if checkbox is in a group
  const isInGroup = groupContext !== undefined;
  const disabled = propDisabled || groupContext?.disabled;

  // Determine checked state
  const [internalChecked, setInternalChecked] = useState(defaultChecked);

  let checked: boolean;
  if (isInGroup) {
    checked = groupContext.value.includes(value);
  } else if (controlledChecked !== undefined) {
    checked = controlledChecked;
  } else {
    checked = internalChecked;
  }

  // Set indeterminate state on input element
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (disabled) return;

      const newChecked = event.target.checked;

      if (isInGroup) {
        groupContext.onChange(value);
      } else {
        if (controlledChecked === undefined) {
          setInternalChecked(newChecked);
        }
        onCheckedChange?.(newChecked, event);
      }
    },
    [
      disabled,
      isInGroup,
      controlledChecked,
      onCheckedChange,
      groupContext,
      value,
    ]
  );

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLLabelElement>) => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      // Stop propagation when onClick handler is provided (useful in lists/trees)
      if (onClick) {
        event.stopPropagation();
        onClick(event);
      }
    },
    [disabled, onClick]
  );

  const isOn = checked || indeterminate;
  const iconPixelSize = CHECKBOX_ICON_PX[size];

  const labelClassName = [
    "group inline-flex items-center gap-2 relative select-none",
    CHECKBOX_SIZE_LABEL[size],
    disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const iconClassName = getCheckboxIconClassName({
    size,
    isDark,
    disabled: Boolean(disabled),
    isOn,
  });

  const svgClassName = getCheckboxSvgClassName(isOn);

  return (
    <label
      className={labelClassName}
      style={style}
      onClick={handleClick}
      aria-label={!children ? ariaLabel : undefined}
      data-checkbox
    >
      <input
        ref={inputRef}
        type="checkbox"
        className="peer pointer-events-none absolute h-0 w-0 opacity-0"
        checked={checked}
        disabled={disabled}
        onChange={handleChange}
        data-checkbox-input
      />
      <span className={iconClassName} data-checkbox-icon>
        {indeterminate ? (
          <HugeiconsIcon
            icon={MinusSignIcon}
            data-icon="minus"
            size={iconPixelSize}
            strokeWidth={3}
            className={svgClassName}
          />
        ) : (
          <HugeiconsIcon
            icon={Tick01Icon}
            data-icon="check"
            size={iconPixelSize}
            strokeWidth={3}
            className={svgClassName}
          />
        )}
      </span>
      {children && (
        <span
          className={[
            "transition-colors duration-200 ease-in-out",
            disabled ? "text-text-4" : "text-text-1",
          ].join(" ")}
          data-checkbox-label
        >
          {children}
        </span>
      )}
    </label>
  );
};

// Checkbox Group Component
interface CheckboxGroupProps {
  /**
   * Selected values (controlled)
   */
  value?: unknown[];

  /**
   * Default selected values (uncontrolled)
   */
  defaultValue?: unknown[];

  /**
   * Change callback
   */
  onChange?: (values: unknown[]) => void;

  /**
   * Disabled state for all checkboxes
   */
  disabled?: boolean;

  /**
   * Checkbox options (alternative to children)
   */
  options?: Array<{
    label: React.ReactNode;
    value: unknown;
    disabled?: boolean;
  }>;

  /**
   * Layout direction
   * @default 'horizontal'
   */
  direction?: "horizontal" | "vertical";

  /**
   * Additional class name
   */
  className?: string;

  /**
   * Additional style
   */
  style?: React.CSSProperties;

  /**
   * Accessible label for the group (read by screen readers)
   */
  ariaLabel?: string;

  /**
   * Children (Checkbox components)
   */
  children?: React.ReactNode;
}

const CheckboxGroup: React.FC<CheckboxGroupProps> = ({
  value: controlledValue,
  defaultValue = [],
  onChange,
  disabled = false,
  options,
  direction = "horizontal",
  className = "",
  style,
  ariaLabel,
  children,
}) => {
  const [internalValue, setInternalValue] = useState<unknown[]>(defaultValue);

  const value = controlledValue !== undefined ? controlledValue : internalValue;

  const handleCheckboxChange = useCallback(
    (checkboxValue: unknown) => {
      const newValue = value.includes(checkboxValue)
        ? value.filter((valueItem) => valueItem !== checkboxValue)
        : [...value, checkboxValue];

      if (controlledValue === undefined) {
        setInternalValue(newValue);
      }
      onChange?.(newValue);
    },
    [value, controlledValue, onChange]
  );

  const contextValue: CheckboxGroupContextValue = useMemo(
    () => ({
      value,
      disabled,
      onChange: handleCheckboxChange,
    }),
    [value, disabled, handleCheckboxChange]
  );

  const groupClassName = [
    "flex gap-4",
    direction === "horizontal" ? "flex-row flex-wrap" : "flex-col",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <CheckboxGroupContext.Provider value={contextValue}>
      <div
        className={groupClassName}
        style={style}
        role="group"
        aria-label={ariaLabel}
        data-checkbox-group
      >
        {options
          ? options.map((option) => (
              <Checkbox
                key={String(option.value)}
                value={option.value}
                disabled={option.disabled}
              >
                {option.label}
              </Checkbox>
            ))
          : children}
      </div>
    </CheckboxGroupContext.Provider>
  );
};

Checkbox.Group = CheckboxGroup;

export default Checkbox;
