/**
 * Bottom strip of the table: bet sizing (pot-fraction presets + slider +
 * amount) and the Fold / Call / Bet buttons when it is the hero's turn;
 * otherwise a status line, the rebuy prompt, or "deal next hand".
 */
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Slider from "@src/components/Slider";

import type { PlayerAction, TableSnapshot } from "../engine/types";
import { formatChips } from "../format";

const POT_PRESETS = [0.25, 0.33, 0.75, 1.33] as const;

export interface PokerActionBarProps {
  snapshot: TableSnapshot;
  heroSeat: number;
  awaitingRebuy: boolean;
  bankroll: number;
  buyIn: number;
  onAct: (action: PlayerAction, amount?: number) => void;
  onRebuy: (amount: number) => void;
  onResetBankroll: () => void;
  onDealNext: () => void;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Every state of the bar keeps this height so the felt never jumps. */
const BAR_CLASS =
  "flex h-[92px] flex-col items-center justify-center gap-2 px-4";

const PokerActionBar: React.FC<PokerActionBarProps> = ({
  snapshot,
  heroSeat,
  awaitingRebuy,
  bankroll,
  buyIn,
  onAct,
  onRebuy,
  onResetBankroll,
  onDealNext,
}) => {
  const { t } = useTranslation("sessions");
  const heroToAct =
    snapshot.toAct === heroSeat && snapshot.legalActions !== null;
  const legal = heroToAct ? snapshot.legalActions : null;
  const range = legal?.chipRange ?? null;
  const hero = snapshot.seats[heroSeat];
  const aggressive: PlayerAction | null = legal?.actions.includes("raise")
    ? "raise"
    : legal?.actions.includes("bet")
      ? "bet"
      : null;
  const step = Math.max(1, Math.round(snapshot.blinds.bigBlind / 10));

  const [amount, setAmount] = useState<number>(range?.min ?? 0);
  // New decision → reset the sizing to the minimum legal bet.
  const decisionKey = `${snapshot.handNumber}:${snapshot.street}:${range?.min}:${range?.max}:${snapshot.potTotal}`;
  useEffect(() => {
    if (range) setAmount(range.min);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisionKey]);

  const presetAmount = (fraction: number): number => {
    if (!range || !hero) return 0;
    // Pot-fraction sizing after calling: (pot + call) × fraction, expressed
    // as a total street bet.
    const potAfterCall = snapshot.potTotal + snapshot.callAmount;
    const target = hero.betSize + snapshot.callAmount + potAfterCall * fraction;
    return clamp(Math.round(target / step) * step, range.min, range.max);
  };

  const activePreset = useMemo(
    () =>
      POT_PRESETS.find((fraction) => presetAmount(fraction) === amount) ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [amount, decisionKey]
  );

  const isAllIn = range !== null && amount >= range.max;

  if (awaitingRebuy) {
    const canBuy = bankroll > 0;
    const stake = Math.min(buyIn, bankroll);
    return (
      <div className={BAR_CLASS}>
        <span className="text-[12px] text-text-2">
          {t("pokerTable.rebuy.title")}
        </span>
        <div className="relative flex w-full items-center justify-center gap-2">
          {canBuy ? (
            <Button
              variant="primary"
              size="small"
              shape="round"
              onClick={() => onRebuy(stake)}
            >
              {t("pokerTable.rebuy.buyIn", { amount: formatChips(stake) })}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="small"
              shape="round"
              onClick={onResetBankroll}
            >
              {t("pokerTable.rebuy.reset")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (!heroToAct) {
    const actor =
      snapshot.toAct !== null ? snapshot.seats[snapshot.toAct] : null;
    return (
      <div className={BAR_CLASS}>
        {snapshot.phase === "hand-complete" ? (
          <Button
            variant="secondary"
            appearance="outline"
            size="small"
            shape="round"
            onClick={onDealNext}
          >
            {t("pokerTable.nextHand")}
          </Button>
        ) : actor ? (
          <span className="text-[12px] text-text-3">
            {t("pokerTable.waitingFor", { name: actor.player.name })}
          </span>
        ) : (
          <span className="text-[12px] text-text-3">
            {t("pokerTable.dealing")}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={BAR_CLASS} data-testid="poker-action-bar">
      {range && (
        <div className="flex w-full max-w-[560px] items-center gap-3 py-0.5">
          <div className="flex shrink-0 items-center gap-0.5">
            {POT_PRESETS.map((fraction) => (
              <button
                key={fraction}
                type="button"
                className={`rounded-full px-2 py-1 text-[11px] transition-colors ${
                  activePreset === fraction
                    ? "bg-fill-2 font-medium text-text-1"
                    : "text-text-3 hover:bg-fill-1 hover:text-text-1"
                }`}
                onClick={() => setAmount(presetAmount(fraction))}
              >
                {Math.round(fraction * 100)}%
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 items-center">
            <Slider
              className="w-full"
              noPadding
              min={range.min}
              max={range.max}
              step={step}
              value={amount}
              onChange={(value) =>
                setAmount(
                  clamp(
                    typeof value === "number" ? value : value[0],
                    range.min,
                    range.max
                  )
                )
              }
            />
          </div>
          <span className="shrink-0 whitespace-nowrap text-[12px] font-medium text-text-1">
            {t("pokerTable.tokens", { amount: formatChips(amount) })}
          </span>
        </div>
      )}
      <div className="relative flex w-full items-center justify-center gap-2">
        <Button
          variant="secondary"
          appearance="outline"
          size="small"
          shape="round"
          onClick={() => onAct("fold")}
        >
          {t("pokerTable.actions.fold")}
        </Button>
        {legal?.actions.includes("check") ? (
          <Button
            variant="secondary"
            appearance="outline"
            size="small"
            shape="round"
            onClick={() => onAct("check")}
          >
            {t("pokerTable.actions.check")}
          </Button>
        ) : (
          <Button
            variant="secondary"
            appearance="outline"
            size="small"
            shape="round"
            onClick={() => onAct("call")}
          >
            {t("pokerTable.actions.call", {
              amount: formatChips(snapshot.callAmount),
            })}
          </Button>
        )}
        {aggressive && range && (
          <Button
            variant="primary"
            size="small"
            shape="round"
            onClick={() => onAct(aggressive, amount)}
          >
            {isAllIn
              ? t("pokerTable.actions.allIn", { amount: formatChips(amount) })
              : aggressive === "bet"
                ? t("pokerTable.actions.bet", { amount: formatChips(amount) })
                : t("pokerTable.actions.raise", {
                    amount: formatChips(amount),
                  })}
          </Button>
        )}
      </div>
    </div>
  );
};

export default PokerActionBar;
