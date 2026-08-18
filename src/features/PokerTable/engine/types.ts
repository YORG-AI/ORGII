/**
 * Read-only projection of a poker table for the UI and the bots.
 *
 * Amounts are in CHIPS. One chip is `TOKENS_PER_CHIP` play tokens — the
 * rules engine only handles integers, and 1K-token chips keep 0.5/1 Mtok
 * blinds and 100M-token stacks comfortably inside safe-integer range while
 * still letting the UI print `561K` / `1.28M`.
 */
import type { Card } from "./cards";

export const TOKENS_PER_CHIP = 1_000;

export type Street = "preflop" | "flop" | "turn" | "river";

export type PlayerAction = "fold" | "check" | "call" | "bet" | "raise";

export interface ChipRange {
  min: number;
  max: number;
}

export interface LegalActions {
  actions: PlayerAction[];
  /** Present when `bet` or `raise` is legal — total bet size ("bet to"). */
  chipRange?: ChipRange;
}

export type PlayerKind = "human" | "bot";

export interface PokerPlayer {
  id: string;
  name: string;
  kind: PlayerKind;
  /** Hue (0–360) for the generated avatar. */
  avatarHue: number;
  /** Persona id for bots (drives the brain); undefined for the human. */
  personaId?: string;
}

export interface SeatAction {
  action: PlayerAction;
  /** Total bet this street after the action, for bet/raise/call. */
  amount?: number;
}

export interface SeatSnapshot {
  seatIndex: number;
  player: PokerPlayer;
  /** Chips behind (not counting the current street's bet). */
  stack: number;
  /** Chips committed on the current street. */
  betSize: number;
  /** Still contesting the pot this hand. */
  inHand: boolean;
  /** Has hole cards this hand (face-down unless `holeCards` is set). */
  hasCards: boolean;
  /**
   * Visible hole cards: the viewer's own cards, or everyone's revealed
   * cards at showdown. `null` while face-down / not dealt.
   */
  holeCards: Card[] | null;
  isDealer: boolean;
  isToAct: boolean;
  isAllIn: boolean;
  /** Last action taken on the current street (cleared at street change). */
  lastAction: SeatAction | null;
}

export interface PotSnapshot {
  size: number;
  eligibleSeats: number[];
}

export interface HandResultEntry {
  seatIndex: number;
  /** Net chips won from the pot(s) (0 for showdown losers). */
  amountWon: number;
  /** Description of the shown hand, e.g. `"Two Pair, K's & 2's"`. */
  handDescription: string | null;
  /** Hole cards revealed at showdown; null when the hand was folded out. */
  revealedCards: Card[] | null;
}

export interface HandResult {
  handNumber: number;
  entries: HandResultEntry[];
  /** True when the pot was awarded without a showdown. */
  foldedOut: boolean;
  /** Community cards as they were when the hand ended. */
  board: Card[];
  /** Chips in play when the hand ended (what the winners split). */
  potTotal: number;
}

export type TablePhase =
  /** No hand running (between hands, before first hand). */
  | "idle"
  /** Waiting for the seat in `toAct` to act. */
  | "betting"
  /** Betting round closed; next street being dealt. */
  | "dealing"
  /** Hand over, result on the table. */
  | "hand-complete";

export interface Blinds {
  smallBlind: number;
  bigBlind: number;
}

export interface TableSnapshot {
  handNumber: number;
  phase: TablePhase;
  street: Street | null;
  blinds: Blinds;
  communityCards: Card[];
  pots: PotSnapshot[];
  /** Collected pots plus every live bet — what the UI shows as "Pot". */
  potTotal: number;
  seats: (SeatSnapshot | null)[];
  dealerSeat: number | null;
  toAct: number | null;
  /** Legal actions for `toAct`; null when nobody is to act. */
  legalActions: LegalActions | null;
  /** Chips `toAct` must add to call (0 when checking is possible). */
  callAmount: number;
  lastResult: HandResult | null;
}
