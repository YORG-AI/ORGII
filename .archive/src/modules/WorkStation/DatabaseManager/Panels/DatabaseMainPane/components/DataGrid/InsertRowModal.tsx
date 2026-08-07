/**
 * InsertRowModal Component
 *
 * Modal dialog for inserting a new row into a database table.
 * Shows a form with fields for each column.
 */
import { X } from "lucide-react";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type { ColumnInfo } from "@src/engines/DatabaseCore";
import { HEADER_BUTTON } from "@src/modules/WorkStation/shared/tokens";
import { PanelFooter } from "@src/modules/shared/layouts/blocks";

// ============================================
// Types
// ============================================

export interface InsertRowModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Table name */
  tableName: string;
  /** Column schema */
  schema: ColumnInfo[];
  /** Callback when form is submitted */
  onInsert: (data: Record<string, unknown>) => void;
  /** Callback to close the modal */
  onClose: () => void;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Parse input value based on column type
 */
function parseValue(inputValue: string, columnType: string): unknown {
  const typeUpper = columnType.toUpperCase();

  // Handle empty or NULL
  if (inputValue === "" || inputValue.toLowerCase() === "null") {
    return null;
  }

  // Integer types
  if (typeUpper.includes("INT")) {
    const parsed = parseInt(inputValue, 10);
    return isNaN(parsed) ? inputValue : parsed;
  }

  // Real/Float types
  if (
    typeUpper.includes("REAL") ||
    typeUpper.includes("FLOAT") ||
    typeUpper.includes("DOUBLE") ||
    typeUpper.includes("NUMERIC") ||
    typeUpper.includes("DECIMAL")
  ) {
    const parsed = parseFloat(inputValue);
    return isNaN(parsed) ? inputValue : parsed;
  }

  // Boolean
  if (typeUpper === "BOOLEAN" || typeUpper === "BOOL") {
    const lower = inputValue.toLowerCase();
    if (lower === "true" || lower === "1") return 1;
    if (lower === "false" || lower === "0") return 0;
    return inputValue;
  }

  return inputValue;
}

/**
 * Check if a default value is a SQL function that should be handled by the database
 */
function isSqlFunctionDefault(
  defaultValue: string | null | undefined
): boolean {
  if (!defaultValue) return false;
  const cleaned = defaultValue.replace(/^['"]|['"]$/g, "").toLowerCase();
  // Common SQL functions that should be evaluated by the database
  return (
    cleaned.includes("now()") ||
    cleaned.includes("current_timestamp") ||
    cleaned.includes("current_date") ||
    cleaned.includes("current_time") ||
    cleaned.includes("gen_random_uuid()") ||
    cleaned.includes("uuid_generate") ||
    cleaned.includes("nextval(")
  );
}

/**
 * Get default value for a column (for display in input)
 */
function getDefaultValue(column: ColumnInfo): string {
  // For SQL function defaults, show empty so user knows it's auto-generated
  if (isSqlFunctionDefault(column.defaultValue)) {
    return "";
  }
  if (column.defaultValue !== null && column.defaultValue !== undefined) {
    // Remove quotes from default value
    return column.defaultValue.replace(/^['"]|['"]$/g, "");
  }
  return "";
}

/**
 * Get placeholder text for a column
 */
function getPlaceholder(column: ColumnInfo): string {
  if (column.primaryKey) return "Auto (Primary Key)";
  if (isSqlFunctionDefault(column.defaultValue)) {
    const funcName = column.defaultValue?.replace(/^['"]|['"]$/g, "") ?? "";
    return `Auto: ${funcName}`;
  }
  if (!column.nullable) return `Required (${column.type})`;
  return `NULL (${column.type})`;
}

// ============================================
// Component
// ============================================

export const InsertRowModal: React.FC<InsertRowModalProps> = memo(
  ({ isOpen, tableName, schema, onInsert, onClose }) => {
    const { t } = useTranslation();
    const modalRef = useRef<HTMLDivElement>(null);
    const firstInputRef = useRef<HTMLInputElement>(null);

    // Compute initial values from schema (memoized)
    const initialValues = useMemo(() => {
      const initial: Record<string, string> = {};
      schema.forEach((col) => {
        initial[col.name] = getDefaultValue(col);
      });
      return initial;
    }, [schema]);

    // Track modal open state to reset values
    const [values, setValues] = useState<Record<string, string>>(initialValues);
    const [wasOpen, setWasOpen] = useState(false);

    // Reset values when modal opens (using state sync pattern)
    if (isOpen && !wasOpen) {
      setWasOpen(true);
      setValues(initialValues);
    } else if (!isOpen && wasOpen) {
      setWasOpen(false);
    }

    // Focus first input when modal opens (effect for DOM interaction)
    useEffect(() => {
      if (isOpen) {
        const timer = setTimeout(() => {
          firstInputRef.current?.focus();
        }, 100);
        return () => clearTimeout(timer);
      }
    }, [isOpen]);

    // Handle field change
    const handleChange = useCallback((columnName: string, value: string) => {
      setValues((prev) => ({ ...prev, [columnName]: value }));
    }, []);

    // Handle form submit
    const handleSubmit = useCallback(
      (event: React.FormEvent) => {
        event.preventDefault();

        // Parse values according to column types
        const data: Record<string, unknown> = {};
        schema.forEach((col) => {
          const inputValue = values[col.name] ?? "";
          // Skip empty primary key fields (let database auto-generate)
          if (col.primaryKey && inputValue === "") {
            return;
          }
          // Skip empty fields with SQL function defaults (let database handle them)
          if (inputValue === "" && isSqlFunctionDefault(col.defaultValue)) {
            return;
          }
          data[col.name] = parseValue(inputValue, col.type);
        });

        onInsert(data);
        onClose();
      },
      [schema, values, onInsert, onClose]
    );

    // Handle escape key
    useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && isOpen) {
          onClose();
        }
      };
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, onClose]);

    // Handle click outside
    const handleBackdropClick = useCallback(
      (event: React.MouseEvent) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      },
      [onClose]
    );

    if (!isOpen) {
      return null;
    }

    // Find first non-PK column for auto-focus
    const firstNonPkIndex = schema.findIndex((col) => !col.primaryKey);

    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        onClick={handleBackdropClick}
      >
        <div
          ref={modalRef}
          className="w-full max-w-md rounded-lg border border-border-2 bg-bg-2 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border-1 px-4 py-3">
            <h3 className="text-sm font-medium text-text-1">
              Insert Row into {tableName}
            </h3>
            <button onClick={onClose} className={HEADER_BUTTON.actionMd}>
              <X size={16} strokeWidth={1.75} />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="p-4">
            <div className="max-h-[60vh] space-y-3 overflow-y-auto">
              {schema.map((column, index) => (
                <div key={column.name} className="space-y-1">
                  <label className="flex items-center gap-2 text-xs text-text-2">
                    <span>{column.name}</span>
                    {column.primaryKey && (
                      <span className="rounded bg-[color-mix(in_srgb,var(--color-warning-6)_15%,transparent)] px-1 py-0.5 text-[10px] font-medium text-[var(--color-warning-6)]">
                        PK
                      </span>
                    )}
                    {!column.nullable && !column.primaryKey && (
                      <span className="rounded bg-fill-2 px-1 py-0.5 text-[10px] text-text-3">
                        {t("common:common.required")}
                      </span>
                    )}
                    <span className="ml-auto text-text-4">{column.type}</span>
                  </label>
                  <input
                    ref={index === firstNonPkIndex ? firstInputRef : undefined}
                    type="text"
                    value={values[column.name] ?? ""}
                    onChange={(e) => handleChange(column.name, e.target.value)}
                    placeholder={getPlaceholder(column)}
                    disabled={column.primaryKey && !values[column.name]}
                    className="w-full rounded border border-border-2 bg-bg-1 px-3 py-2 text-sm text-text-1 placeholder:text-text-4 focus:border-primary-6 focus:outline-none disabled:opacity-50"
                  />
                </div>
              ))}
            </div>

            <PanelFooter
              className="mt-4"
              secondaryActions={[
                {
                  label: t("actions.cancel"),
                  onClick: onClose,
                  htmlType: "button",
                },
              ]}
              primaryAction={{
                label: "Insert Row",
                onClick: () => {},
                htmlType: "submit",
              }}
            />
          </form>
        </div>
      </div>
    );
  }
);

InsertRowModal.displayName = "InsertRowModal";

export default InsertRowModal;
