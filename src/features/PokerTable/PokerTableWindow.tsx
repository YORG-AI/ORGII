/**
 * PokerTableWindow — the floating poker table itself.
 *
 * Built on the same shell as the side chat: `FloatingWindow` (drag bounds +
 * resize handles) with a draggable header. Phase-0 scope: the human vs.
 * five bots at play-chip "token" stakes; nothing here touches any account
 * — see `src/store/ui/pokerTableAtom.ts` for the ledger boundary.
 *
 * Loaded lazily by `./index.tsx` the first time the table is opened, so the
 * engine, bots and `pokersolver` stay out of the main bundle. Closing the
 * window is leaving the table: the hero's stack returns to the persisted
 * bankroll and the table is discarded (see the controller).
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import FloatingWindow from "@src/components/FloatingWindow";
import {
  POKER_DEFAULT_BANKROLL_CHIPS,
  closePokerTableAtom,
  pokerSettingsAtom,
  stakesById,
} from "@src/store/ui/pokerTableAtom";
import { userAtom } from "@src/store/user/userAtom";

import PokerActionBar from "./components/PokerActionBar";
import PokerFelt from "./components/PokerFelt";
import PokerHandHistory from "./components/PokerHandHistory";
import PokerTableHeader from "./components/PokerTableHeader";
import type { PlayerAction, PokerPlayer } from "./engine/types";
import {
  defaultBuyIn,
  usePokerTableController,
} from "./usePokerTableController";

// Same bounds as the side chat (whole pane surface minus a 12px inset),
// centred rather than bottom-right: the table wants room. z-[70] matches
// the side chat; the two are siblings and either can be dragged aside.
const POKER_OVERLAY_CLASS =
  "pointer-events-none absolute inset-0 z-[70] flex items-center justify-center p-3";
const POKER_SURFACE_CLASS =
  "pointer-events-auto flex h-full max-h-[620px] min-h-[440px] w-[820px] max-w-full flex-col overflow-hidden rounded-[12px] border border-border-2 bg-bg-2 shadow-2xl";
const POKER_MIN_WIDTH = 600;
const POKER_MIN_HEIGHT = 440;
const POKER_MAX_WIDTH = 1200;
const POKER_MAX_HEIGHT = 820;

const PokerTableWindow: React.FC = () => {
  const { t } = useTranslation("sessions");
  const closePokerTable = useSetAtom(closePokerTableAtom);
  const [settings, setSettings] = useAtom(pokerSettingsAtom);
  const user = useAtomValue(userAtom);
  const [historyOpen, setHistoryOpen] = useState(false);

  const hero = useMemo<PokerPlayer>(
    () => ({
      id: `user:${user.uuid || "local"}`,
      name: user.name?.trim() || t("pokerTable.seat.you"),
      kind: "human",
      avatarHue: 212,
    }),
    // The hero identity is fixed for the life of the table.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const { controller, state } = usePokerTableController(hero);
  const stakes = stakesById(settings.stakesId);
  const buyIn = defaultBuyIn(stakes.bigBlind);

  const handleAct = useCallback(
    (action: PlayerAction, amount?: number) =>
      controller.heroAct(action, amount),
    [controller]
  );
  const handleRebuy = useCallback(
    (amount: number) => controller.rebuy(amount),
    [controller]
  );
  const handleResetBankroll = useCallback(() => {
    controller.resetBankroll(POKER_DEFAULT_BANKROLL_CHIPS);
    controller.rebuy(buyIn);
  }, [buyIn, controller]);
  const handleDealNext = useCallback(
    () => controller.dealNextHand(),
    [controller]
  );
  const handleLeave = useCallback(() => {
    // Leaving cashes out through the controller's dispose (unmount).
    closePokerTable();
  }, [closePokerTable]);

  return (
    <FloatingWindow
      overlayClassName={POKER_OVERLAY_CLASS}
      surfaceClassName={POKER_SURFACE_CLASS}
      minWidth={POKER_MIN_WIDTH}
      minHeight={POKER_MIN_HEIGHT}
      maxWidth={POKER_MAX_WIDTH}
      maxHeight={POKER_MAX_HEIGHT}
    >
      <PokerTableHeader
        blinds={state.snapshot.blinds}
        handNumber={state.snapshot.handNumber}
        settings={settings}
        historyOpen={historyOpen}
        onToggleHistory={() => setHistoryOpen((open) => !open)}
        onChangeStakes={(stakesId) =>
          setSettings((prev) => ({ ...prev, stakesId }))
        }
        onChangeSpeed={(speed) => setSettings((prev) => ({ ...prev, speed }))}
        onLeave={handleLeave}
        onClose={handleLeave}
      />
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <PokerFelt
              snapshot={state.snapshot}
              heroSeat={state.heroSeat}
              revealedCommunity={state.revealedCommunity}
              thinkingSince={state.thinkingSince}
            />
          </div>
          <div className="shrink-0 border-t border-border-2">
            <PokerActionBar
              snapshot={state.snapshot}
              heroSeat={state.heroSeat}
              awaitingRebuy={state.awaitingRebuy}
              bankroll={state.bankroll}
              buyIn={buyIn}
              onAct={handleAct}
              onRebuy={handleRebuy}
              onResetBankroll={handleResetBankroll}
              onDealNext={handleDealNext}
            />
          </div>
        </div>
        {historyOpen && (
          <aside className="flex w-[240px] shrink-0 flex-col border-l border-border-2 bg-bg-2">
            <div className="flex h-8 shrink-0 items-center px-3 text-[12px] font-medium text-text-2">
              {t("pokerTable.history.title")}
            </div>
            <div className="min-h-0 flex-1">
              <PokerHandHistory entries={state.handHistory} />
            </div>
          </aside>
        )}
      </div>
    </FloatingWindow>
  );
};

export default PokerTableWindow;
