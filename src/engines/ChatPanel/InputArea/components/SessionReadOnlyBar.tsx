/**
 * SessionReadOnlyBar
 *
 * Generic read-only composer placeholder. Renders the same ComposerShell +
 * ComposerBar silhouette as the normal composer — identical height, padding,
 * background, border — but without any interactive input.
 *
 * Uses ComposerBar directly so the pill/context-ring row is pixel-identical
 * to the live composer's toolbar row. Callers supply `pills` (left cluster);
 * the right cluster shows the context-info ring (read-only, no writes) plus
 * the lock badge in place of the submit button.
 *
 * No text editor, no submit, no event hooks.
 */
import { Lock } from "lucide-react";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import ComposerBar from "@src/components/ComposerBar";
import ComposerShell from "@src/components/ComposerShell";

import ContextInfoButton from "./ContextInfoButton";

interface SessionReadOnlyBarProps {
  /** Left-side pill row — pass any React node(s). */
  pills?: React.ReactNode;
  /** Override the right-side badge text. Defaults to the i18n "Read-only" string. */
  label?: string;
}

const SessionReadOnlyBar: React.FC<SessionReadOnlyBarProps> = memo(
  ({ pills, label }) => {
    const { t } = useTranslation("sessions");
    const badgeLabel =
      label ?? t("chat.readOnly", { defaultValue: "Read-only" });

    return (
      <ComposerShell variant="embedded">
        <ComposerBar
          onAddContent={() => undefined}
          onUpload={() => undefined}
          hideAddButton
          dropdownDirection="up"
          showContextInfo={false}
          pills={pills}
          submitButton={
            <div className="flex items-center gap-1.5">
              <ContextInfoButton variant="toolbar" />
              <div className="flex cursor-default select-none items-center gap-1 text-text-4 opacity-60">
                <Lock size={11} strokeWidth={1.75} />
                <span className="text-[11px] leading-none">{badgeLabel}</span>
              </div>
            </div>
          }
        />
      </ComposerShell>
    );
  }
);

SessionReadOnlyBar.displayName = "SessionReadOnlyBar";

export default SessionReadOnlyBar;
