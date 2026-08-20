/**
 * A playing card: face-up (rank + suit pip, red/black) or face-down
 * (patterned back). Pure presentational; sizes are fixed steps so seats
 * and the board line up.
 */
import React from "react";

import type { Card } from "../engine/cards";

export type CardSize = "sm" | "md" | "lg";

const SIZE_CLASS: Record<CardSize, string> = {
  sm: "h-[34px] w-[24px] rounded-[4px] text-[11px]",
  md: "h-[52px] w-[38px] rounded-[6px] text-[15px]",
  lg: "h-[70px] w-[50px] rounded-[8px] text-[20px]",
};

const SUIT_GLYPH: Record<Card["suit"], string> = {
  clubs: "♣",
  diamonds: "♦",
  hearts: "♥",
  spades: "♠",
};

const RANK_LABEL: Record<Card["rank"], string> = {
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
  T: "10",
  J: "J",
  Q: "Q",
  K: "K",
  A: "A",
};

export interface PlayingCardProps {
  /** Face-up when given; face-down when omitted. */
  card?: Card | null;
  size?: CardSize;
  className?: string;
  /** Dimmed placeholder slot (undealt board card). */
  placeholder?: boolean;
}

const PlayingCard: React.FC<PlayingCardProps> = ({
  card,
  size = "md",
  className = "",
  placeholder = false,
}) => {
  const base = `${SIZE_CLASS[size]} relative shrink-0 select-none border ${className}`;
  if (placeholder) {
    return (
      <div
        aria-hidden
        className={`${base} border-dashed border-border-2 bg-transparent`}
      />
    );
  }
  if (!card) {
    return (
      <div
        aria-label="face-down card"
        className={`${base} flex items-center justify-center border-border-2 bg-bg-1 shadow-sm`}
      >
        <div className="flex h-[78%] w-[76%] items-center justify-center rounded-[3px] bg-fill-2 text-text-4">
          <span className="text-[0.9em] leading-none">♠</span>
        </div>
      </div>
    );
  }
  const red = card.suit === "hearts" || card.suit === "diamonds";
  const tone = red ? "text-danger-6" : "text-text-1";
  return (
    <div
      aria-label={`${RANK_LABEL[card.rank]} of ${card.suit}`}
      className={`${base} flex flex-col justify-between border-border-2 bg-white p-[3px] shadow-sm ${tone}`}
    >
      <span className="font-semibold leading-none">
        {RANK_LABEL[card.rank]}
      </span>
      <span className="self-end leading-none">{SUIT_GLYPH[card.suit]}</span>
    </div>
  );
};

export default PlayingCard;
