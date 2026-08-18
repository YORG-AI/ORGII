import { describe, expect, it } from "vitest";

import { type Card, createSeededRng, fullDeck } from "./cards";
import { HoldemHand, derivePots } from "./holdemHand";

const SUIT_BY_CODE: Record<string, Card["suit"]> = {
  c: "clubs",
  d: "diamonds",
  h: "hearts",
  s: "spades",
};
const c = (code: string): Card => ({
  rank: code[0] as Card["rank"],
  suit: SUIT_BY_CODE[code[1]],
});

/** Deck whose front holds `front` (dealt in order), rest arbitrary. */
function deckWith(front: string[]): Card[] {
  const wanted = front.map(c);
  const key = (card: Card) => `${card.rank}${card.suit}`;
  const used = new Set(wanted.map(key));
  return [...wanted, ...fullDeck().filter((card) => !used.has(key(card)))];
}

function totalChips(hand: HoldemHand): number {
  return (
    hand.seatStates().reduce((sum, s) => sum + s.stack, 0) + hand.potTotal()
  );
}

describe("HoldemHand", () => {
  it("posts blinds and gives the big blind its option when everyone limps", () => {
    const hand = new HoldemHand({
      seats: [0, 1, 2, 3].map((seatIndex) => ({ seatIndex, stack: 10_000 })),
      buttonSeat: 0,
      smallBlind: 500,
      bigBlind: 1000,
      rng: createSeededRng(1),
    });
    expect(hand.seat(1)?.bet).toBe(500);
    expect(hand.seat(2)?.bet).toBe(1000);
    expect(hand.playerToAct()).toBe(3); // UTG
    hand.act("call");
    hand.act("call"); // button
    hand.act("call"); // small blind completes
    // Big blind still owes an action: check or raise.
    expect(hand.playerToAct()).toBe(2);
    expect(hand.legalActions()?.actions).toEqual(["fold", "check", "raise"]);
    hand.act("check");
    expect(hand.isBettingRoundInProgress()).toBe(false);
    hand.endBettingRound();
    expect(hand.street()).toBe("flop");
    expect(hand.communityCards()).toHaveLength(3);
    // Postflop the first active seat left of the button acts.
    expect(hand.playerToAct()).toBe(1);
    expect(hand.potTotal()).toBe(4000);
  });

  it("heads-up: the button posts the small blind and acts first preflop, second postflop", () => {
    const hand = new HoldemHand({
      seats: [
        { seatIndex: 0, stack: 10_000 },
        { seatIndex: 3, stack: 10_000 },
      ],
      buttonSeat: 3,
      smallBlind: 500,
      bigBlind: 1000,
      rng: createSeededRng(2),
    });
    expect(hand.seat(3)?.bet).toBe(500);
    expect(hand.seat(0)?.bet).toBe(1000);
    expect(hand.playerToAct()).toBe(3);
    hand.act("call");
    expect(hand.playerToAct()).toBe(0);
    hand.act("check");
    hand.endBettingRound();
    expect(hand.playerToAct()).toBe(0);
  });

  it("enforces the min-raise as the last full raise increment", () => {
    const hand = new HoldemHand({
      seats: [0, 1, 2].map((seatIndex) => ({ seatIndex, stack: 50_000 })),
      buttonSeat: 0,
      smallBlind: 500,
      bigBlind: 1000,
      rng: createSeededRng(3),
    });
    // UTG (seat 0) raises to 3000: increment 2000.
    expect(hand.legalActions()?.chipRange).toEqual({ min: 2000, max: 50_000 });
    hand.act("raise", 3000);
    // Next raiser must go to at least 5000.
    expect(hand.legalActions()?.chipRange?.min).toBe(5000);
    hand.act("raise", 9000); // increment 6000
    expect(hand.legalActions()?.chipRange?.min).toBe(15_000);
    // Below-min sizes are lifted to the minimum.
    hand.act("raise", 10_000);
    expect(hand.seat(2)?.bet).toBe(15_000);
  });

  it("awards side pots correctly with two all-ins for different amounts", () => {
    // seat 0: 27_380 (short), seat 1: 22_200 (shorter), seat 2: 80_550, seat 3: 105_500
    // Deck: seat 0 gets aces (wins main pot), seat 1 kings, seat 2 queens,
    // seat 3 junk. Board is blanks so hands hold.
    const deck = deckWith([
      "As",
      "Ah", // seat 0
      "Ks",
      "Kh", // seat 1
      "Qs",
      "Qh", // seat 2
      "7c",
      "2d", // seat 3
      "3s",
      "8d",
      "Tc",
      "4h",
      "9c", // board
    ]);
    const hand = new HoldemHand({
      seats: [
        { seatIndex: 0, stack: 27_380 },
        { seatIndex: 1, stack: 22_200 },
        { seatIndex: 2, stack: 80_550 },
        { seatIndex: 3, stack: 105_500 },
      ],
      buttonSeat: 3,
      smallBlind: 500,
      bigBlind: 1000,
      deck,
    });
    const before = totalChips(hand);
    // SB seat 0, BB seat 1, UTG seat 2.
    expect(hand.playerToAct()).toBe(2);
    hand.act("raise", 27_380);
    hand.act("call"); // seat 3
    hand.act("call"); // seat 0 all-in for 27_380
    hand.act("call"); // seat 1 all-in for 22_200 (short)
    expect(hand.isBettingRoundInProgress()).toBe(false);
    hand.endBettingRound();
    // Seats 2 and 3 can still bet on the flop.
    expect(hand.street()).toBe("flop");
    expect(hand.playerToAct()).toBe(2);
    const pots = hand.pots();
    expect(pots).toEqual([
      { size: 22_200 * 4, eligibleSeats: [0, 1, 2, 3] },
      { size: 5_180 * 3, eligibleSeats: [0, 2, 3] },
    ]);
    // Flop: seat 2 bets, seat 3 calls — grows a third pot for [2, 3] only.
    hand.act("bet", 10_000);
    hand.act("call");
    hand.endBettingRound();
    hand.act("check");
    hand.act("check");
    hand.endBettingRound();
    hand.act("check");
    hand.act("check");
    hand.endBettingRound();
    expect(hand.areBettingRoundsCompleted()).toBe(true);
    expect(hand.pots()).toEqual([
      { size: 88_800, eligibleSeats: [0, 1, 2, 3] },
      { size: 15_540, eligibleSeats: [0, 2, 3] },
      { size: 20_000, eligibleSeats: [2, 3] },
    ]);
    const payouts = hand.showdown();
    const byseat = Object.fromEntries(
      payouts.map((p) => [p.seatIndex, p.amount])
    );
    // Aces (seat 0) take the main pot AND the first side pot; queens (seat 2)
    // take the pot only 2 and 3 funded. Kings (seat 1) get nothing.
    expect(byseat[0]).toBe(88_800 + 15_540);
    expect(byseat[2]).toBe(20_000);
    expect(byseat[1]).toBeUndefined();
    expect(byseat[3]).toBeUndefined();
    expect(totalChips(hand)).toBe(before);
    expect(hand.seat(1)?.stack).toBe(0);
    expect(hand.seat(0)?.stack).toBe(88_800 + 15_540);
  });

  it("runs out the board when everyone left is all-in", () => {
    const hand = new HoldemHand({
      seats: [
        { seatIndex: 0, stack: 10_000 },
        { seatIndex: 1, stack: 8_000 },
      ],
      buttonSeat: 0,
      smallBlind: 500,
      bigBlind: 1000,
      rng: createSeededRng(4),
    });
    hand.act("raise", 10_000);
    hand.act("call");
    expect(hand.isBettingRoundInProgress()).toBe(false);
    expect(hand.areBettingRoundsCompleted()).toBe(false);
    hand.endBettingRound();
    expect(hand.communityCards()).toHaveLength(5);
    expect(hand.areBettingRoundsCompleted()).toBe(true);
    const payouts = hand.showdown();
    expect(payouts.reduce((s, p) => s + p.amount, 0)).toBe(18_000);
    // The uncalled 2_000 always returns to seat 0.
    expect(
      payouts.find((p) => p.seatIndex === 0)?.amount
    ).toBeGreaterThanOrEqual(2_000);
  });

  it("gives odd chips to the first winner left of the button on a tie", () => {
    // Board is a royal flush; everyone plays the board.
    const deck = deckWith([
      "2c",
      "3d", // seat 0 (button)
      "4c",
      "5d", // seat 1 (SB)
      "2h",
      "3s", // seat 2 (BB)
      "Ts",
      "Js",
      "Qs",
      "Ks",
      "As",
    ]);
    const hand = new HoldemHand({
      seats: [0, 1, 2].map((seatIndex) => ({ seatIndex, stack: 100 })),
      buttonSeat: 0,
      smallBlind: 1,
      bigBlind: 2,
      deck,
    });
    hand.act("raise", 4); // seat 0 (min raise: 2 + 2)
    hand.act("fold"); // seat 1 (SB's 1 chip stays in the pot)
    hand.act("call"); // seat 2
    for (let street = 0; street < 3; street += 1) {
      hand.endBettingRound();
      hand.act("check");
      hand.act("check");
    }
    hand.endBettingRound();
    expect(hand.potTotal()).toBe(9);
    const payouts = hand.showdown();
    // 9 chips, two winners: 4 each, odd chip to seat 2 (first left of button).
    expect(payouts.find((p) => p.seatIndex === 0)?.amount).toBe(4);
    expect(payouts.find((p) => p.seatIndex === 2)?.amount).toBe(5);
  });

  it("ends the hand immediately when everyone folds to one player", () => {
    const hand = new HoldemHand({
      seats: [0, 1, 2].map((seatIndex) => ({ seatIndex, stack: 10_000 })),
      buttonSeat: 0,
      smallBlind: 500,
      bigBlind: 1000,
      rng: createSeededRng(5),
    });
    hand.act("fold");
    hand.act("fold");
    expect(hand.isBettingRoundInProgress()).toBe(false);
    expect(hand.areBettingRoundsCompleted()).toBe(true);
    expect(hand.contenders()).toEqual([2]);
    const payouts = hand.showdown();
    expect(payouts).toEqual([{ seatIndex: 2, amount: 1500 }]);
    expect(hand.seat(2)?.stack).toBe(10_500);
  });

  it("conserves chips across many random hands", () => {
    const rng = createSeededRng(9);
    for (let trial = 0; trial < 60; trial += 1) {
      const seatCount = 2 + Math.floor(rng() * 5);
      const seats = Array.from({ length: seatCount }, (_, i) => ({
        seatIndex: i,
        stack: 1000 + Math.floor(rng() * 40_000),
      }));
      const hand = new HoldemHand({
        seats,
        buttonSeat: Math.floor(rng() * seatCount),
        smallBlind: 500,
        bigBlind: 1000,
        rng,
      });
      const before = totalChips(hand);
      let guard = 0;
      while (!hand.areBettingRoundsCompleted() && guard++ < 200) {
        while (hand.isBettingRoundInProgress()) {
          const legal = hand.legalActions()!;
          const action =
            legal.actions[Math.floor(rng() * legal.actions.length)];
          if ((action === "bet" || action === "raise") && legal.chipRange) {
            const { min, max } = legal.chipRange;
            hand.act(
              action,
              rng() < 0.3 ? max : min + Math.floor(rng() * (max - min + 1))
            );
          } else {
            hand.act(action);
          }
          expect(totalChips(hand)).toBe(before);
        }
        hand.endBettingRound();
      }
      const potBeforePayout = hand.potTotal();
      const payouts = hand.showdown();
      // Every chip in the middle was paid out, and nothing was created.
      expect(payouts.reduce((s, p) => s + p.amount, 0)).toBe(potBeforePayout);
      expect(hand.seatStates().reduce((s, x) => s + x.stack, 0)).toBe(before);
    }
  });
});

describe("derivePots", () => {
  it("keeps a folded seat's chips in the pots it reached without making it eligible", () => {
    const pots = derivePots([
      {
        seatIndex: 0,
        stack: 0,
        bet: 0,
        committed: 300,
        folded: false,
        allIn: true,
        holeCards: [],
      },
      {
        seatIndex: 1,
        stack: 0,
        bet: 0,
        committed: 200,
        folded: true,
        allIn: false,
        holeCards: [],
      },
      {
        seatIndex: 2,
        stack: 0,
        bet: 0,
        committed: 500,
        folded: false,
        allIn: false,
        holeCards: [],
      },
      {
        seatIndex: 3,
        stack: 0,
        bet: 0,
        committed: 500,
        folded: false,
        allIn: false,
        holeCards: [],
      },
    ]);
    expect(pots).toEqual([
      { size: 200 * 4 + 100 * 3, eligibleSeats: [0, 2, 3] },
      { size: 200 * 2, eligibleSeats: [2, 3] },
    ]);
    expect(pots.reduce((s, p) => s + p.size, 0)).toBe(300 + 200 + 500 + 500);
  });
});
