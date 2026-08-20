/**
 * The felt: an oval table with six seat slots around it, the community
 * cards and pot in the middle, and the hand result line. The hero always
 * sits bottom-centre; other seats rotate around them.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import type { TableSnapshot } from "../engine/types";
import { formatChips } from "../format";
import PlayingCard from "./PlayingCard";
import PokerSeat from "./PokerSeat";

/** Seat slot positions in % of the felt box; slot 0 is the hero. */
const SLOTS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 50, y: 80 },
  { x: 14, y: 62 },
  { x: 21, y: 24 },
  { x: 50, y: 11 },
  { x: 79, y: 24 },
  { x: 86, y: 62 },
];

const CENTER = { x: 50, y: 47 };

function towardCenter(slot: { x: number; y: number }): {
  x: number;
  y: number;
} {
  const dx = CENTER.x - slot.x;
  const dy = CENTER.y - slot.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

export interface PokerFeltProps {
  snapshot: TableSnapshot;
  heroSeat: number;
  revealedCommunity: number;
  thinkingSince: number | null;
}

const PokerFelt: React.FC<PokerFeltProps> = ({
  snapshot,
  heroSeat,
  revealedCommunity,
  thinkingSince,
}) => {
  const { t } = useTranslation("sessions");
  const seatCount = snapshot.seats.length;
  const result =
    snapshot.phase === "hand-complete" ? snapshot.lastResult : null;
  const wonBySeat = new Map<number, number>();
  const descriptionBySeat = new Map<number, string | null>();
  result?.entries.forEach((entry) => {
    wonBySeat.set(entry.seatIndex, entry.amountWon);
    descriptionBySeat.set(entry.seatIndex, entry.handDescription);
  });
  const winners = result
    ? result.entries
        .filter((entry) => entry.amountWon > 0)
        .map((entry) => ({
          name: snapshot.seats[entry.seatIndex]?.player.name ?? "",
          amount: entry.amountWon,
          description: entry.handDescription,
        }))
    : [];

  const board = snapshot.communityCards;
  const visibleBoard =
    snapshot.phase === "hand-complete"
      ? board.length
      : Math.min(revealedCommunity, board.length);

  return (
    <div
      className="relative h-full min-h-[300px] w-full"
      data-testid="poker-felt"
    >
      {/* Felt: rounded rectangle with a large radius (stadium ends), like the mock */}
      <div
        aria-hidden
        className="absolute bottom-[17%] left-[9%] right-[9%] top-[14%] rounded-[200px] border border-border-1 bg-fill-1"
      />

      {/* Centre: pot + board + result */}
      <div
        className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2"
        style={{ left: `${CENTER.x}%`, top: `${CENTER.y}%` }}
      >
        <span className="rounded-full border border-border-2 bg-bg-1 px-2.5 py-0.5 text-[11px] text-text-2 shadow-sm">
          <span className="text-text-3">{t("pokerTable.potLabel")}</span>{" "}
          <span className="font-medium text-text-1">
            {t("pokerTable.tokens", { amount: formatChips(snapshot.potTotal) })}
          </span>
        </span>
        <div className="flex gap-1.5">
          {Array.from({ length: 5 }, (_, index) => {
            const card = index < visibleBoard ? board[index] : null;
            return card ? (
              <PlayingCard
                key={`${card.rank}${card.suit}`}
                card={card}
                size="md"
              />
            ) : (
              // Undealt slot: a face-down card, like the mock (dimmed so
              // the dealt board reads first).
              <PlayingCard
                key={`slot-${index}`}
                size="md"
                className="opacity-60"
              />
            );
          })}
        </div>
        <div className="flex h-5 items-center">
          {winners.length > 0 && (
            <span className="whitespace-nowrap rounded-full bg-success-1 px-2.5 py-0.5 text-[11px] font-medium text-success-6">
              {winners
                .map((winner) =>
                  winner.description
                    ? t("pokerTable.result.winsWith", {
                        name: winner.name,
                        amount: formatChips(winner.amount),
                        hand: winner.description,
                      })
                    : t("pokerTable.result.wins", {
                        name: winner.name,
                        amount: formatChips(winner.amount),
                      })
                )
                .join(" · ")}
            </span>
          )}
        </div>
      </div>

      {/* Seats */}
      {snapshot.seats.map((seat, index) => {
        if (!seat) return null;
        const slot =
          SLOTS[(index - heroSeat + seatCount) % seatCount] ?? SLOTS[0];
        return (
          <div
            key={seat.player.id}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${slot.x}%`, top: `${slot.y}%` }}
          >
            <PokerSeat
              seat={seat}
              isHero={index === heroSeat}
              wonAmount={wonBySeat.get(index) ?? 0}
              handDescription={descriptionBySeat.get(index) ?? null}
              thinkingSince={thinkingSince}
              towardCenter={towardCenter(slot)}
            />
          </div>
        );
      })}
    </div>
  );
};

export default PokerFelt;
