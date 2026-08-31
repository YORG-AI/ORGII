import { useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { ArrowLeft02Icon, HugeiconsIcon } from "@src/icons";
import {
  SECTION_GAP_CLASSES,
  SECTION_SUBHEADING_CLASSES,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  PANEL_HEADER_TOKENS,
  STAT_GRID_TOKENS,
} from "@src/modules/shared/layouts/blocks";

import BuilderTypeAvatar from "./BuilderTypeAvatar";
import BuilderTypeDetailModal from "./BuilderTypeDetailPanel";
import {
  BUILDER_TYPES,
  type BuilderTypeDefinition,
  type BuilderTypeLetter,
} from "./builderTypes";

const AXIS_PAIRS: readonly (readonly [BuilderTypeLetter, BuilderTypeLetter])[] =
  [
    ["M", "E"],
    ["D", "A"],
    ["F", "W"],
    ["S", "H"],
  ];

function BuilderTypeCard({
  type,
  onOpen,
}: {
  type: BuilderTypeDefinition;
  onOpen: () => void;
}) {
  const { t } = useTranslation("builderProfile");
  const preferenceNames = type.letters.map((letter) =>
    t(`types.letters.${letter}.name`)
  );

  return (
    <button
      type="button"
      className="group flex min-h-56 flex-col items-start rounded-lg border border-border-2 bg-bg-2 p-3 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-primary-6"
      onClick={onOpen}
      aria-label={`${type.code} ${type.name}`}
      data-testid={`builder-type-card-${type.code}`}
    >
      <BuilderTypeAvatar
        type={type}
        className="mx-auto h-32 w-32 shrink-0 transition-transform group-hover:scale-[1.02]"
      />
      <div className="mt-2 w-full min-w-0">
        <div className="font-mono text-sm font-semibold text-text-1">
          {type.code}
        </div>
        <div className="mt-0.5 text-[13px] font-medium text-text-1">
          {type.name}
        </div>
        <div className="mt-1.5 text-xs leading-relaxed text-text-3">
          <div>
            {preferenceNames[0]} · {preferenceNames[1]}
          </div>
          <div>
            {preferenceNames[2]} · {preferenceNames[3]}
          </div>
        </div>
      </div>
    </button>
  );
}

export interface BuilderTypesPanelProps {
  onBack: () => void;
}

export default function BuilderTypesPanel({ onBack }: BuilderTypesPanelProps) {
  const { t } = useTranslation(["builderProfile", "common"]);
  const [selectedType, setSelectedType] = useState<BuilderTypeDefinition>();

  const navigateType = (offset: number) => {
    setSelectedType((current) => {
      if (!current) return current;
      const currentIndex = BUILDER_TYPES.findIndex(
        (type) => type.code === current.code
      );
      const nextIndex =
        (currentIndex + offset + BUILDER_TYPES.length) % BUILDER_TYPES.length;
      return BUILDER_TYPES[nextIndex];
    });
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="builder-types-panel"
    >
      <div
        className={`${DETAIL_PANEL_TOKENS.headerWidth} flex min-h-10 shrink-0 items-center gap-2 px-4 pt-2`}
      >
        <Button
          {...PANEL_HEADER_TOKENS.actionButton}
          onClick={onBack}
          data-testid="builder-types-back"
          icon={
            <HugeiconsIcon
              icon={ArrowLeft02Icon}
              data-icon="arrow-left"
              size={PANEL_HEADER_TOKENS.buttonIconSize}
              strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
            />
          }
          title={t("common:actions.back")}
          aria-label={t("common:actions.back")}
        />
        <h2 className={SECTION_SUBHEADING_CLASSES}>{t("types.title")}</h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 scrollbar-hide @container">
        <div
          className={`${DETAIL_PANEL_TOKENS.headerWidth} ${SECTION_GAP_CLASSES} pb-[50vh] pt-2`}
        >
          <section aria-labelledby="builder-types-gallery-title">
            <h2
              id="builder-types-gallery-title"
              className={SECTION_SUBHEADING_CLASSES}
            >
              {t("types.galleryTitle")}
            </h2>
            <p className="mb-3 text-sm text-text-3">{t("types.galleryHint")}</p>
            <div
              className={STAT_GRID_TOKENS.cols4}
              data-testid="builder-types-gallery"
            >
              {BUILDER_TYPES.map((type) => (
                <BuilderTypeCard
                  key={type.code}
                  type={type}
                  onOpen={() => setSelectedType(type)}
                />
              ))}
            </div>
          </section>

          <section aria-labelledby="builder-types-how-title">
            <h2
              id="builder-types-how-title"
              className={SECTION_SUBHEADING_CLASSES}
            >
              {t("types.howTitle")}
            </h2>
            <p className="mb-3 text-sm leading-relaxed text-text-3">
              {t("types.howBody")}
            </p>
            <div className={STAT_GRID_TOKENS.cols4}>
              {AXIS_PAIRS.map(([left, right]) => (
                <div
                  key={`${left}${right}`}
                  className="rounded-xl border border-border-1 bg-primary-container p-3"
                >
                  <div className="mb-1 font-mono text-sm font-semibold text-text-1">
                    {left} / {right}
                  </div>
                  <div className="text-xs text-text-3">
                    {t(`types.letters.${left}.name`)} ·{" "}
                    {t(`types.letters.${right}.name`)}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {selectedType && (
        <BuilderTypeDetailModal
          type={selectedType}
          onClose={() => setSelectedType(undefined)}
          onPrevious={() => navigateType(-1)}
          onNext={() => navigateType(1)}
        />
      )}
    </div>
  );
}
