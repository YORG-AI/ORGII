/**
 * SettingsTableAddFooter — reusable "+ Add" footer for SettingsTable.
 *
 * Renders a text button with Plus icon.  Pass as the `footer` prop of
 * SettingsTable, or use the `addFooter` shorthand prop (see SettingsTable).
 */
import Button from "@src/components/Button";
import { Add01Icon, HugeiconsIcon } from "@src/icons";

export interface SettingsTableAddFooterProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Match SettingsTable `noPx` — no horizontal padding when nested in SectionContainer. */
  noPx?: boolean;
  /** Stable selector for E2E tests (e.g. "agent-orgs-add-rule-button"). */
  dataTestId?: string;
}

const ADD_BUTTON_CLASS = "text-text-3 hover:text-text-1";

export function SettingsTableAddFooter({
  label,
  onClick,
  disabled,
  noPx = false,
  dataTestId,
}: SettingsTableAddFooterProps) {
  return (
    <div
      className={`flex items-center rounded-b-xl bg-[var(--settings-table-surface)] py-2 ${noPx ? "px-0" : "px-4"}`}
    >
      <Button
        variant="tertiary"
        size="default"
        icon={<HugeiconsIcon icon={Add01Icon} data-icon="plus" size={14} />}
        onClick={onClick}
        disabled={disabled}
        className={ADD_BUTTON_CLASS}
        data-testid={dataTestId}
      >
        {label}
      </Button>
    </div>
  );
}
