/**
 * Binds one `PokerTableController` to the React tree for as long as the
 * floating table is open. The controller is created on mount with the
 * persisted bankroll/settings, streams state through
 * `useSyncExternalStore`, mirrors bankroll changes back into the atom, and
 * cashes out (leave) on unmount — closing the window IS leaving the table.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  pokerBankrollAtom,
  pokerSettingsAtom,
  setPokerBankrollChipsAtom,
  stakesById,
} from "@src/store/ui/pokerTableAtom";

import {
  PokerTableController,
  type PokerTableViewState,
} from "./PokerTableController";
import type { PokerPlayer } from "./engine/types";

/** 100 big blinds at the table's stakes. */
export function defaultBuyIn(bigBlind: number): number {
  return bigBlind * 100;
}

export interface UsePokerTableController {
  controller: PokerTableController;
  state: PokerTableViewState;
}

export function usePokerTableController(
  hero: PokerPlayer
): UsePokerTableController {
  const bankroll = useAtomValue(pokerBankrollAtom);
  // jotai's setter identity is stable, so the controller can hold it.
  const setBankrollChips = useSetAtom(setPokerBankrollChipsAtom);
  const settings = useAtomValue(pokerSettingsAtom);

  // Created once per mount from the persisted values; the controller owns
  // bankroll and stakes after that (settings changes flow in via effects).
  const [controller] = useState(() => {
    const stakes = stakesById(settings.stakesId);
    return new PokerTableController({
      hero,
      blinds: { smallBlind: stakes.smallBlind, bigBlind: stakes.bigBlind },
      buyIn: defaultBuyIn(stakes.bigBlind),
      bankroll: bankroll.chips,
      speed: settings.speed,
      onBankrollChange: setBankrollChips,
    });
  });

  useEffect(() => {
    controller.start();
    return () => {
      controller.dispose();
    };
  }, [controller]);

  // Live settings changes (stakes / speed) flow into the running table.
  useEffect(() => {
    const stakes = stakesById(settings.stakesId);
    controller.setBlinds({
      smallBlind: stakes.smallBlind,
      bigBlind: stakes.bigBlind,
    });
    controller.setSpeed(settings.speed);
  }, [controller, settings.stakesId, settings.speed]);

  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState
  );

  return { controller, state };
}
