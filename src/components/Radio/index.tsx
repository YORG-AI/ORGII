/**
 * Radio Component
 *
 * Native radio button with native styling using CSS variables.
 *
 * Features:
 * - Single radio button
 * - Radio group
 * - Controlled/uncontrolled modes
 * - Custom rendering
 * - Multiple sizes
 * - Disabled state
 * - Button style variant
 *
 * @example
 * ```tsx
 * import Radio from "@src/components/Radio";
 *
 * // Radio group
 * <Radio.Group
 *   defaultValue="apple"
 *   onChange={(value) => {}}
 * >
 *   <Radio value="apple">Apple</Radio>
 *   <Radio value="banana">Banana</Radio>
 *   <Radio value="orange">Orange</Radio>
 * </Radio.Group>
 *
 * // Button style
 * <Radio.Group type="button" defaultValue="a">
 *   <Radio value="a">Option A</Radio>
 *   <Radio value="b">Option B</Radio>
 * </Radio.Group>
 * ```
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import "./index.scss";

export type RadioValue = string | number;

// Radio Group Context
interface RadioGroupContextValue {
  value?: RadioValue;
  disabled?: boolean;
  type?: "radio" | "button";
  size?: "mini" | "small" | "default" | "large";
  onChange?: (value: RadioValue) => void;
}

const RadioGroupContext = createContext<RadioGroupContextValue | undefined>(
  undefined
);

interface RadioProps {
  /**
   * Checked state (controlled)
   */
  checked?: boolean;

  /**
   * Default checked state (uncontrolled)
   */
  defaultChecked?: boolean;

  /**
   * Disabled state
   */
  disabled?: boolean;

  /**
   * Radio value (for use in group)
   */
  value?: RadioValue;

  /**
   * Change callback
   */
  onChange?: (
    checked: boolean,
    event: React.ChangeEvent<HTMLInputElement>
  ) => void;

  /**
   * Radio size
   * @default 'default'
   */
  size?: "mini" | "small" | "default" | "large";

  /**
   * Additional class name
   */
  className?: string;

  /**
   * Additional style
   */
  style?: React.CSSProperties;

  /**
   * Children (label)
   */
  children?: React.ReactNode;
}

const Radio: React.FC<RadioProps> & {
  Group: typeof RadioGroup;
} = ({
  checked: controlledChecked,
  defaultChecked = false,
  disabled: propDisabled = false,
  value,
  onChange,
  size: propSize = "default",
  className = "",
  style,
  children,
}) => {
  const { isDark } = useCurrentTheme();
  const groupContext = useContext(RadioGroupContext);

  // Determine if radio is in a group
  const isInGroup = groupContext !== undefined;
  const disabled = propDisabled || groupContext?.disabled;
  const size = groupContext?.size || propSize;
  const type = groupContext?.type || "radio";

  // Determine checked state
  const [internalChecked, setInternalChecked] = useState(defaultChecked);

  let checked: boolean;
  if (isInGroup && groupContext?.value !== undefined) {
    checked = groupContext.value === value;
  } else if (controlledChecked !== undefined) {
    checked = controlledChecked;
  } else {
    checked = internalChecked;
  }

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (disabled) return;

      const newChecked = e.target.checked;

      if (isInGroup) {
        if (value !== undefined) groupContext?.onChange?.(value);
      } else {
        if (controlledChecked === undefined) {
          setInternalChecked(newChecked);
        }
        onChange?.(newChecked, e);
      }
    },
    [disabled, isInGroup, controlledChecked, onChange, groupContext, value]
  );

  const radioClasses = [
    type === "button" ? "radio-button" : "radio",
    `radio-size-${size}`,
    checked && (type === "button" ? "radio-button-checked" : "radio-checked"),
    disabled &&
      (type === "button" ? "radio-button-disabled" : "radio-disabled"),
    isDark && "radio-dark",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (type === "button") {
    return (
      <label className={radioClasses} style={style}>
        <input
          type="radio"
          className="radio-input"
          checked={checked}
          disabled={disabled}
          onChange={handleChange}
          value={value}
        />
        <span className="radio-button-content">{children}</span>
      </label>
    );
  }

  return (
    <label className={radioClasses} style={style}>
      <input
        type="radio"
        className="radio-input"
        checked={checked}
        disabled={disabled}
        onChange={handleChange}
        value={value}
      />
      <span className="radio-icon">
        {checked && <span className="radio-dot" />}
      </span>
      {children && <span className="radio-label">{children}</span>}
    </label>
  );
};

// Radio Group Component
interface RadioGroupProps {
  /**
   * Selected value (controlled)
   */
  value?: RadioValue;

  /**
   * Default selected value (uncontrolled)
   */
  defaultValue?: RadioValue;

  /**
   * Change callback
   */
  onChange?: (value: RadioValue) => void;

  /**
   * Disabled state for all radios
   */
  disabled?: boolean;

  /**
   * Radio options (alternative to children)
   */
  options?: Array<{
    label: React.ReactNode;
    value: RadioValue;
    disabled?: boolean;
  }>;

  /**
   * Radio type
   * @default 'radio'
   */
  type?: "radio" | "button";

  /**
   * Radio size
   * @default 'default'
   */
  size?: "mini" | "small" | "default" | "large";

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
   * Children (Radio components)
   */
  children?: React.ReactNode;
}

const RadioGroup: React.FC<RadioGroupProps> = ({
  value: controlledValue,
  defaultValue,
  onChange,
  disabled = false,
  options,
  type = "radio",
  size = "default",
  direction = "horizontal",
  className = "",
  style,
  children,
}) => {
  const { isDark } = useCurrentTheme();
  const [internalValue, setInternalValue] = useState<RadioValue | undefined>(
    defaultValue
  );

  const value = controlledValue !== undefined ? controlledValue : internalValue;

  const handleRadioChange = useCallback(
    (radioValue: RadioValue) => {
      if (controlledValue === undefined) {
        setInternalValue(radioValue);
      }
      onChange?.(radioValue);
    },
    [controlledValue, onChange]
  );

  const contextValue: RadioGroupContextValue = useMemo(
    () => ({
      value,
      disabled,
      type,
      size,
      onChange: handleRadioChange,
    }),
    [value, disabled, type, size, handleRadioChange]
  );

  const groupClasses = [
    "radio-group",
    type === "button" && "radio-group-button",
    `radio-group-${direction}`,
    isDark && "radio-group-dark",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <RadioGroupContext.Provider value={contextValue}>
      <div className={groupClasses} style={style}>
        {options
          ? options.map((option) => (
              <Radio
                key={option.value}
                value={option.value}
                disabled={option.disabled}
              >
                {option.label}
              </Radio>
            ))
          : children}
      </div>
    </RadioGroupContext.Provider>
  );
};

Radio.Group = RadioGroup;

export default Radio;
