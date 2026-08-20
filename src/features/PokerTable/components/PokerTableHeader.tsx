/**
 * Draggable window header for the table, in the shared floating-window
 * chrome (`HEADER_CLASSES.pageHeader` + `useWindowDrag`, like
 * `DetailPanelHeader`) but with the table's own left slot — a stakes
 * dropdown as the title — and right slot: hand number, history, settings,
 * "Leave table", close.
 */
import { History, SlidersHorizontal, X } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { useWindowDrag } from "@src/components/FloatingWindow/useWindowDrag";
import Select, { type SelectOption } from "@src/components/Select";
import {
  HEADER_CLASSES,
  HEADER_ICON_SIZE,
} from "@src/config/workstation/tokens";
import {
  POKER_STAKES_OPTIONS,
  type PokerStakesId,
  type StoredPokerSettings,
} from "@src/store/ui/pokerTableAtom";

import type { Blinds } from "../engine/types";
import { formatStakes } from "../format";

export interface PokerTableHeaderProps {
  blinds: Blinds;
  handNumber: number;
  settings: StoredPokerSettings;
  historyOpen: boolean;
  onToggleHistory: () => void;
  onChangeStakes: (stakesId: PokerStakesId) => void;
  onChangeSpeed: (speed: StoredPokerSettings["speed"]) => void;
  onLeave: () => void;
  onClose: () => void;
}

const PokerTableHeader: React.FC<PokerTableHeaderProps> = ({
  blinds,
  handNumber,
  settings,
  historyOpen,
  onToggleHistory,
  onChangeStakes,
  onChangeSpeed,
  onLeave,
  onClose,
}) => {
  const { t } = useTranslation("sessions");
  const onPointerDown = useWindowDrag(true);
  const stakesLabel = formatStakes(blinds.smallBlind, blinds.bigBlind);
  const stakesOptions: SelectOption[] = POKER_STAKES_OPTIONS.map((option) => {
    const label = t("pokerTable.header.title", {
      stakes: formatStakes(option.smallBlind, option.bigBlind),
    });

    return {
      value: option.id,
      label,
      // A stakes change is queued until the next hand. Keep the trigger on
      // the live blinds while the selected menu option reflects the pending
      // setting.
      triggerLabel:
        option.id === settings.stakesId
          ? t("pokerTable.header.title", { stakes: stakesLabel })
          : label,
    };
  });
  const speedOptions: SelectOption[] = (["normal", "fast"] as const).map(
    (speed) => ({
      value: speed,
      label: t(`pokerTable.settings.speed_${speed}`),
    })
  );

  return (
    <div
      className={`${HEADER_CLASSES.pageHeader} cursor-grab select-none !border-b-0`}
      onPointerDown={onPointerDown}
    >
      <div className="flex min-w-0 flex-1 items-center">
        <div className="min-w-0" data-no-window-drag>
          <Select
            value={settings.stakesId}
            options={stakesOptions}
            placeholder={t("pokerTable.settings.stakes")}
            onChange={(value) => {
              if (Array.isArray(value)) return;
              onChangeStakes(String(value) as PokerStakesId);
            }}
            size="mini"
            appearance="ghost"
            dropdownAlign="left"
            dropdownWidthMode="auto"
            className="w-auto max-w-full"
            selectorClassName="!font-medium"
            ariaLabel={t("pokerTable.settings.stakes")}
            dataTestId="poker-stakes-select"
          />
        </div>
      </div>

      <div className="flex flex-shrink-0 items-center gap-1.5">
        {handNumber > 0 && (
          <span className="whitespace-nowrap text-[12px] text-text-3">
            {t("pokerTable.header.hand", { number: handNumber })}
          </span>
        )}
        <div data-no-window-drag>
          <Select
            value={settings.speed}
            options={speedOptions}
            placeholder={t("pokerTable.settings.speed")}
            onChange={(value) => {
              if (Array.isArray(value)) return;
              onChangeSpeed(value as StoredPokerSettings["speed"]);
            }}
            prefix={<SlidersHorizontal size={HEADER_ICON_SIZE.sm} />}
            size="mini"
            appearance="ghost"
            dropdownAlign="right"
            dropdownWidthMode="min-match"
            className="w-auto"
            ariaLabel={t("pokerTable.settings.speed")}
            dataTestId="poker-speed-select"
          />
        </div>
        <Button
          htmlType="button"
          variant="secondary"
          appearance="outline"
          size="mini"
          shape="round"
          onClick={onLeave}
        >
          {t("pokerTable.header.leave")}
        </Button>
        <span aria-hidden className="h-4 w-px flex-shrink-0 bg-border-2" />
        <Button
          htmlType="button"
          variant="tertiary"
          size="mini"
          iconOnly
          icon={<History size={HEADER_ICON_SIZE.sm} />}
          className={historyOpen ? "bg-fill-2 text-text-1" : ""}
          onClick={onToggleHistory}
          title={t("pokerTable.header.history")}
          aria-label={t("pokerTable.header.history")}
          aria-pressed={historyOpen}
        />
        <Button
          htmlType="button"
          variant="tertiary"
          size="mini"
          iconOnly
          icon={<X size={HEADER_ICON_SIZE.sm} />}
          onClick={onClose}
          title={t("pokerTable.header.close")}
          aria-label={t("pokerTable.header.close")}
        />
      </div>
    </div>
  );
};

export default PokerTableHeader;
