/**
 * Form Component
 *
 * Form wrapper with validation and layout support.
 *
 *
 * Features:
 * - Form layout (horizontal, vertical, inline)
 * - Form validation
 * - Form item labels and errors
 * - Required field indicators
 * - Colon support
 *
 * @example
 * ```tsx
 * import Form from "@src/components/Form";
 *
 * <Form layout="vertical">
 *   <Form.Item label="Username" required>
 *     <Input />
 *   </Form.Item>
 *   <Form.Item label="Email">
 *     <Input type="email" />
 *   </Form.Item>
 * </Form>
 * ```
 */
import React, { createContext, useContext, useMemo } from "react";

import "./index.scss";

// Form context
interface FormContextValue {
  layout: "horizontal" | "vertical" | "inline";
  labelAlign: "left" | "right";
  colon: boolean;
}

const FormContext = createContext<FormContextValue>({
  layout: "horizontal",
  labelAlign: "right",
  colon: true,
});

const useFormContext = () => useContext(FormContext);

// Form Props
interface FormProps {
  /**
   * Form layout
   * @default 'horizontal'
   */
  layout?: "horizontal" | "vertical" | "inline";

  /**
   * Label alignment
   * @default 'right'
   */
  labelAlign?: "left" | "right";

  /**
   * Label column width (for horizontal layout)
   */
  labelCol?: {
    span?: number;
    offset?: number;
  };

  /**
   * Wrapper column width (for horizontal layout)
   */
  wrapperCol?: {
    span?: number;
    offset?: number;
  };

  /**
   * Show colon after label
   * @default true
   */
  colon?: boolean;

  /**
   * Submit callback
   */
  onSubmit?: (e: React.FormEvent) => void;

  /**
   * Additional class name
   */
  className?: string;

  /**
   * Additional style
   */
  style?: React.CSSProperties;

  /**
   * Children
   */
  children?: React.ReactNode;
}

// Form Item Props
interface FormItemProps {
  /**
   * Field label
   */
  label?: React.ReactNode;

  /**
   * Required field indicator
   * @default false
   */
  required?: boolean;

  /**
   * Validation status
   */
  validateStatus?: "success" | "warning" | "error" | "validating";

  /**
   * Help text or error message
   */
  help?: React.ReactNode;

  /**
   * Extra description
   */
  extra?: React.ReactNode;

  /**
   * Show colon after label (overrides form-level setting)
   */
  colon?: boolean;

  /**
   * Additional class name
   */
  className?: string;

  /**
   * Additional style
   */
  style?: React.CSSProperties;

  /**
   * Children
   */
  children?: React.ReactNode;
}

// Form Item Component
const FormItem: React.FC<FormItemProps> = ({
  label,
  required = false,
  validateStatus,
  help,
  extra,
  colon: itemColon,
  className = "",
  style,
  children,
}) => {
  const formContext = useFormContext();
  const showColon = itemColon !== undefined ? itemColon : formContext.colon;

  const itemClasses = [
    "form-item",
    `form-item-${formContext.layout}`,
    validateStatus && `form-item-${validateStatus}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const labelClasses = [
    "form-item-label",
    `form-item-label-${formContext.labelAlign}`,
    required && "form-item-label-required",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={itemClasses} style={style}>
      {label && (
        <div className={labelClasses}>
          <label>
            {label}
            {showColon && <span className="form-item-colon">:</span>}
          </label>
        </div>
      )}
      <div className="form-item-control">
        <div className="form-item-control-input">{children}</div>
        {help && <div className="form-item-help">{help}</div>}
        {extra && <div className="form-item-extra">{extra}</div>}
      </div>
    </div>
  );
};

// Main Form Component
const Form: React.FC<FormProps> & {
  Item: typeof FormItem;
} = ({
  layout = "horizontal",
  labelAlign = "right",
  colon = true,
  onSubmit,
  className = "",
  style,
  children,
}) => {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit?.(e);
  };

  const formClasses = ["form", `form-${layout}`, className]
    .filter(Boolean)
    .join(" ");

  const contextValue: FormContextValue = useMemo(
    () => ({
      layout,
      labelAlign,
      colon,
    }),
    [layout, labelAlign, colon]
  );

  return (
    <FormContext.Provider value={contextValue}>
      <form className={formClasses} style={style} onSubmit={handleSubmit}>
        {children}
      </form>
    </FormContext.Provider>
  );
};

Form.Item = FormItem;

export default Form;
