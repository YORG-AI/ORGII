/**
 * Heuristic Hold'em bot: Chen-score tiers preflop, Monte-Carlo equity vs.
 * pot odds postflop, shaped by a persona's looseness / aggression / bluff
 * knobs. Deliberately beatable — this is a play-chip table, not a solver —
 * but it folds trash, values strong hands and bluffs occasionally, which
 * is what makes hands feel like poker.
 *
 * Pure function of its input plus the injected `rng`, so decisions are
 * reproducible in tests.
 */
import type { Card, Rng } from "./cards";
import { chenScore, estimateEquity } from "./handEvaluator";
import type { BotStyle } from "./personas";
import type { LegalActions, PlayerAction, SeatAction, Street } from "./types";

export interface BotDecisionInput {
  holeCards: readonly Card[];
  communityCards: readonly Card[];
  street: Street;
  legalActions: LegalActions;
  /** Chips this bot must add to call (0 when checking is legal). */
  callAmount: number;
  /** Collected pots plus all live bets, before this bot acts. */
  potTotal: number;
  /** Chips behind. */
  stack: number;
  /** Chips this bot has already committed on the current street. */
  betSize: number;
  /** Opponents still contesting the pot. */
  opponentsInHand: number;
  bigBlind: number;
  style: BotStyle;
  rng: Rng;
  /** Monte-Carlo samples for postflop equity (tests use fewer). */
  equitySamples?: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Round bet sizes so bots bet `1.2M`, not `1,237,412`. */
function roundBet(amount: number, bigBlind: number): number {
  const unit = Math.max(1, Math.round(bigBlind / 10));
  return Math.round(amount / unit) * unit;
}

/** Legal total bet nearest to `target` — respects the engine's chip range. */
function sizeWithinRange(
  target: number,
  legalActions: LegalActions,
  bigBlind: number
): number | null {
  const range = legalActions.chipRange;
  if (!range) return null;
  return clamp(roundBet(target, bigBlind), range.min, range.max);
}

function has(legalActions: LegalActions, action: PlayerAction): boolean {
  return legalActions.actions.includes(action);
}

/** Safest legal passive action. */
function passive(legalActions: LegalActions): SeatAction {
  if (has(legalActions, "check")) return { action: "check" };
  if (has(legalActions, "call")) return { action: "call" };
  return { action: "fold" };
}

function aggressive(
  legalActions: LegalActions,
  target: number,
  bigBlind: number
): SeatAction | null {
  const action: PlayerAction | null = has(legalActions, "raise")
    ? "raise"
    : has(legalActions, "bet")
      ? "bet"
      : null;
  if (!action) return null;
  const amount = sizeWithinRange(target, legalActions, bigBlind);
  if (amount === null) return null;
  return { action, amount };
}

export function decideBotAction(input: BotDecisionInput): SeatAction {
  return input.street === "preflop"
    ? decidePreflop(input)
    : decidePostflop(input);
}

function decidePreflop(input: BotDecisionInput): SeatAction {
  const { legalActions, style, rng, bigBlind, callAmount, potTotal, betSize } =
    input;
  // Chen: 72o ≈ -1 … AA = 20 → 0..1
  const strength = clamp((chenScore(input.holeCards) + 1) / 21, 0, 1);
  const openThreshold = 0.62 - style.looseness * 0.35;
  const facingRaise = callAmount > bigBlind || betSize + callAmount > bigBlind;

  if (facingRaise) {
    const continueThreshold = openThreshold + 0.12;
    if (strength >= continueThreshold + 0.28 && rng() < style.aggression) {
      // 3-bet: about 3× the bet we face.
      const raiseTo = (betSize + callAmount) * 3;
      return (
        aggressive(legalActions, raiseTo, bigBlind) ?? passive(legalActions)
      );
    }
    if (strength >= continueThreshold) return passive(legalActions);
    // Occasional light defence when the raise is small relative to the pot.
    const cheap = callAmount <= potTotal * 0.25;
    if (cheap && strength >= openThreshold && rng() < style.looseness * 0.5) {
      return passive(legalActions);
    }
    return { action: "fold" };
  }

  // Unopened / limped pot.
  if (strength >= openThreshold) {
    if (rng() < style.aggression + 0.1) {
      const limpers = Math.max(0, Math.round(potTotal / bigBlind) - 2);
      const raiseTo = bigBlind * (2.5 + 0.5 * limpers);
      return (
        aggressive(legalActions, raiseTo, bigBlind) ?? passive(legalActions)
      );
    }
    return passive(legalActions);
  }
  if (has(legalActions, "check")) return { action: "check" };
  // Loose personas limp marginal hands for a single blind.
  if (
    callAmount <= bigBlind &&
    strength >= openThreshold - 0.15 &&
    rng() < style.looseness
  ) {
    return { action: "call" };
  }
  return { action: "fold" };
}

function decidePostflop(input: BotDecisionInput): SeatAction {
  const {
    legalActions,
    style,
    rng,
    bigBlind,
    callAmount,
    potTotal,
    stack,
    opponentsInHand,
  } = input;
  const equity = estimateEquity({
    holeCards: input.holeCards,
    communityCards: input.communityCards,
    opponents: opponentsInHand,
    samples: input.equitySamples ?? 250,
    rng,
  });
  const facingBet = callAmount > 0;
  const potOdds = facingBet ? callAmount / (potTotal + callAmount) : 0;
  const multiway = Math.max(0, opponentsInHand - 1);

  if (facingBet) {
    // Calling for our whole stack needs a bit more than pot odds.
    const allInCall = callAmount >= stack;
    const required = potOdds + 0.03 + (allInCall ? 0.05 : 0);
    if (equity >= required + 0.25 && rng() < style.aggression) {
      const raiseTo = Math.max(callAmount * 3, potTotal * 0.75);
      return (
        aggressive(legalActions, raiseTo, bigBlind) ?? passive(legalActions)
      );
    }
    if (equity >= required) return passive(legalActions);
    if (
      rng() < style.bluffFrequency * 0.3 &&
      callAmount < potTotal * 0.6 &&
      multiway === 0
    ) {
      const raiseTo = Math.max(callAmount * 3, potTotal * 0.8);
      return aggressive(legalActions, raiseTo, bigBlind) ?? { action: "fold" };
    }
    return { action: "fold" };
  }

  // Checked to us.
  const valueThreshold = 0.55 + 0.05 * multiway;
  if (equity >= valueThreshold) {
    if (rng() < style.aggression + 0.15) {
      const fraction = 0.55 + rng() * 0.2 + (equity > 0.8 ? 0.15 : 0);
      return (
        aggressive(legalActions, potTotal * fraction, bigBlind) ??
        passive(legalActions)
      );
    }
    return passive(legalActions);
  }
  if (equity >= 0.4 && rng() < style.aggression * 0.4) {
    return (
      aggressive(legalActions, potTotal * 0.5, bigBlind) ??
      passive(legalActions)
    );
  }
  if (rng() < style.bluffFrequency && multiway === 0) {
    return (
      aggressive(legalActions, potTotal * 0.55, bigBlind) ??
      passive(legalActions)
    );
  }
  return passive(legalActions);
}
