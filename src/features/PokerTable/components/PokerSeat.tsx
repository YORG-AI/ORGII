/**
 * One seat around the felt: avatar pill (name + stack), the seat's hole
 * cards above it, dealer button, current-street bet pill toward the pot,
 * and the "Thinking · Ns" indicator under the acting seat.
 */
import { Bot } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import type { SeatSnapshot } from "../engine/types";
import { formatChips } from "../format";
import PlayingCard from "./PlayingCard";
import ThinkingIndicator from "./ThinkingIndicator";

export interface PokerSeatProps {
  seat: SeatSnapshot;
  isHero: boolean;
  /** Won chips in the last result (highlight + amount). */
  wonAmount?: number;
  handDescription?: string | null;
  thinkingSince: number | null;
  /** Unit vector from this seat toward the table centre (for the bet pill). */
  towardCenter: { x: number; y: number };
}

function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0].toUpperCase() : "?";
}

const PokerSeat: React.FC<PokerSeatProps> = ({
  seat,
  isHero,
  wonAmount = 0,
  handDescription,
  thinkingSince,
  towardCenter,
}) => {
  const { t } = useTranslation("sessions");
  const folded =
    seat.lastAction?.action === "fold" || (!seat.inHand && seat.hasCards);
  const dim = folded ? "opacity-50" : "";
  const ring = seat.isToAct
    ? "ring-2 ring-primary-6"
    : wonAmount > 0
      ? "ring-2 ring-success-6"
      : "";
  const showFaceUp = seat.holeCards && seat.holeCards.length > 0;
  const showFaceDown = !showFaceUp && seat.hasCards;
  const cardSize = isHero ? "lg" : "sm";
  // Bet pill sits just outside the seat block on the pot side. The hero's
  // block is much taller (large face-up cards above the pill), so its pill
  // goes clear above the cards rather than the generic 62px nudge, which
  // would land on them.
  const betPillOffset = isHero
    ? { left: "50%", top: "calc(50% - 88px)" }
    : {
        left: `calc(50% + ${towardCenter.x * 78}px)`,
        top: `calc(50% + ${towardCenter.y * 62}px)`,
      };

  return (
    <div className="relative flex flex-col items-center">
      {/* Hole cards */}
      <div
        // Bots' small cards tuck under their pill; the hero's stay fully
        // visible above theirs.
        className={`flex ${isHero ? "mb-1.5 gap-1.5" : "mb-[-10px] gap-0"} ${dim}`}
        style={{ minHeight: isHero ? 70 : 34 }}
      >
        {showFaceUp &&
          seat.holeCards!.map((card, index) => (
            <PlayingCard
              key={`${card.rank}${card.suit}`}
              card={card}
              size={cardSize}
              className={
                index === 1 && !isHero
                  ? "-ml-2 rotate-6"
                  : !isHero
                    ? "-rotate-6"
                    : ""
              }
            />
          ))}
        {showFaceDown && (
          <>
            <PlayingCard size={cardSize} className="-rotate-6" />
            <PlayingCard size={cardSize} className="-ml-2 rotate-6" />
          </>
        )}
      </div>

      {/* Seat pill */}
      <div
        className={`relative z-10 flex items-center gap-2 rounded-full border border-border-2 bg-bg-1 py-1 pl-1 pr-3 shadow-sm ${ring} ${dim}`}
        data-testid={`poker-seat-${seat.seatIndex}`}
      >
        <span
          aria-hidden
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-white"
          style={{
            background: `hsl(${seat.player.avatarHue} 55% 48%)`,
          }}
        >
          {initialOf(seat.player.name)}
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="flex items-center gap-1 whitespace-nowrap text-[12px] font-medium text-text-1">
            <span>{seat.player.name}</span>
            {seat.player.kind === "bot" && (
              <Bot
                size={12}
                strokeWidth={1.8}
                className="shrink-0 text-text-3"
                aria-label={t("pokerTable.seat.bot")}
              />
            )}
          </span>
          <span className="whitespace-nowrap text-[11px] text-text-3">
            {seat.isAllIn
              ? t("pokerTable.seat.allIn")
              : t("pokerTable.tokens", { amount: formatChips(seat.stack) })}
          </span>
        </span>
        {seat.isDealer && (
          <span
            aria-label="dealer"
            className="absolute -right-2 -top-1 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-text-1 text-[10px] font-bold text-bg-1 shadow"
          >
            D
          </span>
        )}
      </div>

      {/* Bet pill (toward the pot) */}
      {seat.betSize > 0 && (
        <span
          className="absolute z-20 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-border-2 bg-bg-1 px-2 py-0.5 text-[11px] text-text-2 shadow-sm"
          style={betPillOffset}
        >
          <span className="text-text-3">
            {seat.lastAction?.action === "call"
              ? t("pokerTable.actions.callLabel")
              : seat.lastAction?.action === "raise"
                ? t("pokerTable.actions.raiseLabel")
                : t("pokerTable.actions.betLabel")}
          </span>{" "}
          <span className="font-medium text-text-1">
            {formatChips(seat.betSize)}
          </span>
        </span>
      )}
      {seat.betSize === 0 &&
        seat.lastAction?.action === "check" &&
        seat.inHand && (
          <span
            className="absolute z-20 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-fill-2 px-2 py-0.5 text-[10px] text-text-3"
            style={betPillOffset}
          >
            {t("pokerTable.actions.checkLabel")}
          </span>
        )}

      {/* Result / thinking line */}
      <div className="mt-1 flex h-4 items-center justify-center">
        {wonAmount > 0 ? (
          <span className="whitespace-nowrap text-[11px] font-medium text-success-6">
            +{formatChips(wonAmount)}
            {handDescription ? ` · ${handDescription}` : ""}
          </span>
        ) : seat.isToAct && thinkingSince !== null ? (
          <ThinkingIndicator since={thinkingSince} />
        ) : null}
      </div>
    </div>
  );
};

export default PokerSeat;
