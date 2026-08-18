/**
 * Minimal typings for `pokersolver` (MIT, no published types). Only the
 * surface the poker table's evaluator uses is declared here — the library
 * exposes far more (Omaha, Razz, …) that we don't touch.
 */
declare module "pokersolver" {
  /** A card code like `"Ad"`, `"Tc"` — rank char + lowercase suit char. */
  type SolverCardCode = string;

  class Hand {
    /** Human-readable description, e.g. `"Two Pair, K's & 2's"`. */
    readonly descr: string;
    /** Category name, e.g. `"Two Pair"`. */
    readonly name: string;
    /** Category rank; larger beats smaller (kickers handled by `winners`). */
    readonly rank: number;
    /** Best five cards, highest first. */
    readonly cards: Array<{ value: string; suit: string }>;

    /** Evaluate the best hand out of the given cards (5–7 for Hold'em). */
    static solve(cards: SolverCardCode[], game?: string): Hand;
    /** Subset of `hands` that win (ties return several). */
    static winners(hands: Hand[]): Hand[];
  }
}
