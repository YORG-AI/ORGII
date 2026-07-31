/**
 * FormField Component
 *
 * Labeled form input wrapper used by wizard steps.
 * Provides consistent label + optional required marker + error display.
 *
 * @example
 * ```tsx
 * <FormField label="API Key" required>
 *   <Input value={key} onChange={setKey} />
 * </FormField>
 *
 * <FormField label="Description">
 *   <Textarea value={desc} onChange={setDesc} />
 * </FormField>
 * ```
 */
import React from "react";

import { TYPOGRAPHY } from "@src/config/workstation/tokens";

// ============================================
// Tokens
// ============================================

export const FORM_FIELD_TOKENS = {
  label: `${TYPOGRAPHY.valueMedium} text-text-2`,
  labelMargin: "mb-1.5",
  hint: `mt-1 text-text-3 ${TYPOGRAPHY.secondary}`,
  error: `mt-1 text-danger-6 ${TYPOGRAPHY.value}`,
  warning: `mt-1 text-warning-6 ${TYPOGRAPHY.secondary}`,
} as const;

// ============================================
// Types
// ============================================

export interface FormFieldProps {
  /** Label text above the input */
  label: string;
  /** Show a red asterisk after the label */
  required?: boolean;
  /** Error message to display below the input */
  error?: string;
  /** Warning message to display below the input (yellow) */
  warning?: string;
  /** Help text displayed below the children */
  hint?: React.ReactNode;
  /** Icon/element rendered immediately after the label text (e.g. tooltip) */
  labelIcon?: React.ReactNode;
  /** Extra content pushed to the far right of the label row (e.g. hints) */
  labelSuffix?: React.ReactNode;
  /** Outer wrapper class */
  className?: string;
  /** The form control(s) */
  children?: React.ReactNode;
}

// ============================================
// Component
// ============================================

const FormField: React.FC<FormFieldProps> = ({
  label,
  required,
  error,
  warning,
  hint,
  labelIcon,
  labelSuffix,
  className,
  children,
}) => {
  return (
    <div className={className}>
      <div
        className={`${FORM_FIELD_TOKENS.labelMargin} flex items-center gap-1`}
      >
        <label className={FORM_FIELD_TOKENS.label}>
          {label}
          {required && <span className="text-danger-6"> *</span>}
        </label>
        {labelIcon}
        {labelSuffix && <div className="ml-auto">{labelSuffix}</div>}
      </div>
      {children}
      {hint && <p className={FORM_FIELD_TOKENS.hint}>{hint}</p>}
      {error && <p className={FORM_FIELD_TOKENS.error}>{error}</p>}
      {warning && <p className={FORM_FIELD_TOKENS.warning}>{warning}</p>}
    </div>
  );
};

export default FormField;
