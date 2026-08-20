/**
 * HoldemHand — the rules of ONE no-limit Texas Hold'em hand.
 *
 * Self-contained on purpose. The npm rules engines we evaluated either
 * mishandle side pots once a hand continues past an all-in (all-in seats
 * dropped from later streets, so their pot share vanishes or is paid to
 * the wrong seat) or pull in Node-only modules; the surface needed here is
 * small enough to own and to prove with the chip-conservation tests.
 *
 * Model:
 *   - `committed` per seat is the total put in over the WHOLE hand. Side
 *     pots are derived from those totals at showdown (the standard
 *     contribution-level algorithm), so nothing is ever mis-collected
 *     mid-hand and folded chips stay in the pots they reached.
 *   - A betting round tracks `bet` (this street), `biggestBet`, the last
 *     full-raise increment (`minRaise`) and a queue of seats still owing
 *     an action. Any bet/raise re-queues every other active seat; the round
 *     ends when the queue is empty. Preflop the queue ends at the big
 *     blind, which gives it its option.
 *   - Once fewer than two seats can still act, remaining streets are
 *     dealt at once (`runOut`) and the hand goes to showdown.
 *
 * Amounts are integer chips; bet/raise sizes are TOTAL bet on the street
 * ("raise to"), like every real client.
 */
import { Hand } from "pokersolver";

import {
  type Card,
  type Rng,
  fullDeck,
  shuffleInPlace,
  toSolverCode,
} from "./cards";
import type { LegalActions, PlayerAction, Street } from "./types";

export interface HandSeatInput {
  seatIndex: number;
  stack: number;
}

export interface HandSeatState {
  seatIndex: number;
  stack: number;
  /** Chips bet on the current street. */
  bet: number;
  /** Chips committed over the whole hand. */
  committed: number;
  folded: boolean;
  allIn: boolean;
  holeCards: Card[];
}

export interface PotShare {
  size: number;
  eligibleSeats: number[];
}

export interface ShowdownPayout {
  seatIndex: number;
  amount: number;
}

const STREET_ORDER: Street[] = ["preflop", "flop", "turn", "river"];
const CARDS_ON_STREET: Record<Street, number> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

export interface HoldemHandOptions {
  seats: HandSeatInput[];
  buttonSeat: number;
  smallBlind: number;
  bigBlind: number;
  rng?: Rng;
  /** Pre-shuffled deck (tests); dealt from the front. */
  deck?: Card[];
}

export class HoldemHand {
  private readonly seats = new Map<number, HandSeatState>();
  /** Seat order around the table (ascending seat index, wrapping). */
  private readonly order: number[];
  private readonly deck: Card[];
  private readonly bigBlind: number;
  readonly buttonSeat: number;

  private streetIndex = 0;
  private community: Card[] = [];
  private biggestBet = 0;
  private minRaise: number;
  private queue: number[] = [];
  /** All betting is over: fold-out, river closed, or run-out dealt. */
  private bettingComplete = false;
  private complete = false;
  private payouts: ShowdownPayout[] | null = null;

  constructor(options: HoldemHandOptions) {
    if (options.seats.length < 2) {
      throw new Error("A hand needs at least two seats");
    }
    this.bigBlind = options.bigBlind;
    this.minRaise = options.bigBlind;
    this.buttonSeat = options.buttonSeat;
    const rng = options.rng ?? defaultRng;
    this.deck = options.deck
      ? options.deck.slice()
      : shuffleInPlace(fullDeck(), rng);

    this.order = options.seats
      .map((seat) => seat.seatIndex)
      .sort((a, b) => a - b);
    for (const seat of options.seats) {
      if (seat.stack <= 0)
        throw new Error(`Seat ${seat.seatIndex} has no chips`);
      this.seats.set(seat.seatIndex, {
        seatIndex: seat.seatIndex,
        stack: seat.stack,
        bet: 0,
        committed: 0,
        folded: false,
        allIn: false,
        holeCards: [this.draw(), this.draw()],
      });
    }
    if (!this.seats.has(this.buttonSeat)) {
      throw new Error("Button must be a seated player");
    }

    // Blinds. Heads-up: button posts the small blind and acts first preflop.
    const headsUp = this.order.length === 2;
    const smallBlindSeat = headsUp
      ? this.buttonSeat
      : this.nextSeat(this.buttonSeat);
    const bigBlindSeat = this.nextSeat(smallBlindSeat);
    this.post(smallBlindSeat, options.smallBlind);
    this.post(bigBlindSeat, options.bigBlind);
    this.biggestBet = Math.max(
      this.seats.get(smallBlindSeat)!.bet,
      this.seats.get(bigBlindSeat)!.bet
    );

    // Preflop queue: from the seat after the big blind around to the big
    // blind itself (its option). All-in blinds are skipped.
    this.queue = this.seatsFrom(this.nextSeat(bigBlindSeat)).filter((seat) =>
      this.canAct(seat)
    );
  }

  // ─── Queries ────────────────────────────────────────────────────────────

  street(): Street {
    return STREET_ORDER[this.streetIndex];
  }

  communityCards(): Card[] {
    return this.community.slice();
  }

  seatStates(): HandSeatState[] {
    return this.order.map((seat) => ({
      ...this.seats.get(seat)!,
      holeCards: this.seats.get(seat)!.holeCards.slice(),
    }));
  }

  seat(seatIndex: number): HandSeatState | null {
    const seat = this.seats.get(seatIndex);
    return seat ? { ...seat, holeCards: seat.holeCards.slice() } : null;
  }

  isBettingRoundInProgress(): boolean {
    return !this.bettingComplete && this.queue.length > 0;
  }

  /** All betting is over (board dealt as far as it goes); `showdown()` may run. */
  areBettingRoundsCompleted(): boolean {
    return this.bettingComplete && !this.complete;
  }

  isComplete(): boolean {
    return this.complete;
  }

  playerToAct(): number | null {
    return this.isBettingRoundInProgress() ? this.queue[0] : null;
  }

  /** Seats dealt in and not folded. */
  contenders(): number[] {
    return this.order.filter((seat) => !this.seats.get(seat)!.folded);
  }

  /** Total chips in the middle: everything committed so far (0 once paid). */
  potTotal(): number {
    if (this.payouts) return 0;
    let total = 0;
    for (const seat of this.seats.values()) total += seat.committed;
    return total;
  }

  /** Side pots as they stand now (from committed totals; empty once paid). */
  pots(): PotShare[] {
    if (this.payouts) return [];
    return derivePots(Array.from(this.seats.values()));
  }

  callAmount(): number {
    const actor = this.playerToAct();
    if (actor === null) return 0;
    const seat = this.seats.get(actor)!;
    return Math.min(seat.stack, this.biggestBet - seat.bet);
  }

  legalActions(): LegalActions | null {
    const actor = this.playerToAct();
    if (actor === null) return null;
    const seat = this.seats.get(actor)!;
    const actions: PlayerAction[] = ["fold"];
    const toCall = this.biggestBet - seat.bet;
    if (toCall <= 0) actions.push("check");
    else actions.push("call");
    const maxTotal = seat.stack + seat.bet;
    let chipRange: LegalActions["chipRange"];
    if (maxTotal > this.biggestBet) {
      const aggressive: PlayerAction = this.biggestBet === 0 ? "bet" : "raise";
      actions.push(aggressive);
      const fullMin = this.biggestBet + this.minRaise;
      chipRange = { min: Math.min(fullMin, maxTotal), max: maxTotal };
    }
    return { actions, chipRange };
  }

  // ─── Actions ────────────────────────────────────────────────────────────

  act(action: PlayerAction, amount?: number): void {
    const actor = this.playerToAct();
    if (actor === null) throw new Error("No betting round in progress");
    const legal = this.legalActions()!;
    if (!legal.actions.includes(action)) {
      throw new Error(`${action} is not legal for seat ${actor}`);
    }
    const seat = this.seats.get(actor)!;

    switch (action) {
      case "fold":
        seat.folded = true;
        this.queue.shift();
        break;
      case "check":
        this.queue.shift();
        break;
      case "call": {
        const toCall = Math.min(seat.stack, this.biggestBet - seat.bet);
        this.put(seat, toCall);
        this.queue.shift();
        break;
      }
      case "bet":
      case "raise": {
        const range = legal.chipRange!;
        const target = Math.min(
          range.max,
          Math.max(range.min, Math.round(amount ?? range.min))
        );
        const increment = target - this.biggestBet;
        this.put(seat, target - seat.bet);
        // A full raise resets the min-raise; a short all-in raise does not.
        if (increment >= this.minRaise) this.minRaise = increment;
        this.biggestBet = target;
        // Everyone else who can still act owes a response.
        this.queue = this.seatsFrom(this.nextSeat(actor)).filter(
          (other) => other !== actor && this.canAct(other)
        );
        break;
      }
      default:
        throw new Error(`Unknown action ${String(action)}`);
    }

    if (this.contenders().length === 1) {
      // Everyone else folded — the hand is over, no more streets.
      this.queue = [];
      this.bettingComplete = true;
    }
  }

  /**
   * Close the current betting round and deal the next street. When fewer
   * than two seats can still act, every remaining street is dealt now.
   */
  endBettingRound(): void {
    if (this.isBettingRoundInProgress()) {
      throw new Error("Betting round still in progress");
    }
    // Fold-outs and run-outs complete betting on their own; closing the
    // round again is a harmless no-op so callers can stay uniform.
    if (this.bettingComplete) return;
    if (this.streetIndex >= STREET_ORDER.length - 1) {
      // River betting done — showdown next.
      this.bettingComplete = true;
      return;
    }
    const canStillAct = this.order.filter((seat) => this.canAct(seat));
    if (canStillAct.length < 2) {
      this.runOut();
      return;
    }
    this.streetIndex += 1;
    this.dealCommunity();
    this.startStreet();
  }

  /** Award the pots. Returns per-seat payouts (winners only). */
  showdown(): ShowdownPayout[] {
    if (this.payouts) return this.payouts;
    if (this.isBettingRoundInProgress()) {
      throw new Error("Betting round still in progress");
    }
    const contenders = this.contenders();
    // Any street still un-dealt with ≥2 contenders means callers skipped
    // endBettingRound(); be strict so the controller stays honest.
    if (contenders.length > 1 && this.community.length < 5) {
      throw new Error("Board is not complete");
    }
    const payouts = new Map<number, number>();
    const credit = (seat: number, amount: number) => {
      payouts.set(seat, (payouts.get(seat) ?? 0) + amount);
      this.seats.get(seat)!.stack += amount;
    };

    if (contenders.length === 1) {
      credit(contenders[0], this.potTotal());
    } else {
      const strength = new Map<number, Hand>();
      for (const seat of contenders) {
        const cards = [...this.seats.get(seat)!.holeCards, ...this.community];
        strength.set(seat, Hand.solve(cards.map(toSolverCode)));
      }
      for (const pot of this.pots()) {
        const eligible = pot.eligibleSeats.filter((seat) => strength.has(seat));
        if (eligible.length === 0 || pot.size === 0) continue;
        const hands = eligible.map((seat) => strength.get(seat)!);
        const winningHands = Hand.winners(hands);
        const winners = eligible.filter((seat) =>
          winningHands.includes(strength.get(seat)!)
        );
        const share = Math.floor(pot.size / winners.length);
        let odd = pot.size - share * winners.length;
        for (const seat of winners) credit(seat, share);
        // Odd chips go to the first winner left of the button.
        for (const seat of this.seatsFrom(this.nextSeat(this.buttonSeat))) {
          if (odd === 0) break;
          if (winners.includes(seat)) {
            credit(seat, 1);
            odd -= 1;
          }
        }
      }
    }
    this.payouts = Array.from(payouts.entries()).map(([seatIndex, amount]) => ({
      seatIndex,
      amount,
    }));
    this.complete = true;
    return this.payouts;
  }

  /** Solver description of a seat's best hand on the current board. */
  describe(seatIndex: number): string | null {
    const seat = this.seats.get(seatIndex);
    if (!seat || this.community.length < 3) return null;
    return Hand.solve([...seat.holeCards, ...this.community].map(toSolverCode))
      .descr;
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private startStreet(): void {
    for (const seat of this.seats.values()) seat.bet = 0;
    this.biggestBet = 0;
    this.minRaise = this.bigBlind;
    this.queue = this.seatsFrom(this.nextSeat(this.buttonSeat)).filter((seat) =>
      this.canAct(seat)
    );
  }

  private runOut(): void {
    this.streetIndex = STREET_ORDER.length - 1;
    this.dealCommunity();
    this.queue = [];
    this.bettingComplete = true;
  }

  private dealCommunity(): void {
    const target = CARDS_ON_STREET[this.street()];
    while (this.community.length < target) this.community.push(this.draw());
  }

  private draw(): Card {
    const card = this.deck.shift();
    if (!card) throw new Error("Deck exhausted");
    return card;
  }

  private post(seatIndex: number, amount: number): void {
    const seat = this.seats.get(seatIndex)!;
    this.put(seat, Math.min(amount, seat.stack));
  }

  private put(seat: HandSeatState, amount: number): void {
    const chips = Math.min(seat.stack, Math.max(0, amount));
    seat.stack -= chips;
    seat.bet += chips;
    seat.committed += chips;
    if (seat.stack === 0) seat.allIn = true;
  }

  private canAct(seatIndex: number): boolean {
    const seat = this.seats.get(seatIndex)!;
    return !seat.folded && !seat.allIn;
  }

  private nextSeat(from: number): number {
    const index = this.order.indexOf(from);
    return this.order[(index + 1) % this.order.length];
  }

  /** Seats in table order starting at `from` (inclusive), one full lap. */
  private seatsFrom(from: number): number[] {
    const start = this.order.indexOf(from);
    const result: number[] = [];
    for (let i = 0; i < this.order.length; i += 1) {
      result.push(this.order[(start + i) % this.order.length]);
    }
    return result;
  }
}

/**
 * Standard side-pot derivation from whole-hand contributions: for each
 * distinct contribution level (ascending), a pot collects the slice
 * between the previous level and this one from every seat that reached
 * it; only non-folded seats that reached the level are eligible.
 */
export function derivePots(seats: readonly HandSeatState[]): PotShare[] {
  const levels = Array.from(
    new Set(seats.filter((s) => s.committed > 0).map((s) => s.committed))
  ).sort((a, b) => a - b);
  const pots: PotShare[] = [];
  let previous = 0;
  for (const level of levels) {
    const slice = level - previous;
    let size = 0;
    const eligible: number[] = [];
    for (const seat of seats) {
      if (seat.committed >= level) {
        size += slice;
        if (!seat.folded) eligible.push(seat.seatIndex);
      } else if (seat.committed > previous) {
        // Folded (or short) seat that stopped between levels — its
        // remainder belongs to this pot slice.
        size += seat.committed - previous;
      }
    }
    previous = level;
    if (size === 0) continue;
    // Merge with the previous pot when eligibility is identical (a folded
    // seat's leftover shouldn't create a pot of its own).
    const last = pots[pots.length - 1];
    if (last && sameSeats(last.eligibleSeats, eligible)) {
      last.size += size;
    } else {
      pots.push({ size, eligibleSeats: eligible });
    }
  }
  return pots;
}

function sameSeats(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((seat, i) => seat === b[i]);
}

/** Browser CSPRNG when present (Tauri webview), Math.random otherwise. */
function defaultRng(): number {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    const buffer = new Uint32Array(1);
    cryptoApi.getRandomValues(buffer);
    return buffer[0] / 4294967296;
  }
  return Math.random();
}
