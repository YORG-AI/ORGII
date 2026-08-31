/**
 * Shared Allow / Deny / Always Allow actions for permission prompts.
 */
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";

export type PermissionResponseWire = "allow" | "deny" | "always_allow";

export interface PermissionPromptActionsProps {
  layout?: "compact" | "mobile";
  disabled?: boolean;
  onDeny?: () => void;
  onAlwaysAllow?: () => void;
  onAllow?: () => void;
}

export function PermissionPromptActions({
  layout = "compact",
  disabled = false,
  onDeny,
  onAlwaysAllow,
  onAllow,
}: PermissionPromptActionsProps) {
  const { t } = useTranslation("sessions");
  const noop = useCallback(() => {}, []);

  if (layout === "mobile") {
    return (
      <div className="flex flex-col gap-2">
        <Button
          variant="primary"
          className="w-full"
          onClick={onAllow ?? noop}
          disabled={disabled}
        >
          {t("chat.allow", "Allow")}
        </Button>
        <Button
          variant="danger"
          appearance="outline"
          className="w-full"
          onClick={onDeny ?? noop}
          disabled={disabled}
        >
          {t("chat.deny", "Deny")}
        </Button>
        <Button
          variant="tertiary"
          appearance="ghost"
          className="w-full"
          onClick={onAlwaysAllow ?? noop}
          disabled={disabled}
        >
          {t("chat.alwaysAllow", "Always Allow")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      <Button
        variant="tertiary"
        size="mini"
        onClick={onDeny ?? noop}
        disabled={disabled}
      >
        {t("chat.deny", "Deny")}
      </Button>
      <Button
        variant="secondary"
        size="mini"
        onClick={onAlwaysAllow ?? noop}
        disabled={disabled}
      >
        {t("chat.alwaysAllow", "Always Allow")}
      </Button>
      <Button
        variant="primary"
        size="mini"
        onClick={onAllow ?? noop}
        disabled={disabled}
      >
        {t("chat.allow", "Allow")}
      </Button>
    </div>
  );
}

PermissionPromptActions.displayName = "PermissionPromptActions";
