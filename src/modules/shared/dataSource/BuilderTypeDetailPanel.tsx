import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import {
  SECTION_GAP_CLASSES,
  SECTION_SUBHEADING_CLASSES,
} from "@src/modules/shared/layouts/SectionLayout";

import BuilderTypeAvatar from "./BuilderTypeAvatar";
import type { BuilderTypeDefinition, BuilderTypeLetter } from "./builderTypes";

const FAMILY_BADGE_CLASS: Record<BuilderTypeDefinition["family"], string> = {
  MD: "bg-primary-1 text-primary-6",
  MA: "bg-purple-1 text-purple-6",
  ED: "bg-warning-1 text-warning-6",
  EA: "bg-success-1 text-success-6",
};

const removeTerminalPeriod = (text: string) => text.replace(/[.。]\s*$/, "");

function PreferenceCard({ letter }: { letter: BuilderTypeLetter }) {
  const { t } = useTranslation("builderProfile");

  return (
    <div className="rounded-lg bg-bg-2 p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono text-sm font-semibold text-text-1">
          {letter}
        </span>
        <span className="text-sm font-medium text-text-1">
          {t(`types.letters.${letter}.name`)}
        </span>
      </div>
      <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-text-3">
        <li>
          {removeTerminalPeriod(t(`types.letters.${letter}.description`))}
        </li>
        <li>{removeTerminalPeriod(t(`types.letters.${letter}.agentTip`))}</li>
      </ul>
    </div>
  );
}

export interface BuilderTypeDetailContentProps {
  type: BuilderTypeDefinition;
  eager?: boolean;
  muted?: boolean;
  codeTestId?: string;
}

export function BuilderTypeDetailContent({
  type,
  eager,
  muted,
  codeTestId,
}: BuilderTypeDetailContentProps) {
  const { t } = useTranslation("builderProfile");

  return (
    <section
      className="rounded-xl border border-border-1 bg-primary-container p-4"
      aria-labelledby="builder-type-detail-title"
      data-testid="builder-type-detail"
    >
      <div className="flex flex-col gap-5 @[600px]:flex-row">
        <BuilderTypeAvatar
          type={type}
          eager={eager}
          className={`w-full rounded-xl @[600px]:h-64 @[600px]:w-64 ${
            muted ? "opacity-60 grayscale" : ""
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span
                  className="font-mono text-3xl text-text-1"
                  data-testid={codeTestId}
                >
                  {type.code}
                </span>
                <span
                  className={`rounded-full px-2 py-1 text-xs font-medium ${
                    FAMILY_BADGE_CLASS[type.family]
                  }`}
                >
                  {t("types.family", {
                    first: t(`types.letters.${type.letters[0]}.name`),
                    second: t(`types.letters.${type.letters[1]}.name`),
                  })}
                </span>
              </div>
              <h3
                id="builder-type-detail-title"
                className="text-xl font-semibold text-text-1"
              >
                {type.name}
              </h3>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 @[480px]:grid-cols-2">
            {type.letters.map((letter) => (
              <PreferenceCard key={letter} letter={letter} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export interface BuilderTypeDetailPanelProps {
  type: BuilderTypeDefinition;
  onBack: () => void;
}

export default function BuilderTypeDetailPanel({
  type,
  onBack,
}: BuilderTypeDetailPanelProps) {
  const { t } = useTranslation(["builderProfile", "common"]);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="builder-type-detail-panel"
    >
      <div
        className={`${DETAIL_PANEL_TOKENS.headerWidth} flex min-h-10 shrink-0 items-center gap-2 px-4 pt-2`}
      >
        <Button
          variant="tertiary"
          size="small"
          onClick={onBack}
          data-testid="builder-type-detail-back"
          icon={<ArrowLeft className="h-3.5 w-3.5" />}
        >
          {t("common:actions.back")}
        </Button>
        <h2 className={SECTION_SUBHEADING_CLASSES}>
          {type.code} · {type.name}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 scrollbar-hide @container">
        <div
          className={`${DETAIL_PANEL_TOKENS.headerWidth} ${SECTION_GAP_CLASSES} pb-[50vh] pt-2`}
        >
          <BuilderTypeDetailContent type={type} eager />
        </div>
      </div>
    </div>
  );
}
