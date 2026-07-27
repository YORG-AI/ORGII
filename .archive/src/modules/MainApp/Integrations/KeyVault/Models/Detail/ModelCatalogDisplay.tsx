/**
 * Model-catalog-specific display components.
 *
 * Used by model inline cards to show pricing, specs, and capabilities
 * for models that exist in the catalog.
 */
import {
  File,
  FileAudio2,
  Image,
  type LucideIcon,
  Type,
  Video,
} from "lucide-react";
import React from "react";

import {
  CollapsibleSection,
  DETAIL_PANEL_TOKENS,
} from "@src/modules/shared/layouts/blocks";
import type {
  CatalogModel,
  InputModality,
  OutputModality,
} from "@src/types/model/catalog";

// ── Formatting helpers ──

export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = Number((tokens / 1_000_000).toFixed(1));
    return `${millions}M`;
  }
  return `${(tokens / 1_000).toFixed(0)}K`;
}

export function formatPrice(price: number, t: (key: string) => string): string {
  if (price === 0) return t("models.free");
  if (price < 0.01) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(2)}`;
}

// ── Shared constants ──

export const MODALITY_ICON_MAP: Record<
  InputModality | OutputModality,
  LucideIcon
> = {
  text: Type,
  image: Image,
  audio: FileAudio2,
  video: Video,
  file: File,
};

// ── Spec card ──

interface SpecCardProps {
  label: string;
  value: string;
  valueClassName?: string;
}

export const SpecCard: React.FC<SpecCardProps> = ({
  label,
  value,
  valueClassName = "text-primary-6",
}) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="text-[12px] text-text-3">{label}</span>
    <span className={`text-[12px] font-semibold ${valueClassName}`}>
      {value}
    </span>
  </div>
);

// ── Modality badges ──

export const ModalityBadges: React.FC<{
  modalities: (InputModality | OutputModality)[];
  tMarket: (key: string) => string;
}> = ({ modalities, tMarket }) => (
  <div className="flex flex-wrap gap-1">
    {modalities.map((mod) => {
      const ModalityIcon = MODALITY_ICON_MAP[mod];
      return (
        <span
          key={mod}
          className="inline-flex items-center gap-1 rounded bg-fill-3 px-1.5 py-0.5 text-[12px] capitalize text-text-2"
        >
          <ModalityIcon size={10} strokeWidth={2} />
          {tMarket(`models.modalityLabels.${mod}`)}
        </span>
      );
    })}
  </div>
);

// ── Reasoning label ──

export function getReasoningLabel(
  reasoning: CatalogModel["reasoning"],
  tMarket: (key: string) => string
): string {
  if (reasoning === "none") return tMarket("models.reasoningOpts.noReasoning");
  if (reasoning === "toggleable")
    return tMarket("models.reasoningOpts.toggleableReasoning");
  return tMarket("models.reasoningOpts.alwaysOnReasoning");
}

// ── Composite sections ──

export const SpecsGrid: React.FC<{
  model: CatalogModel;
  tMarket: (key: string) => string;
}> = ({ model, tMarket }) => (
  <div className={DETAIL_PANEL_TOKENS.contentStack}>
    <SpecCard
      label={tMarket("models.inputPrice")}
      value={`${formatPrice(model.pricing.inputPerMillion, tMarket)}/M`}
    />
    <SpecCard
      label={tMarket("models.outputPrice")}
      value={`${formatPrice(model.pricing.outputPerMillion, tMarket)}/M`}
    />
    <SpecCard
      label={tMarket("models.context")}
      value={formatContext(model.contextLength)}
      valueClassName="text-text-1"
    />
    <SpecCard
      label={tMarket("models.maxOutput")}
      value={formatContext(model.maxOutput)}
      valueClassName="text-text-1"
    />
  </div>
);

export const CapabilitiesSection: React.FC<{
  model: CatalogModel;
  tMarket: (key: string) => string;
}> = ({ model, tMarket }) => (
  <div className="flex flex-col gap-3">
    <div className="flex items-center gap-2">
      <span className="text-[12px] text-text-3">
        {tMarket("models.inputModalities")}:
      </span>
      <ModalityBadges modalities={model.inputModalities} tMarket={tMarket} />
    </div>
    <div className="flex items-center gap-2">
      <span className="text-[12px] text-text-3">
        {tMarket("models.outputModalities")}:
      </span>
      <ModalityBadges modalities={model.outputModalities} tMarket={tMarket} />
    </div>
    <div className="flex items-center gap-2">
      <span className="text-[12px] text-text-3">
        {tMarket("models.reasoning")}:
      </span>
      <span className="text-[12px] text-text-1">
        {getReasoningLabel(model.reasoning, tMarket)}
      </span>
    </div>
  </div>
);

export const CatalogDetailContent: React.FC<{
  model: CatalogModel;
  tMarket: (key: string) => string;
}> = ({ model, tMarket }) => (
  <div className="flex flex-col">
    {model.description.trim() !== "" && (
      <p className="mb-3 text-xs leading-5 text-text-2">{model.description}</p>
    )}
    <SpecsGrid model={model} tMarket={tMarket} />
    <div className="my-3 border-t border-border-2" />
    <CapabilitiesSection model={model} tMarket={tMarket} />
  </div>
);

export const CatalogDetailSection: React.FC<{
  model: CatalogModel;
  t: (key: string, defaultValue?: string) => string;
  tMarket: (key: string) => string;
}> = ({ model, t, tMarket }) => (
  <CollapsibleSection title={t("modelPreview.modelProperties")}>
    <div className="flex flex-col rounded-lg bg-fill-2 p-4">
      <CatalogDetailContent model={model} tMarket={tMarket} />
    </div>
  </CollapsibleSection>
);
