import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import BottomSheet from "@src/components/BottomSheet";
import {
  TurnNavigationRoundList,
  TurnNavigationToolbar,
  formatTranscriptRoundTimeLabel,
  getTurnNavigationLabel,
} from "@src/components/TurnNavigationToolbar";
import { getRoundPreviewText } from "@src/engines/ChatPanel/ChatHistory/utils/turnPageFormatting";
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
  const { t } = useTranslation(["common", "mobileRemote"]);
  const [listOpen, setListOpen] = useState(false);
  const [sortAscending, setSortAscending] = useState(false);
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

  const roundItems = useMemo(() => {
    const items = rounds.map((round, pageIndex) => ({
      id: round.id,
      pageIndex,
      label:
        getRoundPreviewText(round.userPreview) ||
        t("common:pagination.round", { current: pageIndex + 1 }),
      timeLabel: formatTranscriptRoundTimeLabel(round),
    }));
    return sortAscending ? items : [...items].reverse();
  }, [rounds, sortAscending, t]);

  const statusAnnotation = [
    !roundsComplete ? t("mobileRemote:rounds.incomplete") : null,
    truncated ? t("mobileRemote:rounds.truncated") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (rounds.length === 0) return null;

  return (
    <>
      <TurnNavigationToolbar
        variant="mobile"
        ready
        listOpen={listOpen}
        onToggleList={() => setListOpen((open) => !open)}
        sortAscending={sortAscending}
        onToggleSort={() => setSortAscending((ascending) => !ascending)}
        onCloseList={() => setListOpen(false)}
        currentLabel={getTurnNavigationLabel({
          ready: true,
          currentIndex,
          pageCount: rounds.length,
          t,
        })}
        currentTimeLabel={formatTranscriptRoundTimeLabel(
          rounds[currentIndex] ?? {}
        )}
        currentIndex={currentIndex}
        pageCount={rounds.length}
        onPrevious={() =>
          dispatchSelection(selectPreviousRound(selection, rounds.length))
        }
        onNext={() =>
          dispatchSelection(selectNextRound(selection, rounds.length))
        }
        onLatest={() => dispatchSelection(selectLatestRound())}
        ariaLabel={t("mobileRemote:rounds.navigationLabel")}
        statusAnnotation={statusAnnotation || undefined}
      />
      <BottomSheet
        open={listOpen}
        onClose={() => setListOpen(false)}
        title={t("common:pagination.latestRound")}
        showCloseButton
        closeLabel={t("common:actions.close")}
      >
        <TurnNavigationRoundList
          items={roundItems}
          currentPageIndex={currentIndex}
          onSelect={(pageIndex) => {
            dispatchSelection(
              pageIndex >= rounds.length - 1 ? null : pageIndex
            );
            setListOpen(false);
          }}
        />
      </BottomSheet>
    </>
  );
}

RoundNavigator.displayName = "RoundNavigator";
