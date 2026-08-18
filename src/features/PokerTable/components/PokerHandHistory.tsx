/**
 * Slide-over list of recent hands: number, pot, winner(s) and the hero's
 * net for the hand. Read-only; the controller keeps the last 40.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import type { HandHistoryEntry } from "../PokerTableController";
import { formatChips } from "../format";

export interface PokerHandHistoryProps {
  entries: HandHistoryEntry[];
}

const PokerHandHistory: React.FC<PokerHandHistoryProps> = ({ entries }) => {
  const { t } = useTranslation("sessions");
  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-[12px] text-text-3">
        {t("pokerTable.history.empty")}
      </div>
    );
  }
  return (
    <ul className="flex h-full flex-col gap-1 overflow-y-auto px-2 py-2">
      {entries.map((entry) => {
        const net = entry.heroNet;
        const netTone =
          net > 0
            ? "text-success-6"
            : net < 0
              ? "text-danger-6"
              : "text-text-3";
        return (
          <li
            key={entry.handNumber}
            className="flex flex-col gap-0.5 rounded-[8px] border border-border-2 bg-bg-1 px-2.5 py-1.5"
          >
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-text-3">
                {t("pokerTable.header.hand", { number: entry.handNumber })}
              </span>
              <span className={`font-medium ${netTone}`}>
                {net === 0
                  ? "0"
                  : `${net > 0 ? "+" : "−"}${formatChips(Math.abs(net))}`}
              </span>
            </div>
            <div className="text-[12px] text-text-1">
              {entry.winners
                .map((winner) =>
                  winner.handDescription
                    ? t("pokerTable.result.winsWith", {
                        name: winner.name,
                        amount: formatChips(winner.amount),
                        hand: winner.handDescription,
                      })
                    : t("pokerTable.result.wins", {
                        name: winner.name,
                        amount: formatChips(winner.amount),
                      })
                )
                .join(" · ")}
              {entry.foldedOut && (
                <span className="text-text-3">
                  {" "}
                  · {t("pokerTable.history.foldedOut")}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
};

export default PokerHandHistory;
