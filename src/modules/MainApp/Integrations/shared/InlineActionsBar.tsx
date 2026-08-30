/**
 * InlineActionsBar — standard action button row for inline expanded cards.
 *
 * Renders a horizontal cluster of `Button`s, typically rendered inside an
 * `<InlineCardFooter>`. Encapsulates the "Edit + Delete (+ optional primary)"
 * pattern that appears across Skills, Routines, Rules, MCP, Database, and
 * KeyVault inline cards.
 *
 * Accepts a typed `actions` array. Falsy entries are skipped so callers can
 * conditionally include actions inline without wrapping each in `{cond && (...)}`.
 *
 * Convenience props (`onEdit`, `onDelete`) build the most common Edit/Delete
 * pair with i18n labels + icons + the standard
 * `variant="danger" appearance="outline"` delete styling.
 *
 * @example Convenience form (Skills, MCP, KeyVault inline cards)
 * ```tsx
 * <InlineActionsBar onEdit={() => edit(name)} onDelete={handleDelete} deleteDisabled={removing} />
 * ```
 *
 * @example Explicit actions (Routines: fire/edit/delete with custom labels)
 * ```tsx
 * <InlineActionsBar
 *   actions={[
 *     { key: "fire", label: t("routineFields.fireNow"), variant: "primary", onClick: fire },
 *     { key: "edit", label: t("common:actions.edit"), variant: "secondary", onClick: edit },
 *     { key: "delete", label: t("common:actions.delete"), variant: "danger", appearance: "outline", onClick: del },
 *   ]}
 * />
 * ```
 */
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import type { ButtonAppearance, ButtonVariant } from "@src/components/Button";
import { Delete02Icon, HugeiconsIcon, Pen01Icon } from "@src/icons";

export interface InlineAction {
  /** Stable key for React reconciliation + test ids. */
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  variant?: ButtonVariant;
  appearance?: ButtonAppearance;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  dataTestId?: string;
}

interface InlineActionsBarProps {
  /** Explicit ordered list of actions. Falsy entries are skipped. */
  actions?: (InlineAction | false | null | undefined)[];
  /** Convenience: renders the standard Edit button when provided. */
  onEdit?: () => void;
  /** Convenience: renders the standard danger-outline Delete button when provided. */
  onDelete?: () => void;
  editLabel?: string;
  deleteLabel?: string;
  /**
   * Edit button visual weight. `"secondary"` (default) is the outlined style
   * used in most inline cards; `"tertiary"` is a quieter inline action used
   * in cards where Delete carries the visual weight.
   */
  editVariant?: "secondary" | "tertiary";
  editDisabled?: boolean;
  deleteDisabled?: boolean;
  deleteLoading?: boolean;
  editTestId?: string;
  deleteTestId?: string;
}

const InlineActionsBar: React.FC<InlineActionsBarProps> = ({
  actions,
  onEdit,
  onDelete,
  editLabel,
  deleteLabel,
  editVariant = "secondary",
  editDisabled,
  deleteDisabled,
  deleteLoading,
  editTestId,
  deleteTestId,
}) => {
  const { t } = useTranslation();

  const resolvedActions: InlineAction[] = React.useMemo(() => {
    const list: InlineAction[] = [];
    if (actions) {
      for (const action of actions) {
        if (action) list.push(action);
      }
    }
    if (onEdit) {
      list.push({
        key: "edit",
        label: editLabel ?? t("actions.edit"),
        icon: <HugeiconsIcon icon={Pen01Icon} data-icon="pencil" size={12} />,
        variant: editVariant,
        onClick: onEdit,
        disabled: editDisabled,
        dataTestId: editTestId,
      });
    }
    if (onDelete) {
      list.push({
        key: "delete",
        label: deleteLabel ?? t("actions.delete"),
        icon: (
          <HugeiconsIcon icon={Delete02Icon} data-icon="trash-2" size={12} />
        ),
        variant: "danger",
        appearance: "outline",
        onClick: onDelete,
        disabled: deleteDisabled,
        loading: deleteLoading,
        dataTestId: deleteTestId,
      });
    }
    return list;
  }, [
    actions,
    onEdit,
    onDelete,
    editLabel,
    deleteLabel,
    editVariant,
    editDisabled,
    deleteDisabled,
    deleteLoading,
    editTestId,
    deleteTestId,
    t,
  ]);

  if (resolvedActions.length === 0) return null;

  return (
    <>
      {resolvedActions.map((action) => (
        <Button
          key={action.key}
          size="small"
          variant={action.variant ?? "secondary"}
          appearance={action.appearance}
          icon={action.icon}
          onClick={action.onClick}
          disabled={action.disabled}
          loading={action.loading}
          data-testid={action.dataTestId}
        >
          {action.label}
        </Button>
      ))}
    </>
  );
};

export default InlineActionsBar;
