/**
 * Floating poker table ("Tables") — visibility plus the little that must
 * survive a reload: the play-chip bankroll and the table settings.
 *
 * Phase-0 scope: human vs. bots, play chips only. Chips are NOT tokens from
 * any account and cannot be bought, transferred or cashed out — the atoms
 * here are the only ledger, and a "reset bankroll" is always free. Keep it
 * that way: purchase or transfer paths are what turn a game into gambling.
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod/v4";

import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

// ─── Visibility (session-only, like the side chat) ─────────────────────────

export const pokerTableVisibleAtom = atom<boolean>(false);
pokerTableVisibleAtom.debugLabel = "pokerTable/visible";

export const openPokerTableAtom = atom(null, (_get, set) => {
  set(pokerTableVisibleAtom, true);
});
openPokerTableAtom.debugLabel = "pokerTable/open";

export const closePokerTableAtom = atom(null, (_get, set) => {
  set(pokerTableVisibleAtom, false);
});
closePokerTableAtom.debugLabel = "pokerTable/close";

// ─── Bankroll (chips; 1 chip = 1,000 play tokens) ───────────────────────────

/** 500M play tokens — five 100-BB buy-ins at the default 0.5/1 Mtok stakes. */
export const POKER_DEFAULT_BANKROLL_CHIPS = 500_000;

export const POKER_BANKROLL_STORAGE_KEY = "orgii:pokerTable:bankroll:v1";

const StoredBankrollSchema = z.object({
  chips: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type StoredPokerBankroll = z.infer<typeof StoredBankrollSchema>;

export const pokerBankrollAtom = atomWithStorage<StoredPokerBankroll>(
  POKER_BANKROLL_STORAGE_KEY,
  { chips: POKER_DEFAULT_BANKROLL_CHIPS, updatedAt: 0 },
  createZodJsonStorage(StoredBankrollSchema, {
    onInvalid: (key, _rawValue, error) => {
      console.warn(`[pokerTable] invalid stored bankroll for ${key}`, error);
    },
  }),
  { getOnInit: true }
);
pokerBankrollAtom.debugLabel = "pokerTable/bankroll";

/** Write the chip count with a fresh timestamp (the controller's callback). */
export const setPokerBankrollChipsAtom = atom(
  null,
  (_get, set, chips: number) => {
    set(pokerBankrollAtom, {
      chips: Math.max(0, Math.round(chips)),
      updatedAt: Date.now(),
    });
  }
);
setPokerBankrollChipsAtom.debugLabel = "pokerTable/setBankrollChips";

// ─── Settings ───────────────────────────────────────────────────────────────

export const POKER_SETTINGS_STORAGE_KEY = "orgii:pokerTable:settings:v1";

/** Stakes offered in the header dropdown, in chips (0.5/1 Mtok = 500/1000). */
export const POKER_STAKES_OPTIONS = [
  { id: "0.1/0.2", smallBlind: 100, bigBlind: 200 },
  { id: "0.5/1", smallBlind: 500, bigBlind: 1000 },
  { id: "2/4", smallBlind: 2000, bigBlind: 4000 },
] as const;
export type PokerStakesId = (typeof POKER_STAKES_OPTIONS)[number]["id"];

const StoredSettingsSchema = z.object({
  stakesId: z.enum(
    POKER_STAKES_OPTIONS.map((option) => option.id) as [
      PokerStakesId,
      ...PokerStakesId[],
    ]
  ),
  speed: z.enum(["normal", "fast"]),
});
export type StoredPokerSettings = z.infer<typeof StoredSettingsSchema>;

export const POKER_DEFAULT_SETTINGS: StoredPokerSettings = {
  stakesId: "0.5/1",
  speed: "normal",
};

export const pokerSettingsAtom = atomWithStorage<StoredPokerSettings>(
  POKER_SETTINGS_STORAGE_KEY,
  POKER_DEFAULT_SETTINGS,
  createZodJsonStorage(StoredSettingsSchema, {
    onInvalid: (key, _rawValue, error) => {
      console.warn(`[pokerTable] invalid stored settings for ${key}`, error);
    },
  }),
  { getOnInit: true }
);
pokerSettingsAtom.debugLabel = "pokerTable/settings";

export function stakesById(stakesId: PokerStakesId) {
  return (
    POKER_STAKES_OPTIONS.find((option) => option.id === stakesId) ??
    POKER_STAKES_OPTIONS[1]
  );
}
