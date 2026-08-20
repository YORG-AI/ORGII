/**
 * Hand strength helpers on top of `pokersolver`.
 *
 * Two jobs: describe a made hand for the UI ("Two Pair, K's & 2's"), and
 * estimate equity by Monte-Carlo for the bots. The rules engine already
 * decides showdowns; this module never awards pots.
 */
import { Hand } from "pokersolver";

import {
  type Card,
  type Rng,
  rankIndex,
  remainingDeck,
  shuffleInPlace,
  toSolverCode,
} from "./cards";

/** `"Two Pair, K's & 2's"` for 5–7 cards; null when fewer than 5. */
export function describeHand(cards: readonly Card[]): string | null {
  if (cards.length < 5) return null;
  return Hand.solve(cards.map(toSolverCode)).descr;
}

export interface EquityInput {
  holeCards: readonly Card[];
  communityCards: readonly Card[];
  /** Opponents still contesting the pot. */
  opponents: number;
  /** Simulations; ~300 keeps a decision under ~50ms in the renderer. */
  samples?: number;
  rng: Rng;
}

/**
 * Probability (0–1) that `holeCards` wins or ties against `opponents`
 * random hands after dealing out the board. Ties count fractionally.
 */
export function estimateEquity({
  holeCards,
  communityCards,
  opponents,
  samples = 300,
  rng,
}: EquityInput): number {
  if (holeCards.length !== 2) return 0;
  const opponentCount = Math.max(1, opponents);
  const stub = remainingDeck([...holeCards, ...communityCards]);
  const heroCodes = holeCards.map(toSolverCode);
  const boardCodes = communityCards.map(toSolverCode);
  const missingBoard = 5 - communityCards.length;

  let score = 0;
  for (let i = 0; i < samples; i += 1) {
    shuffleInPlace(stub, rng);
    let cursor = 0;
    const board = boardCodes.slice();
    for (let b = 0; b < missingBoard; b += 1) {
      board.push(toSolverCode(stub[cursor]));
      cursor += 1;
    }
    const heroHand = Hand.solve([...heroCodes, ...board]);
    const hands = [heroHand];
    for (let o = 0; o < opponentCount; o += 1) {
      const c1 = toSolverCode(stub[cursor]);
      const c2 = toSolverCode(stub[cursor + 1]);
      cursor += 2;
      hands.push(Hand.solve([c1, c2, ...board]));
    }
    const winners = Hand.winners(hands);
    if (winners.includes(heroHand)) {
      score += 1 / winners.length;
    }
  }
  return score / samples;
}

/**
 * Chen formula — the classic preflop hand score (AA = 20, 72o ≈ -1).
 * Used by the bots to tier starting hands without a lookup table.
 */
export function chenScore(holeCards: readonly Card[]): number {
  if (holeCards.length !== 2) return 0;
  const [a, b] = holeCards;
  const hi = rankIndex(a.rank) >= rankIndex(b.rank) ? a : b;
  const lo = hi === a ? b : a;
  const hiIndex = rankIndex(hi.rank);
  const loIndex = rankIndex(lo.rank);

  const highCardPoints = (index: number): number => {
    // 2..9 → 1..4.5 (half the pip), T=5, J=6, Q=7, K=8, A=10
    if (index >= 12) return 10;
    if (index === 11) return 8;
    if (index === 10) return 7;
    if (index === 9) return 6;
    if (index === 8) return 5;
    return (index + 2) / 2;
  };

  let score = highCardPoints(hiIndex);
  const paired = hiIndex === loIndex;
  if (paired) {
    score = Math.max(5, score * 2);
  }
  if (a.suit === b.suit && !paired) score += 2;

  const gap = paired ? 0 : hiIndex - loIndex - 1;
  if (gap === 1) score -= 1;
  else if (gap === 2) score -= 2;
  else if (gap === 3) score -= 4;
  else if (gap >= 4) score -= 5;

  // Straight bonus: connectors / one-gappers below queen.
  if (!paired && gap <= 1 && hiIndex < 10) score += 1;

  return Math.ceil(score);
}
