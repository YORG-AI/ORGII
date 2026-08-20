/**
 * PokerTableController — runs a table over time.
 *
 * `PokerTableEngine` is synchronous and timing-free; this class owns the
 * clock: it seats the human and five bots, deals hands, lets bots "think"
 * for a moment before acting, reveals run-out streets one at a time, holds
 * the showdown on screen, and starts the next hand. It also does the
 * bookkeeping around a play-chip bankroll (buy-in, rebuy, cash-out) and
 * keeps a short hand history for the panel's history drawer.
 *
 * It is a plain external store (`subscribe` / `getState`) so React reads
 * it through `useSyncExternalStore`; timers and randomness are injectable
 * so tests can drive it deterministically with fake timers.
 */
import { PokerTableEngine } from "./engine/PokerTableEngine";
import { decideBotAction } from "./engine/botBrain";
import type { Rng } from "./engine/cards";
import { BOT_PERSONAS, findPersona, personaToPlayer } from "./engine/personas";
import type {
  Blinds,
  HandResult,
  PlayerAction,
  PokerPlayer,
  SeatAction,
  TableSnapshot,
} from "./engine/types";

export type TableSpeed = "normal" | "fast";

export interface HandHistoryEntry {
  handNumber: number;
  potTotal: number;
  foldedOut: boolean;
  winners: Array<{
    seatIndex: number;
    name: string;
    amount: number;
    handDescription: string | null;
  }>;
  /** Hero's stack change over the hand (negative when they lost). */
  heroNet: number;
}

export interface PokerTableViewState {
  snapshot: TableSnapshot;
  heroSeat: number;
  /** How many community cards the UI should show (progressive run-out reveal). */
  revealedCommunity: number;
  /** When the current actor started thinking; drives "Thinking · Ns". */
  thinkingSince: number | null;
  /** Hero lost their stack — waiting for a rebuy or a leave. */
  awaitingRebuy: boolean;
  bankroll: number;
  handHistory: HandHistoryEntry[];
  speed: TableSpeed;
}

export interface PokerTableControllerOptions {
  hero: PokerPlayer;
  blinds: Blinds;
  buyIn: number;
  bankroll: number;
  onBankrollChange?: (bankroll: number) => void;
  speed?: TableSpeed;
  botCount?: number;
  rng?: Rng;
  now?: () => number;
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  /** Bot policy override (tests). */
  decideBot?: typeof decideBotAction;
}

const HISTORY_LIMIT = 40;

interface Delays {
  botThinkMin: number;
  botThinkMax: number;
  deal: number;
  showdownHold: number;
  foldOutHold: number;
  handStart: number;
}

const DELAYS: Record<TableSpeed, Delays> = {
  normal: {
    botThinkMin: 900,
    botThinkMax: 2200,
    deal: 650,
    showdownHold: 4200,
    foldOutHold: 1700,
    handStart: 500,
  },
  fast: {
    botThinkMin: 300,
    botThinkMax: 750,
    deal: 280,
    showdownHold: 1800,
    foldOutHold: 800,
    handStart: 250,
  },
};

export class PokerTableController {
  private readonly engine: PokerTableEngine;
  private readonly heroSeat = 0;
  private readonly hero: PokerPlayer;
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly scheduler: NonNullable<
    PokerTableControllerOptions["scheduler"]
  >;
  private readonly decideBot: typeof decideBotAction;
  private readonly onBankrollChange?: (bankroll: number) => void;
  private readonly listeners = new Set<() => void>();
  private readonly buyIn: number;
  private readonly botCount: number;

  private state: PokerTableViewState;
  private timer: unknown = null;
  private disposed = false;
  private started = false;
  private heroStackAtHandStart = 0;
  private pendingBlinds: Blinds | null = null;
  private personaCursor = 0;
  private readonly personaOrder: string[];

  constructor(options: PokerTableControllerOptions) {
    this.hero = options.hero;
    this.rng = options.rng ?? Math.random;
    this.now = options.now ?? (() => Date.now());
    this.scheduler = options.scheduler ?? {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
    };
    this.decideBot = options.decideBot ?? decideBotAction;
    this.onBankrollChange = options.onBankrollChange;
    this.buyIn = options.buyIn;
    this.botCount = Math.min(5, Math.max(1, options.botCount ?? 5));
    // Same rng for the deck as for the bots, so a seeded controller (tests)
    // is fully deterministic; production leaves both on the CSPRNG default.
    this.engine = new PokerTableEngine(options.blinds, {
      rng: options.rng,
    });
    this.personaOrder = shuffle(
      BOT_PERSONAS.map((persona) => persona.id),
      this.rng
    );

    this.state = {
      snapshot: this.engine.snapshot(this.heroSeat),
      heroSeat: this.heroSeat,
      revealedCommunity: 0,
      thinkingSince: null,
      awaitingRebuy: false,
      bankroll: options.bankroll,
      handHistory: [],
      speed: options.speed ?? "normal",
    };
  }

  // ─── External store ─────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): PokerTableViewState => this.state;

  private publish(patch: Partial<PokerTableViewState> = {}): void {
    this.state = {
      ...this.state,
      ...patch,
      snapshot: this.engine.snapshot(this.heroSeat),
    };
    this.listeners.forEach((listener) => listener());
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Seat everyone and deal the first hand. Idempotent. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const buyIn = Math.min(this.buyIn, this.state.bankroll);
    if (buyIn <= 0) {
      // Nothing to play with — the UI offers a bankroll reset.
      this.publish({ awaitingRebuy: true });
      return;
    }
    this.setBankroll(this.state.bankroll - buyIn);
    this.engine.sitDown(this.heroSeat, this.hero, buyIn);
    for (let seat = 1; seat <= this.botCount; seat += 1) {
      this.seatBot(seat);
    }
    this.publish();
    this.schedule(() => this.advance(), DELAYS[this.state.speed].handStart);
  }

  /**
   * Cash out and stop. Returns the chips returned to the bankroll — the
   * stack behind; chips already in the pot mid-hand are forfeited, as when
   * leaving a live table. The engine is abandoned with the table, so the
   * hero is not formally unseated (which the rules engine forbids between
   * streets anyway).
   */
  leave(): number {
    if (this.disposed) return 0;
    this.clearTimer();
    const stack = this.engine.isSeated(this.heroSeat)
      ? this.engine.stackOf(this.heroSeat)
      : 0;
    this.setBankroll(this.state.bankroll + stack);
    this.disposed = true;
    this.publish();
    return stack;
  }

  dispose(): void {
    if (!this.disposed) this.leave();
    this.listeners.clear();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  // ─── Hero input ─────────────────────────────────────────────────────────

  /** Whether it is the human's turn right now. */
  isHeroToAct(): boolean {
    return !this.disposed && this.engine.playerToAct() === this.heroSeat;
  }

  heroAct(action: PlayerAction, amount?: number): void {
    if (!this.isHeroToAct()) return;
    const legal = this.engine.legalActions();
    if (!legal || !legal.actions.includes(action)) return;
    this.clearTimer();
    this.engine.act(action, amount);
    this.publish({ thinkingSince: null });
    this.advance();
  }

  /** Put more chips in front of a busted hero. */
  rebuy(amount: number = this.buyIn): void {
    if (this.disposed || !this.state.awaitingRebuy) return;
    const chips = Math.min(amount, this.state.bankroll);
    if (chips <= 0) return;
    this.setBankroll(this.state.bankroll - chips);
    if (this.engine.isSeated(this.heroSeat)) {
      this.engine.rebuy(this.heroSeat, chips);
    } else {
      this.engine.sitDown(this.heroSeat, this.hero, chips);
    }
    this.publish({ awaitingRebuy: false });
    this.schedule(() => this.advance(), DELAYS[this.state.speed].handStart);
  }

  /** Free play chips: reset the bankroll (the table is not money). */
  resetBankroll(chips: number): void {
    if (this.disposed) return;
    this.setBankroll(chips);
    this.publish();
  }

  /** Stakes change takes effect at the next hand. */
  setBlinds(blinds: Blinds): void {
    if (this.disposed) return;
    if (this.engine.isHandInProgress()) {
      this.pendingBlinds = blinds;
    } else {
      this.engine.setBlinds(blinds);
      this.publish();
    }
  }

  setSpeed(speed: TableSpeed): void {
    if (this.disposed || speed === this.state.speed) return;
    this.publish({ speed });
  }

  /** Skip the post-hand hold and deal now. */
  dealNextHand(): void {
    if (this.disposed || this.engine.isHandInProgress()) return;
    this.clearTimer();
    this.advance();
  }

  // ─── Game loop ──────────────────────────────────────────────────────────

  private advance(): void {
    if (this.disposed) return;
    const delays = DELAYS[this.state.speed];

    if (!this.engine.isHandInProgress()) {
      this.betweenHands();
      return;
    }

    // Reveal community cards one street at a time — the rules engine deals
    // the whole run-out at once when everyone is all-in.
    const community = this.engine.communityCards().length;
    if (this.state.revealedCommunity < community) {
      const next =
        this.state.revealedCommunity < 3
          ? Math.min(3, community)
          : this.state.revealedCommunity + 1;
      this.publish({ revealedCommunity: next, thinkingSince: null });
      this.schedule(() => this.advance(), delays.deal);
      return;
    }

    if (this.engine.isBettingRoundInProgress()) {
      const toAct = this.engine.playerToAct();
      if (toAct === null) return;
      this.publish({ thinkingSince: this.now() });
      if (toAct === this.heroSeat) return; // wait for heroAct()
      const wait = this.botThinkDelay(toAct);
      this.schedule(() => {
        this.botAct(toAct);
        this.advance();
      }, wait);
      return;
    }

    if (this.engine.areBettingRoundsCompleted()) {
      const result = this.engine.showdown();
      this.recordHistory(result);
      this.publish({ thinkingSince: null });
      this.schedule(
        () => this.advance(),
        result.foldedOut ? delays.foldOutHold : delays.showdownHold
      );
      return;
    }

    this.engine.endBettingRound();
    this.publish({ thinkingSince: null });
    this.schedule(() => this.advance(), delays.deal);
  }

  private betweenHands(): void {
    // Hero busted: pause until they rebuy or leave.
    if (
      this.engine.isSeated(this.heroSeat) &&
      this.engine.isBusted(this.heroSeat)
    ) {
      this.publish({ awaitingRebuy: true, thinkingSince: null });
      return;
    }
    if (!this.engine.isSeated(this.heroSeat)) return;

    // Busted bots leave; a fresh persona takes the seat.
    for (let seat = 1; seat <= this.botCount; seat += 1) {
      if (this.engine.isSeated(seat) && this.engine.isBusted(seat)) {
        this.engine.standUp(seat);
      }
      if (!this.engine.isSeated(seat)) this.seatBot(seat);
    }

    if (this.pendingBlinds) {
      this.engine.setBlinds(this.pendingBlinds);
      this.pendingBlinds = null;
    }

    this.engine.startHand();
    this.heroStackAtHandStart = this.engine.stackOf(this.heroSeat);
    this.publish({ revealedCommunity: 0, thinkingSince: null });
    this.schedule(() => this.advance(), DELAYS[this.state.speed].handStart);
  }

  private botAct(seat: number): void {
    if (this.engine.playerToAct() !== seat) return;
    const player = this.engine.playerAt(seat);
    const legalActions = this.engine.legalActions();
    const holeCards = this.engine.holeCardsOf(seat);
    if (!player || !legalActions || !holeCards) {
      this.engine.act("fold");
      return;
    }
    const snapshot = this.engine.snapshot(seat);
    const own = snapshot.seats[seat];
    const decision: SeatAction = this.decideBot({
      holeCards,
      communityCards: snapshot.communityCards,
      street: snapshot.street ?? "preflop",
      legalActions,
      callAmount: snapshot.callAmount,
      potTotal: snapshot.potTotal,
      stack: own?.stack ?? 0,
      betSize: own?.betSize ?? 0,
      opponentsInHand: Math.max(1, this.engine.contendingSeats().length - 1),
      bigBlind: this.engine.getBlinds().bigBlind,
      style: findPersona(player.personaId).style,
      rng: this.rng,
    });
    if (!legalActions.actions.includes(decision.action)) {
      this.engine.act(
        legalActions.actions.includes("check") ? "check" : "fold"
      );
      return;
    }
    this.engine.act(decision.action, decision.amount);
  }

  private botThinkDelay(seat: number): number {
    const delays = DELAYS[this.state.speed];
    const persona = findPersona(this.engine.playerAt(seat)?.personaId);
    const base =
      delays.botThinkMin +
      this.rng() * (delays.botThinkMax - delays.botThinkMin);
    // Hero out of the hand → nobody is waiting on the drama; speed up.
    const heroInHand = this.engine.contendingSeats().includes(this.heroSeat);
    return Math.round(base * persona.style.tempo * (heroInHand ? 1 : 0.45));
  }

  private seatBot(seat: number): void {
    const personaId =
      this.personaOrder[this.personaCursor % this.personaOrder.length];
    this.personaCursor += 1;
    const persona = findPersona(personaId);
    const bigBlind = this.engine.getBlinds().bigBlind;
    // 15–120 big blinds, like a real table's spread of stacks.
    const stack = Math.round(bigBlind * (15 + this.rng() * 105));
    this.engine.sitDown(seat, personaToPlayer(persona), stack);
  }

  private recordHistory(result: HandResult): void {
    const heroNet =
      this.engine.stackOf(this.heroSeat) - this.heroStackAtHandStart;
    const entry: HandHistoryEntry = {
      handNumber: result.handNumber,
      potTotal: result.potTotal,
      foldedOut: result.foldedOut,
      heroNet,
      winners: result.entries
        .filter((e) => e.amountWon > 0)
        .map((e) => ({
          seatIndex: e.seatIndex,
          name:
            this.engine.playerAt(e.seatIndex)?.name ?? `seat ${e.seatIndex}`,
          amount: e.amountWon,
          handDescription: e.handDescription,
        })),
    };
    this.state = {
      ...this.state,
      handHistory: [entry, ...this.state.handHistory].slice(0, HISTORY_LIMIT),
    };
  }

  private setBankroll(bankroll: number): void {
    const next = Math.max(0, Math.round(bankroll));
    this.state = { ...this.state, bankroll: next };
    this.onBankrollChange?.(next);
  }

  private schedule(fn: () => void, ms: number): void {
    this.clearTimer();
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
