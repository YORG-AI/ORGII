/**
 * VariantPill
 *
 * Compact pill showing the currently selected variant of a model —
 * reasoning effort and the optional "fast" flag — e.g. `Medium · Fast`.
 *
 * Rendered at the end of an account row in the UnifiedModelPalette's
 * right column. Clicking the pen icon opens the
 * {@link ModelPropertiesDropdown} so the user can edit the per-key
 * default variant (Thinking, Fast, Effort/Reasoning level) inline. The
 * change is persisted via the supplied `onApply` callback (which the
 * caller wires to `saveKey` with `default_variants`).
 */
import React from "react";

import ModelPropertiesDropdown from "@src/components/ModelPropertiesDropdown";
import { BrainIcon, HugeiconsIcon, Pen01Icon } from "@src/icons";
import {
  formatReasoningLevel,
  parseModelVariant,
} from "@src/util/modelVariants";
import { buildVariantEditOptions } from "@src/util/variantEditOptions";

export interface VariantPillProps {
  /** Concrete model id whose variant is being displayed. */
  modelId: string;
  /**
   * Every variant id in the model's family. Drives the
   * {@link ModelPropertiesDropdown}'s available level/fast matrix.
   * When omitted, the pill is non-editable (legacy callers).
   */
  groupModelIds?: readonly string[];
  /**
   * Called when the user picks a new variant and clicks Apply. Receives
   * the resolved model id. Caller persists it via the relevant
   * `default_variants` write path.
   */
  onApply?: (modelId: string) => void;
}

export const VariantPill: React.FC<VariantPillProps> = ({
  modelId,
  groupModelIds,
  onApply,
}) => {
  const variant = parseModelVariant(modelId);

  const variantOptions = React.useMemo(
    () => buildVariantEditOptions(groupModelIds ?? [modelId]),
    [groupModelIds, modelId]
  );

  const pillClasses =
    "relative z-10 inline-flex h-[24px] shrink-0 items-center gap-0.5 rounded-full border border-transparent bg-transparent px-2 text-[11px] font-semibold text-text-2 transition-colors group-hover/model-row:border-border-3 group-hover/model-row:bg-bg-1 group-focus-within/model-row:border-border-3 group-focus-within/model-row:bg-bg-1";

  const editable = onApply !== undefined && (groupModelIds?.length ?? 0) > 1;
  const parts: string[] = [];
  if (variant?.reasoning) {
    parts.push(formatReasoningLevel(variant.reasoning));
  }
  if (variant?.fast) {
    parts.push("Fast");
  }
  const showsDefault = !variant || (parts.length === 0 && !variant.thinking);
  if (!editable && showsDefault) {
    return null;
  }
  if (!editable && !variant?.thinking && parts.length === 0 && !showsDefault) {
    return null;
  }

  // Renders the pill contents. The `active` flag is set when the
  // dropdown is open so the JSX can force the same "lifted" text +
  // icon colour the hover state uses (we can't rely on `:hover` for
  // the dropdown-open case).
  const renderBody = (active: boolean) => (
    <>
      {variant?.thinking && (
        <span
          className={`mr-1 inline-flex items-center justify-center self-center ${
            active ? "text-text-1" : "group-hover/variant-pill:text-text-1"
          }`}
        >
          <HugeiconsIcon
            icon={BrainIcon}
            data-icon="brain"
            size={12}
            strokeWidth={1.75}
          />
        </span>
      )}
      {parts.map((part, index) => (
        <React.Fragment key={part}>
          {index > 0 && (
            <span
              className={
                active
                  ? "text-text-1"
                  : "text-text-4 group-hover/variant-pill:text-text-1"
              }
            >
              ·
            </span>
          )}
          <span
            className={
              active ? "text-text-1" : "group-hover/variant-pill:text-text-1"
            }
          >
            {part}
          </span>
        </React.Fragment>
      ))}
      {showsDefault && (
        <span
          className={
            active
              ? "text-text-1"
              : "text-text-3 group-hover/variant-pill:text-text-1"
          }
        >
          Default
        </span>
      )}
      {editable && (
        <HugeiconsIcon
          icon={Pen01Icon}
          data-icon="pencil"
          className={
            active
              ? "ml-1 text-text-1"
              : "ml-1 text-text-3 group-hover/variant-pill:text-text-1"
          }
          size={10}
        />
      )}
    </>
  );

  if (!editable || !onApply) {
    return (
      <span className={`${pillClasses} group/variant-pill`}>
        {renderBody(false)}
      </span>
    );
  }

  return (
    <ModelPropertiesDropdown
      variantOptions={variantOptions}
      value={modelId}
      onApply={onApply}
      sidePanelInContainer
      renderTrigger={({ ref, onClick, ariaExpanded }) => {
        const isActive = ariaExpanded;
        return (
          <button
            ref={ref}
            type="button"
            onClick={onClick}
            aria-expanded={ariaExpanded}
            aria-label="Edit variant"
            // `group` enables `group-hover:` text/icon lifts on the
            // nested label · separator · pencil. When the dropdown is
            // open (`isActive`), we pin the lifted colours via JSX so
            // the pill stays in its "active" appearance without
            // depending on the cursor staying inside.
            className={`${pillClasses} group/variant-pill cursor-pointer hover:border-border-3 hover:bg-fill-4 ${
              isActive ? "border-border-3 bg-fill-4" : ""
            }`}
          >
            {renderBody(isActive)}
          </button>
        );
      }}
    />
  );
};

export default VariantPill;
