/**
 * Card primitives shared by the poker table engine, the bots and the UI.
 *
 * The rules engine (`poker-ts`) and the evaluator (`pokersolver`) disagree
 * on card encoding — objects with long suit names vs. two-char codes — so
 * this module owns the one canonical `Card` shape and the conversions.
 */

export const RANKS = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "T",
  "J",
  "Q",
  "K",
  "A",
] as const;
export type Rank = (typeof RANKS)[number];

export const SUITS = ["clubs", "diamonds", "hearts", "spades"] as const;
export type Suit = (typeof SUITS)[number];

export interface Card {
  rank: Rank;
  suit: Suit;
}

const SUIT_CODE: Record<Suit, string> = {
  clubs: "c",
  diamonds: "d",
  hearts: "h",
  spades: "s",
};

/** `pokersolver` code, e.g. `{A, spades}` → `"As"`. */
export function toSolverCode(card: Card): string {
  return `${card.rank}${SUIT_CODE[card.suit]}`;
}

/** Stable key for React lists / dedup. */
export function cardKey(card: Card): string {
  return toSolverCode(card);
}

/** Zero-based rank index; `2` → 0, `A` → 12. */
export function rankIndex(rank: Rank): number {
  return RANKS.indexOf(rank);
}

/** All 52 cards, ranks ascending within suits. */
export function fullDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push({ rank, suit });
  }
  return deck;
}

/** Cards of the full deck not present in `used`. */
export function remainingDeck(used: readonly Card[]): Card[] {
  const usedKeys = new Set(used.map(cardKey));
  return fullDeck().filter((card) => !usedKeys.has(cardKey(card)));
}

/** Uniform `[0, 1)` source; injectable so bots and tests are reproducible. */
export type Rng = () => number;

/** In-place Fisher–Yates; returns the same array. */
export function shuffleInPlace<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
}

/**
 * Small deterministic PRNG (mulberry32) for tests and reproducible bot
 * decisions. Not for dealing — the rules engine deals with its own RNG.
 */
export function createSeededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
