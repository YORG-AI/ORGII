import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { ArrowLeft01Icon, ArrowRight01Icon, HugeiconsIcon } from "@src/icons";
import { PANEL_HEADER_TOKENS } from "@src/modules/shared/layouts/blocks";
import Modal from "@src/scaffold/ModalSystem";

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
          className={`w-full rounded-xl @[600px]:h-72 @[600px]:w-72 ${
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

export interface BuilderTypeDetailModalProps {
  type: BuilderTypeDefinition;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

export default function BuilderTypeDetailModal({
  type,
  onClose,
  onPrevious,
  onNext,
}: BuilderTypeDetailModalProps) {
  const { t } = useTranslation(["builderProfile", "common"]);

  return (
    <Modal
      visible
      title={`${type.code} · ${type.name}`}
      width={960}
      onCancel={onClose}
      bodyClassName="p-3 @container"
    >
      <div
        className="flex items-center gap-2"
        data-testid="builder-type-detail-modal"
      >
        <Button
          {...PANEL_HEADER_TOKENS.actionButton}
          onClick={onPrevious}
          data-testid="builder-type-previous"
          icon={
            <HugeiconsIcon
              icon={ArrowLeft01Icon}
              data-icon="chevron-left"
              size={PANEL_HEADER_TOKENS.buttonIconSize}
              strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
            />
          }
          title={t("common:actions.previous")}
          aria-label={t("common:actions.previous")}
        />
        <div className="min-w-0 flex-1">
          <BuilderTypeDetailContent type={type} eager />
        </div>
        <Button
          {...PANEL_HEADER_TOKENS.actionButton}
          onClick={onNext}
          data-testid="builder-type-next"
          icon={
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              data-icon="chevron-right"
              size={PANEL_HEADER_TOKENS.buttonIconSize}
              strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
            />
          }
          title={t("common:actions.next")}
          aria-label={t("common:actions.next")}
        />
      </div>
    </Modal>
  );
}
