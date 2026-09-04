/**
 * Floating bar — bottom pill UI shared by Workstation unsaved changes.
 *
 * - `FloatingBar.Layer` — absolute stack container (12px from bottom).
 * - `FloatingBar` — single pill with `variant: "unsaved"`.
 *
 * `UnsavedChangesBar` is a convenience wrapper: one unsaved variant inside a Layer.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@src/components/IconButton";
import {
  HugeiconsIcon,
  Loading03Icon,
  Tick01Icon,
  Undo02Icon,
} from "@src/icons";
import { HUMANTOOLS_TEXT_KEYS } from "@src/modules/WorkStation/shared/textTokens";
import {
  HEADER_ICON_SIZE,
  TYPOGRAPHY,
} from "@src/modules/WorkStation/shared/tokens";

function FloatingBarLayer({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute right-0 bottom-[12px] left-0 z-10 flex flex-row flex-nowrap items-center justify-center gap-2">
      {children}
    </div>
  );
}

FloatingBarLayer.displayName = "FloatingBar.Layer";

function FloatingBarPill({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-auto box-border flex h-8 max-h-8 min-h-8 shrink-0 items-center gap-2 rounded-full border border-solid border-border-2 bg-fill-2 pr-1.5 pl-4 shadow-[0_2px_12px_rgba(0,0,0,0.14)]">
      {children}
    </div>
  );
}

interface UnsavedChangesBarProps {
  /** Text to display (default: translated "Unsaved changes") */
  message?: string;
  /** Whether save operation is in progress */
  saving?: boolean;
  /** Callback when Save button is clicked */
  onSave: () => void;
  /** Optional callback when Discard button is clicked */
  onDiscard?: () => void;
}

type FloatingBarProps = { variant: "unsaved" } & UnsavedChangesBarProps;

const FloatingBarUnsaved: React.FC<UnsavedChangesBarProps> = memo(
  ({ message, saving = false, onSave, onDiscard }) => {
    const { t } = useTranslation();
    const defaultMessage = t(HUMANTOOLS_TEXT_KEYS.placeholders.unsavedChanges);

    return (
      <FloatingBarPill>
        <span className={`${TYPOGRAPHY.valueMedium} text-text-1`}>
          {message ?? defaultMessage}
        </span>
        {onDiscard && (
          <IconButton
            size="sm"
            type="button"
            variant="default"
            onClick={onDiscard}
            disabled={saving}
            className="shrink-0 rounded-full text-text-2 hover:text-text-1"
            title={t("actions.discard")}
            aria-label={t("actions.discard")}
          >
            <HugeiconsIcon
              icon={Undo02Icon}
              data-icon="undo-2"
              size={HEADER_ICON_SIZE.sm}
              strokeWidth={1.75}
            />
          </IconButton>
        )}
        <IconButton
          size="sm"
          type="button"
          variant="default"
          onClick={onSave}
          disabled={saving}
          className="shrink-0 rounded-full bg-primary-6 text-white hover:bg-primary-7!"
          title={saving ? t("status.saving") : t("actions.save")}
          aria-label={saving ? t("status.saving") : t("actions.save")}
        >
          {saving ? (
            <HugeiconsIcon
              icon={Loading03Icon}
              data-icon="loader-2"
              size={HEADER_ICON_SIZE.sm}
              strokeWidth={1.75}
              className="animate-spin"
            />
          ) : (
            <HugeiconsIcon
              icon={Tick01Icon}
              data-icon="check"
              size={HEADER_ICON_SIZE.sm}
              strokeWidth={1.75}
            />
          )}
        </IconButton>
      </FloatingBarPill>
    );
  }
);

FloatingBarUnsaved.displayName = "FloatingBarUnsaved";

function FloatingBarRoot(props: FloatingBarProps) {
  return (
    <FloatingBarUnsaved
      message={props.message}
      saving={props.saving}
      onSave={props.onSave}
      onDiscard={props.onDiscard}
    />
  );
}

const FloatingBar = Object.assign(memo(FloatingBarRoot), {
  Layer: FloatingBarLayer,
});

FloatingBar.displayName = "FloatingBar";

export { FloatingBar };

export const UnsavedChangesBar: React.FC<UnsavedChangesBarProps> = memo(
  (props) => (
    <FloatingBar.Layer>
      <FloatingBar variant="unsaved" {...props} />
    </FloatingBar.Layer>
  )
);

UnsavedChangesBar.displayName = "UnsavedChangesBar";

export default UnsavedChangesBar;
