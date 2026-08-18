import { describe, expect, it } from "vitest";

import { PokerTableEngine } from "./PokerTableEngine";
import { createSeededRng } from "./cards";
import type { PlayerAction, PokerPlayer } from "./types";

const player = (
  id: string,
  kind: PokerPlayer["kind"] = "bot"
): PokerPlayer => ({
  id,
  name: id,
  kind,
  avatarHue: 0,
});

const BLINDS = { smallBlind: 500, bigBlind: 1000 };

function seatSix(engine: PokerTableEngine, stacks: number[]): void {
  stacks.forEach((stack, index) => {
    engine.sitDown(
      index,
      player(
        index === 0 ? "hero" : `bot${index}`,
        index === 0 ? "human" : "bot"
      ),
      stack
    );
  });
}

/**
 * Total chips on the table: stacks plus, mid-hand, live bets and pots.
 * (After a hand `potTotal` echoes the awarded pot for display, and the
 * stacks already contain it.)
 */
function chipsInPlay(engine: PokerTableEngine): number {
  const snap = engine.snapshot(0);
  const stacks = snap.seats.reduce((sum, seat) => sum + (seat?.stack ?? 0), 0);
  return stacks + (engine.isHandInProgress() ? snap.potTotal : 0);
}

/** Drive a hand to completion with a random legal action policy. */
function playRandomHand(engine: PokerTableEngine, rng: () => number): void {
  engine.startHand();
  while (engine.isHandInProgress()) {
    while (engine.isBettingRoundInProgress()) {
      const legal = engine.legalActions();
      if (!legal) throw new Error("expected legal actions");
      const action = legal.actions[Math.floor(rng() * legal.actions.length)];
      if ((action === "bet" || action === "raise") && legal.chipRange) {
        const { min, max } = legal.chipRange;
        const amount =
          rng() < 0.25 ? max : min + Math.floor(rng() * (max - min + 1));
        engine.act(action, amount);
      } else {
        engine.act(action as PlayerAction);
      }
    }
    engine.endBettingRound();
    if (engine.areBettingRoundsCompleted()) engine.showdown();
  }
}

describe("PokerTableEngine", () => {
  it("conserves chips across many random hands, including side pots", () => {
    const engine = new PokerTableEngine(BLINDS);
    seatSix(engine, [2130, 106000, 35800, 11100, 56400, 24200]);
    let total = chipsInPlay(engine);
    const rng = createSeededRng(7);
    let hands = 0;
    let rebuys = 0;
    let sawResult = false;
    while (engine.seatedCount() >= 2 && hands < 150) {
      playRandomHand(engine, rng);
      hands += 1;
      const result = engine.snapshot(0).lastResult;
      expect(result).not.toBeNull();
      if (result) {
        sawResult = true;
        const paid = result.entries.reduce((sum, e) => sum + e.amountWon, 0);
        expect(paid).toBe(result.potTotal);
      }
      // Like the controller: the hero re-buys, busted bots stand up.
      for (let seat = 0; seat < 6; seat += 1) {
        if (!engine.isSeated(seat) || engine.stackOf(seat) > 0) continue;
        expect(engine.isBusted(seat)).toBe(true);
        if (seat === 0) {
          engine.rebuy(0, 10000);
          total += 10000;
          rebuys += 1;
          expect(engine.isBusted(0)).toBe(false);
          expect(engine.stackOf(0)).toBe(10000);
        } else {
          engine.standUp(seat);
        }
      }
      // Busted players took 0 chips with them, so the total only moves by rebuys.
      expect(chipsInPlay(engine)).toBe(total);
    }
    expect(hands).toBeGreaterThan(5);
    expect(sawResult).toBe(true);
    // Hero started with 2 big blinds, so busting (and re-buying) is a given.
    expect(rebuys).toBeGreaterThan(0);
  });

  it("awards the pot without a showdown when everyone folds", () => {
    const engine = new PokerTableEngine(BLINDS);
    seatSix(engine, [10000, 10000, 10000]);
    engine.startHand();
    // 3-handed: button 0, SB 1, BB 2 → seat 0 acts first.
    expect(engine.playerToAct()).toBe(0);
    engine.act("fold");
    engine.act("fold");
    expect(engine.isBettingRoundInProgress()).toBe(false);
    engine.endBettingRound();
    expect(engine.areBettingRoundsCompleted()).toBe(true);
    const result = engine.showdown();
    expect(result.foldedOut).toBe(true);
    const winner = result.entries.find((e) => e.amountWon > 0);
    expect(winner?.seatIndex).toBe(2);
    expect(winner?.amountWon).toBe(1500);
    expect(winner?.revealedCards).toBeNull();
    const snap = engine.snapshot(0);
    expect(snap.phase).toBe("hand-complete");
    expect(snap.seats[2]?.stack).toBe(10500);
    // Hero's own cards stay visible in the result view.
    expect(snap.seats[0]?.holeCards).toHaveLength(2);
    // Bots' cards are never exposed when the hand folded out.
    expect(snap.seats[1]?.holeCards).toBeNull();
  });

  it("runs out the board and reveals contenders on an all-in showdown", () => {
    const engine = new PokerTableEngine(BLINDS);
    seatSix(engine, [10000, 8000]);
    engine.startHand();
    const legal = engine.legalActions();
    expect(legal?.actions).toContain("raise");
    engine.act("raise", legal!.chipRange!.max);
    engine.act("call");
    expect(engine.isBettingRoundInProgress()).toBe(false);
    engine.endBettingRound();
    // Everyone all-in: the engine dealt every remaining street at once.
    expect(engine.communityCards()).toHaveLength(5);
    expect(engine.areBettingRoundsCompleted()).toBe(true);
    const result = engine.showdown();
    expect(result.foldedOut).toBe(false);
    expect(result.board).toHaveLength(5);
    // Both contenders are revealed with a described hand.
    for (const entry of result.entries) {
      expect(entry.revealedCards).toHaveLength(2);
      expect(entry.handDescription).toBeTruthy();
    }
    expect(result.entries.reduce((s, e) => s + e.amountWon, 0)).toBe(
      result.potTotal
    );
    const snap = engine.snapshot(0);
    expect(snap.seats[1]?.holeCards).toHaveLength(2);
    expect(snap.communityCards).toHaveLength(5);
  });

  it("hides other players' hole cards from the viewer during the hand", () => {
    const engine = new PokerTableEngine(BLINDS);
    seatSix(engine, [10000, 10000, 10000]);
    engine.startHand();
    const snap = engine.snapshot(0);
    expect(snap.phase).toBe("betting");
    expect(snap.seats[0]?.holeCards).toHaveLength(2);
    expect(snap.seats[1]?.holeCards).toBeNull();
    expect(snap.seats[1]?.hasCards).toBe(true);
    expect(snap.dealerSeat).toBe(0);
    expect(snap.toAct).toBe(0);
    expect(snap.callAmount).toBe(1000);
    expect(snap.potTotal).toBe(1500);
  });

  it("tracks per-street last actions and clears them at the next street", () => {
    const engine = new PokerTableEngine(BLINDS);
    seatSix(engine, [10000, 10000, 10000]);
    engine.startHand();
    engine.act("raise", 3000);
    expect(engine.snapshot(0).seats[0]?.lastAction).toEqual({
      action: "raise",
      amount: 3000,
    });
    engine.act("call");
    expect(engine.snapshot(0).seats[1]?.lastAction).toEqual({
      action: "call",
      amount: 3000,
    });
    engine.act("fold");
    expect(engine.snapshot(0).seats[2]?.lastAction).toEqual({ action: "fold" });
    engine.endBettingRound();
    const flop = engine.snapshot(0);
    expect(flop.street).toBe("flop");
    expect(flop.seats[0]?.lastAction).toBeNull();
    expect(flop.seats[2]?.inHand).toBe(false);
    expect(flop.potTotal).toBe(7000);
  });

  it("clamps bet sizes into the legal range", () => {
    const engine = new PokerTableEngine(BLINDS);
    seatSix(engine, [10000, 10000]);
    engine.startHand();
    engine.act("raise", 999_999);
    expect(engine.snapshot(0).seats[0]?.betSize).toBe(10000);
  });

  it("returns the remaining stack when a player stands up", () => {
    const engine = new PokerTableEngine(BLINDS);
    seatSix(engine, [10000, 10000]);
    expect(engine.standUp(0)).toBe(10000);
    expect(engine.isSeated(0)).toBe(false);
    expect(engine.seatedCount()).toBe(1);
  });
});
