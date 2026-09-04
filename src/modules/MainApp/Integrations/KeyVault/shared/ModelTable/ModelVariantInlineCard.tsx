import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import ModelIcon from "@src/components/ModelIcon";
import ModelPropertiesDropdown from "@src/components/ModelPropertiesDropdown";
import Tooltip from "@src/components/Tooltip";
import { ArrowDown01Icon, HugeiconsIcon } from "@src/icons";
import { INLINE_SPLIT_HEADER_ROW_CLASS } from "@src/modules/MainApp/Integrations/KeyVault/shared/InlineSplitRows";
import { InlineOptionCard } from "@src/modules/shared/layouts/blocks";
import type { ModelTableVariantInfo } from "@src/types/modelTable";
import { resolveDefaultVariant } from "@src/util/defaultModelVariant";
import { formatModelNameFull } from "@src/util/formatModelName";
import {
  MODEL_REASONING_LEVEL,
  type ModelReasoningLevel,
  formatReasoningLevel,
  formatVariantDisplayLabel,
  resolveModelVariantFields,
  toModelReasoningLevel,
} from "@src/util/modelVariants";
import { buildVariantEditOptions } from "@src/util/variantEditOptions";

import ModelTableTooltipContent from "./ModelTableTooltipContent";
import { MODEL_TABLE_INPUT_VALUE_INTERACTIVE_TOKEN } from "./config";

// ── Ordering ──────────────────────────────────────────────────────────────────

const REASONING_ORDER: ModelReasoningLevel[] = [
  MODEL_REASONING_LEVEL.NONE,
  MODEL_REASONING_LEVEL.LOW,
  MODEL_REASONING_LEVEL.MEDIUM,
  MODEL_REASONING_LEVEL.HIGH,
  MODEL_REASONING_LEVEL.EXTRA_HIGH,
  MODEL_REASONING_LEVEL.MAX,
  MODEL_REASONING_LEVEL.ULTRA,
  MODEL_REASONING_LEVEL.ULTRACODE,
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface EffortGroup {
  key: string;
  label: string;
  rank: number;
  variants: ModelTableVariantInfo[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getRawSuffixTokens(variant: ModelTableVariantInfo): string[] {
  const { model, base_model: base } = variant;
  if (!base) return [];
  const modelLower = model.toLowerCase();
  const baseLower = base.toLowerCase();
  if (!modelLower.startsWith(`${baseLower}-`)) return [];
  return model
    .slice(base.length + 1)
    .split("-")
    .filter(Boolean);
}

function getRawSuffix(variant: ModelTableVariantInfo): string | undefined {
  const tokens = getRawSuffixTokens(variant).filter(
    (token) => token !== "fast" && token !== "thinking"
  );
  if (tokens.length === 0) return undefined;
  return tokens.join("-");
}

function variantSortValue(variant: ModelTableVariantInfo): number {
  const reasoning = toModelReasoningLevel(variant.reasoning);
  if (!reasoning) return -1;
  return REASONING_ORDER.indexOf(reasoning);
}

function toTitleCaseSuffix(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

// ── GPT: group by reasoning level ─────────────────────────────────────────────

const BASE_EFFORT_LABEL = "Baseline";

function isUnsuffixedBaseVariant(variant: ModelTableVariantInfo): boolean {
  return variant.model.toLowerCase() === variant.base_model.toLowerCase();
}

function isBaseEffortVariant(variant: ModelTableVariantInfo): boolean {
  if (isUnsuffixedBaseVariant(variant)) return true;
  if (toModelReasoningLevel(variant.reasoning)) return false;

  const modelLower = variant.model.toLowerCase();
  const baseLower = variant.base_model.toLowerCase();
  return variant.fast && modelLower === `${baseLower}-fast`;
}

function getReasoningEffortMeta(
  variant: ModelTableVariantInfo
): Omit<EffortGroup, "variants"> {
  if (isBaseEffortVariant(variant)) {
    return { key: "base", label: BASE_EFFORT_LABEL, rank: -1 };
  }

  const reasoning = toModelReasoningLevel(variant.reasoning);
  if (reasoning === MODEL_REASONING_LEVEL.NONE) {
    return { key: MODEL_REASONING_LEVEL.NONE, label: "No reasoning", rank: 0 };
  }
  if (reasoning) {
    return {
      key: reasoning,
      label: formatReasoningLevel(reasoning),
      rank: REASONING_ORDER.indexOf(reasoning),
    };
  }
  const rawSuffix = getRawSuffix(variant);
  if (rawSuffix) {
    return { key: rawSuffix, label: toTitleCaseSuffix(rawSuffix), rank: 100 };
  }
  return { key: MODEL_REASONING_LEVEL.NONE, label: "No reasoning", rank: 0 };
}

// ── Build effort groups ───────────────────────────────────────────────────────

type EffortStyle = "reasoning" | "speed" | "models";

function getSpeedMeta(label: string): Omit<EffortGroup, "variants"> {
  return { key: "speed", label, rank: 0 };
}

function getModelsMeta(label: string): Omit<EffortGroup, "variants"> {
  return { key: "models", label, rank: 0 };
}

function groupVariantsByEffort(
  variants: ModelTableVariantInfo[],
  style: EffortStyle,
  speedLabel: string,
  modelsLabel: string
): EffortGroup[] {
  const getMeta =
    style === "speed"
      ? () => getSpeedMeta(speedLabel)
      : style === "models"
        ? () => getModelsMeta(modelsLabel)
        : getReasoningEffortMeta;
  const grouped = new Map<string, EffortGroup>();
  for (const variant of variants) {
    const meta = getMeta(variant);
    const existing = grouped.get(meta.key);
    if (existing) {
      existing.variants.push(variant);
      continue;
    }
    grouped.set(meta.key, { ...meta, variants: [variant] });
  }
  return Array.from(grouped.values()).sort((groupA, groupB) => {
    if (groupA.rank !== groupB.rank) return groupA.rank - groupB.rank;
    return groupA.label.localeCompare(groupB.label);
  });
}

function hasSuffixThinking(variant: ModelTableVariantInfo): boolean {
  return getRawSuffixTokens(variant).includes("thinking");
}

function isGptGroup(variants: ModelTableVariantInfo[]): boolean {
  return variants.some(
    (variant) =>
      variant.model.toLowerCase().startsWith("gpt-") ||
      variant.base_model.toLowerCase().startsWith("gpt-")
  );
}

function isOSeriesGroup(variants: ModelTableVariantInfo[]): boolean {
  return variants.some(
    (variant) => /^o\d/i.test(variant.model) || /^o\d/i.test(variant.base_model)
  );
}

function isSpeedOnlyGroup(variants: ModelTableVariantInfo[]): boolean {
  if (variants.length === 0) return false;
  if (isGptGroup(variants) || isOSeriesGroup(variants)) return false;
  return variants.every(isBaseEffortVariant);
}

function isComposerGroup(variants: ModelTableVariantInfo[]): boolean {
  return variants.some(
    (variant) =>
      variant.model.toLowerCase().startsWith("composer-") ||
      variant.base_model.toLowerCase().startsWith("composer-")
  );
}

function getPillLabel(
  variant: ModelTableVariantInfo,
  gptGroup: boolean,
  composerGroup: boolean,
  oSeriesGroup: boolean,
  isModelList: boolean
): string {
  if (isModelList) return formatModelNameFull(variant.model);
  if (gptGroup || composerGroup) return variant.fast ? "Fast" : "Standard";
  if (oSeriesGroup) {
    const rawSuffix = getRawSuffix(variant);
    if (rawSuffix) {
      const normalized = rawSuffix.toLowerCase();
      if (normalized === "mini" || normalized === "nano") {
        return toTitleCaseSuffix(rawSuffix);
      }
    }
    return variant.fast ? "Fast" : "Standard";
  }
  const thinking = hasSuffixThinking(variant);
  if (thinking && variant.fast) return "Thinking + Fast";
  if (thinking) return "Thinking";
  if (variant.fast) return "Fast";
  return "Standard";
}

/**
 * Sort key for pills within a row: Default | Thinking | Default fast | Thinking fast
 * Encodes (fast, thinking) as a 2-bit value so the canonical order is always preserved.
 */
function pillSortKey(variant: ModelTableVariantInfo): number {
  const fastBit = variant.fast ? 2 : 0;
  const thinkingBit = hasSuffixThinking(variant) ? 1 : 0;
  return fastBit + thinkingBit;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface ModelVariantInlineCardProps {
  variants: ModelTableVariantInfo[];
  forceModelList?: boolean;
  /** Skip InlineOptionCard wrapper when already inside an InlineInfoCard. */
  embedded?: boolean;
  /**
   * Persisted default variant per base model (`base_model` → variant `model`).
   * When provided alongside {@link onChangeDefaultVariant}, a "Selected
   * version" picker row is rendered above the variant pills.
   */
  defaultVariantByBaseModel?: Map<string, string>;
  /** Persist a new default variant for `baseModel`. */
  onChangeDefaultVariant?: (baseModel: string, model: string) => void;
  /**
   * Caller-controlled label for the "Selected version" row, keyed by base
   * model. Surface-specific (e.g. My Keys uses a generic literal, Wizard
   * interpolates the model name). Defaults to `"selected version"`.
   */
  defaultRowLabel?: (baseModel: string) => string;
}

export default function ModelVariantInlineCard({
  variants,
  forceModelList = false,
  embedded = false,
  defaultVariantByBaseModel,
  onChangeDefaultVariant,
  defaultRowLabel,
}: ModelVariantInlineCardProps) {
  const { t } = useTranslation("integrations");

  const sortedVariants = useMemo(
    () =>
      [...variants]
        .map((variant) => resolveModelVariantFields(variant.model, variant))
        .sort((variantA, variantB) => {
          const reasoningOrder =
            variantSortValue(variantA) - variantSortValue(variantB);
          if (reasoningOrder !== 0) return reasoningOrder;
          return pillSortKey(variantA) - pillSortKey(variantB);
        }),
    [variants]
  );

  const gptGroup = isGptGroup(sortedVariants);
  const oSeriesGroup = isOSeriesGroup(sortedVariants);
  const reasoningLevelGroup = gptGroup || oSeriesGroup;
  const composerGroup = isComposerGroup(sortedVariants);
  const speedOnlyGroup = isSpeedOnlyGroup(sortedVariants);
  const useSpeedEffort = composerGroup || speedOnlyGroup;
  const effortStyle: EffortStyle = forceModelList
    ? "models"
    : useSpeedEffort
      ? "speed"
      : "reasoning";

  const sectionTitle = forceModelList
    ? t("modelsTabs.models")
    : useSpeedEffort
      ? t("modelsTable.variantOptions")
      : reasoningLevelGroup
        ? t("modelsTable.reasoningLevel")
        : t("modelsTable.effort");

  // Pills in the embedded grid are selectable — clicking one persists the
  // tapped variant as the new default for the canonical base model.
  // `selectedModel` (when defined) highlights the active pill with the
  // primary-6 border + text treatment instead of the neutral border-2.
  const renderPills = (
    items: ModelTableVariantInfo[],
    selectedModel?: string,
    onPick?: (modelId: string) => void
  ) => (
    <div
      className={
        forceModelList
          ? "flex min-w-0 flex-col gap-0.5"
          : "flex min-w-0 flex-wrap justify-end gap-1.5"
      }
    >
      {items.map((variant) => {
        const pillText = getPillLabel(
          variant,
          gptGroup,
          composerGroup || speedOnlyGroup,
          oSeriesGroup,
          forceModelList
        );
        const pillContent = forceModelList ? (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <ModelIcon modelName={variant.model} size="small" />
            <span className="truncate">{pillText}</span>
          </span>
        ) : (
          pillText
        );

        const isSelected =
          selectedModel !== undefined && selectedModel === variant.model;
        const selectable = onPick !== undefined;
        const pillClass = `inline-flex h-[28px] max-w-full items-center gap-1.5 rounded-full border px-2.5 text-[12px] ${
          isSelected
            ? "border-primary-6 text-primary-6"
            : "border-border-2 text-text-2"
        }${selectable ? " cursor-pointer hover:bg-fill-2" : ""}`;

        const pill = selectable ? (
          <button
            type="button"
            onClick={() => onPick?.(variant.model)}
            className={pillClass}
            aria-pressed={isSelected}
          >
            {pillContent}
          </button>
        ) : (
          <span className={pillClass}>{pillContent}</span>
        );

        return (
          <div
            key={variant.model}
            className={forceModelList ? "min-w-0" : undefined}
          >
            <Tooltip
              content={<ModelTableTooltipContent model={variant.model} />}
              position="top"
            >
              {pill}
            </Tooltip>
          </div>
        );
      })}
    </div>
  );

  const renderEffortRows = (
    items: ModelTableVariantInfo[],
    selectedModel?: string,
    onPick?: (modelId: string) => void
  ) => {
    if (forceModelList) {
      return renderPills(items, selectedModel, onPick);
    }

    const effortGroups = groupVariantsByEffort(
      items,
      effortStyle,
      t("modelsTable.variantSpeed"),
      t("modelsTabs.models")
    );
    if (effortGroups.length === 0) {
      return <span className="text-text-3">—</span>;
    }
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        {effortGroups.map((group) => (
          <div
            key={group.key}
            className="flex h-9 min-h-9 min-w-0 items-center justify-between gap-3 text-xs"
          >
            <span className="shrink-0 font-medium text-text-1">
              {group.label}
            </span>
            {renderPills(
              [...group.variants].sort(
                (variantA, variantB) =>
                  pillSortKey(variantA) - pillSortKey(variantB)
              ),
              selectedModel,
              onPick
            )}
          </div>
        ))}
      </div>
    );
  };

  const showDefaultRow =
    !forceModelList &&
    onChangeDefaultVariant !== undefined &&
    sortedVariants.length > 0;

  // A ModelVariantInlineCard always renders variants for a single model
  // family (one group → one card), so the entire card collapses to a
  // single "Selected version" row. The dropdown enumerates every variant
  // in the family, including the unsuffixed / Baseline one. We pick the
  // shortest `base_model` string as the canonical key for persistence so
  // that "claude-opus-4-6" (unsuffixed fallback) and "claude-opus-4-6"
  // (parsed from "...-high") always resolve to the same entry.
  const canonicalBaseModel =
    sortedVariants.length > 0
      ? sortedVariants
          .map((variant) => variant.base_model)
          .reduce((shortest, candidate) =>
            candidate.length < shortest.length ? candidate : shortest
          )
      : undefined;

  const persistedSelected =
    canonicalBaseModel && sortedVariants.length > 0
      ? (resolveDefaultVariant(
          canonicalBaseModel,
          sortedVariants,
          defaultVariantByBaseModel?.get(canonicalBaseModel)
        ) ?? sortedVariants[0].model)
      : undefined;
  const handlePillPick =
    showDefaultRow && canonicalBaseModel
      ? (modelId: string) => {
          onChangeDefaultVariant?.(canonicalBaseModel, modelId);
        }
      : undefined;

  const variantContent = renderEffortRows(
    sortedVariants,
    persistedSelected,
    handlePillPick
  );

  const renderDefaultVariantRow = (options?: { withSeparator?: boolean }) => {
    if (!showDefaultRow) return null;
    if (!canonicalBaseModel || !persistedSelected) return null;

    const variantOptions = buildVariantEditOptions(
      sortedVariants.map((variant) => variant.model)
    );
    const triggerLabel =
      formatVariantDisplayLabel(persistedSelected) ??
      formatModelNameFull(persistedSelected);

    // Match `InlineSplitHeaderRow`'s separator: border-b sits inside the
    // same box-sizing as the 44px header row so the right pane's underline lines
    // up pixel-perfect with the left pane's header underline.
    const separatorClasses = options?.withSeparator
      ? "mb-1 rounded-none border-0 border-b border-border-2"
      : "";

    return (
      <div
        className={`${INLINE_SPLIT_HEADER_ROW_CLASS} min-w-0 ${separatorClasses}`}
      >
        <span className="shrink-0 text-xs font-medium text-primary-6">
          {defaultRowLabel
            ? defaultRowLabel(canonicalBaseModel)
            : t("modelsTable.selectedVersion")}
        </span>
        <ModelPropertiesDropdown
          variantOptions={variantOptions}
          value={persistedSelected}
          onChange={(modelId) =>
            onChangeDefaultVariant?.(canonicalBaseModel, modelId)
          }
          renderTrigger={({ ref, onClick, ariaExpanded }) => (
            <button
              ref={ref}
              type="button"
              onClick={onClick}
              aria-expanded={ariaExpanded}
              aria-label="Edit default variant"
              className={MODEL_TABLE_INPUT_VALUE_INTERACTIVE_TOKEN}
            >
              <span className="truncate">{triggerLabel}</span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                data-icon="chevron-down"
                size={12}
                className="text-text-3"
              />
            </button>
          )}
        />
      </div>
    );
  };

  const embeddedDefaultVariantRow = renderDefaultVariantRow({
    withSeparator: true,
  });

  if (embedded) {
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        {embeddedDefaultVariantRow}
        {variantContent}
      </div>
    );
  }

  const defaultVariantContent = renderDefaultVariantRow();

  const sections = [
    ...(defaultVariantContent
      ? [
          {
            key: "selected-version",
            title: t("modelsTable.selectedVersion"),
            content: defaultVariantContent,
            defaultOpen: true,
          },
        ]
      : []),
    {
      key: "effort",
      title: sectionTitle,
      content: variantContent,
      defaultOpen: true,
    },
  ];

  return <InlineOptionCard hideSectionTitles sections={sections} />;
}
