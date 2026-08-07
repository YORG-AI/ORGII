/**
 * SaveableTextarea
 *
 * Reusable textarea with draft state, cancel/save actions, and status feedback.
 * Supports both sync and async onSave callbacks.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Textarea from "@src/components/Textarea";
import { countWords } from "@src/components/Textarea/wordCount";
import { useKeyboardSave } from "@src/hooks/keyboard";
import { createLogger } from "@src/hooks/logger";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

const log = createLogger("SaveableTextarea");

export interface SaveableTextareaProps {
  /** Current saved value */
  value: string;
  /** Called when user clicks Save. Can be async (shows saving/error states). */
  onSave: (value: string) => void | Promise<void>;
  placeholder?: string;
  /** Auto-size config for the textarea */
  autoSize?: { minRows?: number; maxRows?: number };
  /** Maximum number of characters allowed in the draft. */
  maxLength?: number;
  /** Maximum number of locale-aware words allowed in the draft. */
  maxWords?: number;
  /** Show the textarea's built-in character counter. */
  showWordLimit?: boolean;
  /** Whether the component is in a loading state (hides content) */
  loading?: boolean;
  dataTestId?: string;
  saveButtonDataTestId?: string;
}

const SaveableTextarea: React.FC<SaveableTextareaProps> = ({
  value,
  onSave,
  placeholder,
  autoSize = { minRows: 3, maxRows: 10 },
  maxLength,
  maxWords,
  showWordLimit = false,
  loading = false,
  dataTestId,
  saveButtonDataTestId,
}) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">(
    "idle"
  );

  // Sync draft when saved value changes externally
  const prevValueRef = useRef(value);

  useEffect(() => {
    if (prevValueRef.current !== value) {
      prevValueRef.current = value;
      setDraft(value);
    }
  }, [value]);

  const hasChanges = draft !== value;
  const exceedsWordLimit =
    maxWords !== undefined && countWords(draft) > maxWords;

  const handleSave = useCallback(async () => {
    if (exceedsWordLimit) return;

    setSaving(true);
    setSaveStatus("idle");

    try {
      await onSave(draft);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (err: unknown) {
      log.error("[SaveableTextarea] Save failed:", err);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } finally {
      setSaving(false);
    }
  }, [draft, exceedsWordLimit, onSave]);

  const handleCancel = useCallback(() => {
    setDraft(value);
  }, [value]);

  useKeyboardSave(handleSave, hasChanges && !saving && !exceedsWordLimit);

  if (loading) return <Placeholder variant="loading" />;

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={draft}
        onChange={(val: string) => setDraft(val)}
        placeholder={placeholder}
        autoSize={autoSize}
        maxLength={maxLength}
        maxWords={maxWords}
        showWordLimit={showWordLimit}
        data-testid={dataTestId}
      />
      <div className="flex items-center gap-2">
        {hasChanges && (
          <Button size="default" onClick={handleCancel} disabled={saving}>
            {t("actions.cancel")}
          </Button>
        )}
        <Button
          size="default"
          variant="primary"
          onClick={handleSave}
          disabled={!hasChanges || saving || exceedsWordLimit}
          data-testid={saveButtonDataTestId}
        >
          {saving ? t("status.saving") : t("actions.save")}
        </Button>
        {saveStatus === "saved" && (
          <span className="text-xs text-success-6">{t("status.saved")}</span>
        )}
        {saveStatus === "error" && (
          <span className="text-xs text-danger-6">
            {t("status.saveFailed")}
          </span>
        )}
      </div>
    </div>
  );
};

export default SaveableTextarea;
