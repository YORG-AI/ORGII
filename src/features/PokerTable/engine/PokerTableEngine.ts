/**
 * PokerTableEngine — a table across hands.
 *
 * `HoldemHand` owns the rules of one hand; this class owns what persists
 * between hands: who sits where with how many chips, the button rotation,
 * hand numbering, stakes, per-street "last action" pills, and the
 * immutable `TableSnapshot` projection with per-viewer card visibility.
 *
 * It does NOT own timing — the controller decides when bots act, when a
 * street is dealt and when the next hand starts, so tests can drive hands
 * synchronously.
 */
import type { Card, Rng } from "./cards";
import { HoldemHand } from "./holdemHand";
import type {
  Blinds,
  HandResult,
  HandResultEntry,
  LegalActions,
  PlayerAction,
  PokerPlayer,
  PotSnapshot,
  SeatAction,
  SeatSnapshot,
  Street,
  TablePhase,
  TableSnapshot,
} from "./types";

export const DEFAULT_SEAT_COUNT = 6;

interface SeatState {
  player: PokerPlayer;
  /** Chips behind between hands (authoritative while no hand runs). */
  stack: number;
  /**
   * Lost the last chip at showdown. The seat is kept so the UI can show
   * "0 tokens" and offer a rebuy; `startHand()` drops busted seats that
   * were not re-bought.
   */
  busted: boolean;
  lastAction: SeatAction | null;
}

export interface PokerTableEngineOptions {
  seatCount?: number;
  /** Deck RNG (defaults to the platform CSPRNG). */
  rng?: Rng;
}

export class PokerTableEngine {
  private readonly seatCount: number;
  private readonly seats: (SeatState | null)[];
  private readonly rng?: Rng;
  private blinds: Blinds;
  private handNumber = 0;
  private hand: HoldemHand | null = null;
  private handInProgress = false;
  private lastResult: HandResult | null = null;
  private lastStreet: Street | null = null;

  constructor(blinds: Blinds, options: PokerTableEngineOptions = {}) {
    this.blinds = blinds;
    this.seatCount = options.seatCount ?? DEFAULT_SEAT_COUNT;
    this.rng = options.rng;
    this.seats = Array.from({ length: this.seatCount }, () => null);
  }

  // ─── Seating ────────────────────────────────────────────────────────────

  sitDown(seatIndex: number, player: PokerPlayer, buyIn: number): void {
    this.assertSeatIndex(seatIndex);
    if (this.seats[seatIndex]) {
      throw new Error(`Seat ${seatIndex} is occupied`);
    }
    if (buyIn <= 0) throw new Error("Buy-in must be positive");
    this.seats[seatIndex] = {
      player,
      stack: Math.round(buyIn),
      busted: false,
      lastAction: null,
    };
  }

  /** Put chips back in front of a busted player. Legal between hands only. */
  rebuy(seatIndex: number, buyIn: number): void {
    const seat = this.seats[seatIndex];
    if (!seat) throw new Error(`Seat ${seatIndex} is empty`);
    if (!seat.busted) throw new Error(`Seat ${seatIndex} is not busted`);
    if (this.handInProgress) throw new Error("Cannot rebuy during a hand");
    if (buyIn <= 0) throw new Error("Buy-in must be positive");
    seat.stack += Math.round(buyIn);
    seat.busted = false;
  }

  /**
   * Remove a player and return their stack. Legal between hands, or during
   * a hand for a seat that is not dealt in (a busted seat waiting on a
   * rebuy). Contenders cannot leave mid-hand — the table is abandoned as
   * a whole instead (see the controller's `leave()`).
   */
  standUp(seatIndex: number): number {
    const seat = this.seats[seatIndex];
    if (!seat) return 0;
    if (this.handInProgress && this.hand?.seat(seatIndex)) {
      throw new Error("Cannot stand up during a hand");
    }
    this.seats[seatIndex] = null;
    return seat.stack;
  }

  isSeated(seatIndex: number): boolean {
    return this.seats[seatIndex] !== null;
  }

  isBusted(seatIndex: number): boolean {
    return this.seats[seatIndex]?.busted ?? false;
  }

  /** Chips behind right now (live stack during a hand). */
  stackOf(seatIndex: number): number {
    if (this.handInProgress) {
      const live = this.hand?.seat(seatIndex);
      if (live) return live.stack;
    }
    return this.seats[seatIndex]?.stack ?? 0;
  }

  seatedCount(): number {
    return this.seats.filter(Boolean).length;
  }

  seatIndexOf(playerId: string): number | null {
    const index = this.seats.findIndex((seat) => seat?.player.id === playerId);
    return index >= 0 ? index : null;
  }

  playerAt(seatIndex: number): PokerPlayer | null {
    return this.seats[seatIndex]?.player ?? null;
  }

  getBlinds(): Blinds {
    return this.blinds;
  }

  /** Change stakes between hands. */
  setBlinds(blinds: Blinds): void {
    if (this.handInProgress) {
      throw new Error("Cannot change blinds during a hand");
    }
    this.blinds = blinds;
  }

  // ─── Hand lifecycle ─────────────────────────────────────────────────────

  isHandInProgress(): boolean {
    return this.handInProgress;
  }

  isBettingRoundInProgress(): boolean {
    return (
      this.handInProgress && (this.hand?.isBettingRoundInProgress() ?? false)
    );
  }

  areBettingRoundsCompleted(): boolean {
    return (
      this.handInProgress && (this.hand?.areBettingRoundsCompleted() ?? false)
    );
  }

  currentHandNumber(): number {
    return this.handNumber;
  }

  /** Deal a new hand. Requires ≥2 seated players with chips. */
  startHand(): void {
    if (this.handInProgress) throw new Error("Hand already in progress");
    // Busted seats that were not re-bought leave the table now.
    this.seats.forEach((seat, index) => {
      if (seat && (seat.busted || seat.stack <= 0)) this.seats[index] = null;
    });
    const dealtIn = this.seats
      .map((seat, index) => (seat ? index : -1))
      .filter((index) => index >= 0);
    if (dealtIn.length < 2) {
      throw new Error("Need at least two players to start a hand");
    }
    const previousButton = this.hand?.buttonSeat ?? null;
    const buttonSeat =
      previousButton === null
        ? dealtIn[0]
        : (dealtIn.find((seat) => seat > previousButton) ?? dealtIn[0]);

    this.handNumber += 1;
    this.lastResult = null;
    this.hand = new HoldemHand({
      seats: dealtIn.map((seatIndex) => ({
        seatIndex,
        stack: this.seats[seatIndex]!.stack,
      })),
      buttonSeat,
      smallBlind: this.blinds.smallBlind,
      bigBlind: this.blinds.bigBlind,
      rng: this.rng,
    });
    this.handInProgress = true;
    this.lastStreet = "preflop";
    this.seats.forEach((seat) => {
      if (seat) seat.lastAction = null;
    });
  }

  /** Seat index whose turn it is, or null when no betting round is open. */
  playerToAct(): number | null {
    return this.isBettingRoundInProgress()
      ? (this.hand?.playerToAct() ?? null)
      : null;
  }

  legalActions(): LegalActions | null {
    if (!this.isBettingRoundInProgress()) return null;
    return this.hand?.legalActions() ?? null;
  }

  /** Chips the player to act must add to call. */
  callAmount(): number {
    if (!this.isBettingRoundInProgress()) return 0;
    return this.hand?.callAmount() ?? 0;
  }

  /**
   * Apply an action for the seat to act. `amount` is the TOTAL bet size on
   * this street for bet/raise ("raise to").
   */
  act(action: PlayerAction, amount?: number): void {
    const hand = this.hand;
    const toAct = this.playerToAct();
    if (!hand || toAct === null) {
      throw new Error("No betting round in progress");
    }
    const seat = this.seats[toAct];
    if (!seat) throw new Error(`No player at seat ${toAct}`);
    hand.act(action, amount);
    const after = hand.seat(toAct);
    switch (action) {
      case "fold":
      case "check":
        seat.lastAction = { action };
        break;
      default:
        seat.lastAction = { action, amount: after?.bet ?? 0 };
    }
  }

  /**
   * Close the current betting round: deal the next street, or the whole
   * run-out when nobody can act anymore (the controller reveals it
   * progressively).
   */
  endBettingRound(): void {
    if (!this.hand || !this.handInProgress) {
      throw new Error("No hand in progress");
    }
    this.hand.endBettingRound();
    this.seats.forEach((seat) => {
      if (seat) seat.lastAction = null;
    });
    this.lastStreet = this.hand.street();
  }

  /**
   * Resolve the hand: pay the pot(s), reveal cards, produce `HandResult`.
   * Legal once `areBettingRoundsCompleted()`.
   */
  showdown(): HandResult {
    const hand = this.hand;
    if (!hand || !this.areBettingRoundsCompleted()) {
      throw new Error("Betting rounds not completed");
    }
    const contenders = hand.contenders();
    const foldedOut = contenders.length <= 1;
    const board = hand.communityCards();
    const potTotal = hand.potTotal();
    const payouts = new Map(
      hand.showdown().map((payout) => [payout.seatIndex, payout.amount])
    );

    const entries: HandResultEntry[] = [];
    for (const state of hand.seatStates()) {
      const seat = this.seats[state.seatIndex];
      if (!seat) continue;
      const revealed = !foldedOut && !state.folded;
      entries.push({
        seatIndex: state.seatIndex,
        amountWon: payouts.get(state.seatIndex) ?? 0,
        handDescription: revealed ? hand.describe(state.seatIndex) : null,
        revealedCards: revealed ? state.holeCards.slice() : null,
      });
      // Sync stacks back to the table; a zero stack is a bust.
      seat.stack = state.stack;
      seat.busted = state.stack === 0;
    }
    this.handInProgress = false;
    this.lastResult = {
      handNumber: this.handNumber,
      entries,
      foldedOut,
      board,
      potTotal,
    };
    return this.lastResult;
  }

  // ─── Projection ─────────────────────────────────────────────────────────

  /**
   * Snapshot for the given viewer. The viewer sees their own hole cards;
   * everyone else's are face-down until the showdown result reveals them.
   */
  snapshot(viewerSeat: number | null): TableSnapshot {
    const inProgress = this.handInProgress;
    const hand = this.hand;
    const result = inProgress ? null : this.lastResult;
    const toAct = this.playerToAct();
    const dealerSeat = hand?.buttonSeat ?? null;
    const community = inProgress
      ? (hand?.communityCards() ?? [])
      : (result?.board.slice() ?? []);
    const pots: PotSnapshot[] =
      inProgress && hand
        ? hand.pots().map((pot) => ({
            size: pot.size,
            eligibleSeats: pot.eligibleSeats.slice(),
          }))
        : [];
    const potTotal = inProgress
      ? (hand?.potTotal() ?? 0)
      : (result?.potTotal ?? 0);

    const seats: (SeatSnapshot | null)[] = this.seats.map((seat, index) => {
      if (!seat) return null;
      const live = hand?.seat(index) ?? null;
      const contesting = live !== null && !live.folded;
      const stack = inProgress && live ? live.stack : seat.stack;
      const betSize = inProgress && live ? live.bet : 0;

      // Visibility: own cards while dealt in (and after the hand, so the
      // result view keeps them); everyone else's only via the showdown.
      let visibleHole: Card[] | null = null;
      if (result) {
        const entry = result.entries.find((e) => e.seatIndex === index);
        if (entry?.revealedCards) visibleHole = entry.revealedCards.slice();
        else if (viewerSeat === index && live) visibleHole = live.holeCards;
      } else if (inProgress && viewerSeat === index && contesting && live) {
        visibleHole = live.holeCards;
      }

      return {
        seatIndex: index,
        player: seat.player,
        stack,
        betSize,
        inHand: inProgress && contesting,
        hasCards: inProgress && contesting,
        holeCards: visibleHole,
        isDealer: dealerSeat === index,
        isToAct: toAct === index,
        isAllIn: inProgress && contesting && stack === 0,
        lastAction: seat.lastAction,
      };
    });

    let phase: TablePhase = "idle";
    if (inProgress) {
      phase = this.isBettingRoundInProgress() ? "betting" : "dealing";
    } else if (result) {
      phase = "hand-complete";
    }

    return {
      handNumber: this.handNumber,
      phase,
      street: inProgress ? (hand?.street() ?? null) : this.lastStreet,
      blinds: this.blinds,
      communityCards: community,
      pots,
      potTotal,
      seats,
      dealerSeat,
      toAct,
      legalActions: this.legalActions(),
      callAmount: this.callAmount(),
      lastResult: this.lastResult,
    };
  }

  /** Hole cards of a seat in the current (or just finished) hand. */
  holeCardsOf(seatIndex: number): Card[] | null {
    return this.hand?.seat(seatIndex)?.holeCards ?? null;
  }

  communityCards(): Card[] {
    return this.handInProgress ? (this.hand?.communityCards() ?? []) : [];
  }

  /** Seats still contesting the pot (dealt in, not folded). */
  contendingSeats(): number[] {
    return this.handInProgress ? (this.hand?.contenders() ?? []) : [];
  }

  private assertSeatIndex(seatIndex: number): void {
    if (seatIndex < 0 || seatIndex >= this.seatCount) {
      throw new Error(`Seat ${seatIndex} out of range`);
    }
  }
}
