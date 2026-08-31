import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  type RoundSelection,
  resolveRoundSelectionIndex,
  selectLatestRound,
  selectNextRound,
  selectPreviousRound,
} from "@src/hooks/ui/roundSelection";

import type { TranscriptRoundSummary } from "../../lib/transcriptLoadState";

export interface RoundNavigatorProps {
  rounds: TranscriptRoundSummary[];
  roundsComplete: boolean;
  truncated: boolean;
  selectedRoundId: string | null;
  onSelectRound: (roundId: string | null) => void;
}

export function RoundNavigator({
  rounds,
  roundsComplete,
  truncated,
  selectedRoundId,
  onSelectRound,
}: RoundNavigatorProps) {
  const { t } = useTranslation("mobileRemote");
  const selection = useMemo<RoundSelection>(() => {
    if (selectedRoundId == null) return null;
    const index = rounds.findIndex((round) => round.id === selectedRoundId);
    return index >= 0 ? index : null;
  }, [rounds, selectedRoundId]);
  const currentIndex = resolveRoundSelectionIndex(selection, rounds.length);

  const dispatchSelection = useCallback(
    (next: RoundSelection) => {
      onSelectRound(next == null ? null : (rounds[next]?.id ?? null));
    },
    [onSelectRound, rounds]
  );

  if (rounds.length === 0) return null;

  return (
    <nav
      className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-2 bg-bg-1 px-3 py-2"
      aria-label={t("rounds.navigationLabel")}
    >
      <div className="min-w-0 text-xs text-text-3">
        <span className="font-medium text-text-2">
          {t("rounds.label", {
            current: currentIndex + 1,
            total: rounds.length,
          })}
        </span>
        {!roundsComplete ? (
          <span className="ml-2">{t("rounds.incomplete")}</span>
        ) : null}
        {truncated ? (
          <span className="ml-2">{t("rounds.truncated")}</span>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="small"
          variant="tertiary"
          appearance="ghost"
          disabled={currentIndex <= 0}
          onClick={() =>
            dispatchSelection(selectPreviousRound(selection, rounds.length))
          }
        >
          {t("rounds.previous")}
        </Button>
        <Button
          size="small"
          variant="tertiary"
          appearance="ghost"
          disabled={currentIndex >= rounds.length - 1}
          onClick={() =>
            dispatchSelection(selectNextRound(selection, rounds.length))
          }
        >
          {t("rounds.next")}
        </Button>
        <Button
          size="small"
          variant="tertiary"
          appearance="ghost"
          disabled={selection == null}
          onClick={() => dispatchSelection(selectLatestRound())}
        >
          {t("rounds.latest")}
        </Button>
      </div>
    </nav>
  );
}

RoundNavigator.displayName = "RoundNavigator";
