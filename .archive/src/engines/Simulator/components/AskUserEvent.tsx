/**
 * AskUserEvent Component
 *
 * Renders the "ask_user_questions" event with questions list and input boxes.
 * Shows input form when pending, completed responses when answered.
 */
import { AnimatePresence, motion } from "framer-motion";
import { Check, CheckCheck, HelpCircle, Send } from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { BackendEvent } from "@src/types/session/steps";

// ============================================
// Types
// ============================================

interface InputField {
  name: string;
  required: boolean;
  value?: string;
}

interface AskUserEventProps {
  event: BackendEvent;
  /** Callback when user submits responses */
  onSubmit?: (responses: Record<string, string>) => void;
}

type AskUserState = "input" | "completed";

// ============================================
// Helper Functions
// ============================================

/**
 * Parse input_fields from event args
 */
const parseInputFields = (inputFieldsArg: string | undefined): InputField[] => {
  if (!inputFieldsArg) return [];

  try {
    const parsed = JSON.parse(inputFieldsArg);
    return Object.entries(parsed).map(([name, requirement]) => ({
      name,
      required: requirement === "required",
    }));
  } catch {
    return [];
  }
};

/**
 * Format field name for display
 */
const formatFieldName = (name: string): string => {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
};

/**
 * Check if a string looks like an ISO timestamp
 */
const isTimestamp = (str: string): boolean => {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(str);
};

/**
 * Unwrap result from timestamp-keyed format
 * The mock data converter wraps results as: { "2024-01-15T10:34:00Z": actualResult }
 * This function extracts the actual result object
 */
const unwrapResult = (
  result: Record<string, unknown> | null
): Record<string, unknown> => {
  if (!result) return {};

  const keys = Object.keys(result);

  // If all keys look like timestamps, unwrap the first one's value
  if (keys.length > 0 && keys.every(isTimestamp)) {
    const firstValue = result[keys[0]];
    if (
      firstValue &&
      typeof firstValue === "object" &&
      !Array.isArray(firstValue)
    ) {
      return firstValue as Record<string, unknown>;
    }
  }

  // Otherwise return as-is
  return result;
};

/**
 * Format a value for display - handles strings, objects, arrays, etc.
 */
const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value, null, 2);
};

// ============================================
// Subcomponents
// ============================================

/**
 * Input Fields State - Questions with input boxes
 */
interface InputStateProps {
  question: string;
  fields: InputField[];
  onSubmit?: (responses: Record<string, string>) => void;
}

const InputState = memo<InputStateProps>(({ question, fields, onSubmit }) => {
  const { t } = useTranslation("sessions");
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [focusedField, setFocusedField] = useState<string | null>(null);

  const handleInputChange = useCallback((fieldName: string, value: string) => {
    setResponses((prev) => ({ ...prev, [fieldName]: value }));
  }, []);

  const handleSubmit = useCallback(() => {
    onSubmit?.(responses);
  }, [responses, onSubmit]);

  const isFormValid = useMemo(() => {
    return fields
      .filter((field) => field.required)
      .every((field) => responses[field.name]?.trim());
  }, [fields, responses]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Question Header */}
      <motion.div
        className="shrink-0 border-b border-border-2 bg-gradient-to-r from-primary-1/50 to-transparent px-5 py-4"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-5/10">
            <HelpCircle size={16} className="text-primary-6" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wider text-primary-6">
              {t("simulator.askUser.agentQuestion")}
            </span>
            <p className="text-[15px] leading-relaxed text-text-1">
              {question}
            </p>
          </div>
        </div>
      </motion.div>

      {/* Input Fields */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-4">
          {fields.map((field, index) => (
            <motion.div
              key={field.name}
              className="flex flex-col gap-2"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: index * 0.1 }}
            >
              {/* Field Label */}
              <label className="flex items-center gap-1.5 text-sm font-medium text-text-2">
                {formatFieldName(field.name)}
                {field.required && <span className="text-danger-6">*</span>}
              </label>

              {/* Input Box */}
              <div
                className={`relative rounded-lg border transition-all duration-200 ${
                  focusedField === field.name
                    ? "border-primary-5 bg-primary-1/5 shadow-sm shadow-primary-5/10"
                    : "border-border-2 bg-fill-1 hover:border-border-3"
                }`}
              >
                <input
                  type="text"
                  value={responses[field.name] || ""}
                  onChange={(e) =>
                    handleInputChange(field.name, e.target.value)
                  }
                  onFocus={() => setFocusedField(field.name)}
                  onBlur={() => setFocusedField(null)}
                  placeholder={t("simulator.askUser.enterField", {
                    field: formatFieldName(field.name).toLowerCase(),
                  })}
                  className="w-full bg-transparent px-4 py-3 text-sm text-text-1 placeholder:text-text-4 focus:outline-none"
                />
                {responses[field.name] && (
                  <motion.div
                    className="absolute right-3 top-1/2 -translate-y-1/2"
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                  >
                    <Check size={16} className="text-success-6" />
                  </motion.div>
                )}
              </div>

              {/* Helper text for optional fields */}
              {!field.required && (
                <span className="text-xs text-text-4">
                  {t("simulator.askUser.optional")}
                </span>
              )}
            </motion.div>
          ))}
        </div>
      </div>

      {/* Submit Button */}
      <motion.div
        className="shrink-0 border-t border-border-2 bg-fill-1 px-5 py-4"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.2 }}
      >
        <button
          onClick={handleSubmit}
          disabled={!isFormValid}
          className={`flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-medium transition-all duration-200 ${
            isFormValid
              ? "bg-primary-6 text-white hover:bg-primary-7 active:scale-[0.98]"
              : "cursor-not-allowed bg-fill-2 text-text-4"
          }`}
        >
          <Send size={14} />
          <span>{t("simulator.askUser.submitResponse")}</span>
        </button>
      </motion.div>
    </div>
  );
});
InputState.displayName = "InputState";

/**
 * Completed State - Shows the submitted responses
 */
interface CompletedStateProps {
  question: string;
  fields: InputField[];
  responses: Record<string, unknown>;
}

const CompletedState = memo<CompletedStateProps>(({ question, responses }) => {
  const { t } = useTranslation("sessions");
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Question Header */}
      <div className="shrink-0 border-b border-border-2 bg-gradient-to-r from-success-1/50 to-transparent px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success-5/10">
            <CheckCheck size={16} className="text-success-6" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wider text-success-6">
              {t("simulator.askUser.responseReceived")}
            </span>
            <p className="text-[15px] leading-relaxed text-text-2">
              {question}
            </p>
          </div>
        </div>
      </div>

      {/* Responses List */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-3">
          {Object.entries(responses).map(([key, value], index) => (
            <motion.div
              key={key}
              className="flex flex-col gap-1 rounded-lg border border-border-2 bg-fill-1 p-4"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: index * 0.1 }}
            >
              <span className="text-xs font-medium text-text-3">
                {formatFieldName(key)}
              </span>
              <span className="whitespace-pre-wrap font-mono text-sm text-text-1">
                {formatValue(value)}
              </span>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
});
CompletedState.displayName = "CompletedState";

// ============================================
// Main Component
// ============================================

const AskUserEvent: React.FC<AskUserEventProps> = memo(
  ({ event, onSubmit }) => {
    const [internalState, setInternalState] = useState<AskUserState>("input");

    // Parse event data
    const { t } = useTranslation("sessions");
    const question =
      event.args?.question || t("simulator.askUser.defaultQuestion");
    const inputFields = useMemo(
      () => parseInputFields(event.args?.input_fields),
      [event.args?.input_fields]
    );
    const rawResult = event.result as Record<string, unknown> | null;
    const result = useMemo(() => unwrapResult(rawResult), [rawResult]);

    // Check if we have actual responses (not just empty object)
    const hasResponses = useMemo(() => {
      return result && Object.keys(result).length > 0;
    }, [result]);

    // Determine state based on event data
    const currentState = useMemo((): AskUserState => {
      if (hasResponses) return "completed";
      return internalState;
    }, [hasResponses, internalState]);

    // Handle form submission
    const handleSubmit = useCallback(
      (responses: Record<string, string>) => {
        setInternalState("completed");
        onSubmit?.(responses);
      },
      [onSubmit]
    );

    return (
      <div className="flex h-full w-full flex-col">
        <AnimatePresence mode="wait">
          {currentState === "input" && (
            <motion.div
              key="input"
              className="h-full"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.4 }}
            >
              <InputState
                question={question}
                fields={inputFields}
                onSubmit={handleSubmit}
              />
            </motion.div>
          )}

          {currentState === "completed" && (
            <motion.div
              key="completed"
              className="h-full"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3 }}
            >
              <CompletedState
                question={question}
                fields={inputFields}
                responses={result || {}}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }
);

AskUserEvent.displayName = "AskUserEvent";

export default AskUserEvent;
