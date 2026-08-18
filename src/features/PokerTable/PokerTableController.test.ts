import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PokerTableController } from "./PokerTableController";
import { createSeededRng } from "./engine/cards";
import type { PokerPlayer } from "./engine/types";

const HERO: PokerPlayer = {
  id: "user:me",
  name: "hours",
  kind: "human",
  avatarHue: 0,
};
const BLINDS = { smallBlind: 500, bigBlind: 1000 };

function makeController(
  overrides: Partial<ConstructorParameters<typeof PokerTableController>[0]> = {}
) {
  const bankrollLog: number[] = [];
  const controller = new PokerTableController({
    hero: HERO,
    blinds: BLINDS,
    buyIn: 100_000,
    bankroll: 500_000,
    speed: "fast",
    rng: createSeededRng(42),
    now: () => Date.now(),
    onBankrollChange: (v) => bankrollLog.push(v),
    ...overrides,
  });
  return { controller, bankrollLog };
}

/**
 * Advance fake time while auto-answering the hero with a passive action
 * (and re-buying when a calling station inevitably busts).
 */
function playHeroPassively(
  controller: PokerTableController,
  ms: number,
  step = 50
): void {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    vi.advanceTimersByTime(step);
    if (controller.getState().awaitingRebuy) controller.rebuy(100_000);
    if (controller.isHeroToAct()) {
      const legal = controller.getState().snapshot.legalActions;
      if (legal?.actions.includes("check")) controller.heroAct("check");
      else controller.heroAct("call");
    }
  }
}

describe("PokerTableController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("seats hero + 5 bots, buys in from the bankroll and deals a hand", () => {
    const { controller, bankrollLog } = makeController();
    controller.start();
    const state = controller.getState();
    expect(bankrollLog).toEqual([400_000]);
    expect(state.snapshot.seats.filter(Boolean)).toHaveLength(6);
    expect(state.snapshot.seats[0]?.player.kind).toBe("human");
    expect(state.snapshot.seats[1]?.player.kind).toBe("bot");
    expect(state.snapshot.phase).toBe("idle");
    vi.advanceTimersByTime(300);
    expect(controller.getState().snapshot.phase).toBe("betting");
    expect(controller.getState().snapshot.handNumber).toBe(1);
    controller.dispose();
  });

  it("plays whole hands on its own when the hero only checks/calls", () => {
    const { controller } = makeController();
    controller.start();
    playHeroPassively(controller, 60_000);
    const state = controller.getState();
    expect(state.snapshot.handNumber).toBeGreaterThan(3);
    expect(state.handHistory.length).toBeGreaterThan(2);
    // Every recorded hand paid out exactly its pot.
    for (const entry of state.handHistory) {
      const paid = entry.winners.reduce((sum, w) => sum + w.amount, 0);
      expect(paid).toBe(entry.potTotal);
    }
    controller.dispose();
  });

  it("notifies subscribers on every state change", () => {
    const { controller } = makeController();
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.start();
    vi.advanceTimersByTime(2000);
    expect(listener.mock.calls.length).toBeGreaterThan(2);
    controller.dispose();
  });

  it("reveals a run-out board one street at a time", () => {
    const { controller } = makeController({ botCount: 1 });
    controller.start();
    vi.advanceTimersByTime(300);
    // Hero shoves preflop; the bot policy will call sooner or later across hands.
    let sawStagedReveal = false;
    let lastRevealed = 0;
    for (
      let elapsed = 0;
      elapsed < 120_000 && !sawStagedReveal;
      elapsed += 25
    ) {
      vi.advanceTimersByTime(25);
      const state = controller.getState();
      if (
        state.snapshot.communityCards.length === 5 &&
        state.revealedCommunity > lastRevealed
      ) {
        // Reached 5 dealt cards but the UI reveal count trails behind → staged.
        if (state.revealedCommunity < 5) sawStagedReveal = true;
      }
      lastRevealed = state.revealedCommunity;
      if (controller.isHeroToAct()) {
        const legal = state.snapshot.legalActions;
        if (legal?.chipRange && legal.actions.includes("raise")) {
          controller.heroAct("raise", legal.chipRange.max);
        } else if (legal?.chipRange && legal.actions.includes("bet")) {
          controller.heroAct("bet", legal.chipRange.max);
        } else {
          controller.heroAct("call");
        }
      }
    }
    expect(sawStagedReveal).toBe(true);
    controller.dispose();
  });

  it("pauses for a rebuy when the hero busts, then resumes", () => {
    const { controller, bankrollLog } = makeController({
      buyIn: 2_000,
      botCount: 1,
      // A bot that always calls: every hero shove is a coin flip.
      decideBot: ({ legalActions }) => ({
        action: legalActions.actions.includes("call")
          ? "call"
          : legalActions.actions.includes("check")
            ? "check"
            : "fold",
      }),
    });
    controller.start();
    // Shove every time; with a 2 BB stack the hero busts quickly.
    let busted = false;
    for (let elapsed = 0; elapsed < 300_000 && !busted; elapsed += 25) {
      vi.advanceTimersByTime(25);
      if (controller.getState().awaitingRebuy) busted = true;
      else if (controller.isHeroToAct()) {
        const legal = controller.getState().snapshot.legalActions;
        if (
          legal?.chipRange &&
          (legal.actions.includes("raise") || legal.actions.includes("bet"))
        ) {
          controller.heroAct(
            legal.actions.includes("raise") ? "raise" : "bet",
            legal.chipRange.max
          );
        } else controller.heroAct("call");
      }
    }
    expect(busted).toBe(true);
    const handWhenBusted = controller.getState().snapshot.handNumber;
    // Nothing moves while waiting.
    vi.advanceTimersByTime(5_000);
    expect(controller.getState().snapshot.handNumber).toBe(handWhenBusted);
    controller.rebuy(50_000);
    expect(controller.getState().awaitingRebuy).toBe(false);
    expect(bankrollLog.at(-1)).toBe(500_000 - 2_000 - 50_000);
    playHeroPassively(controller, 5_000);
    expect(controller.getState().snapshot.handNumber).toBeGreaterThan(
      handWhenBusted
    );
    controller.dispose();
  });

  it("returns the hero's stack to the bankroll on leave", () => {
    const { controller, bankrollLog } = makeController();
    controller.start();
    const stack = controller.getState().snapshot.seats[0]?.stack ?? 0;
    const returned = controller.leave();
    expect(returned).toBe(stack);
    expect(bankrollLog.at(-1)).toBe(500_000);
    expect(controller.isDisposed()).toBe(true);
    // No further ticks after leaving.
    const listener = vi.fn();
    controller.subscribe(listener);
    vi.advanceTimersByTime(10_000);
    expect(listener).not.toHaveBeenCalled();
  });

  it("leaves no timers or listeners behind after dispose", () => {
    const { controller } = makeController();
    const unsubscribe = controller.subscribe(() => {});
    controller.start();
    playHeroPassively(controller, 5_000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    // A late unsubscribe from React is harmless.
    unsubscribe();
    // And a stray call into a disposed controller schedules nothing.
    controller.heroAct("fold");
    controller.rebuy(1_000);
    controller.dealNextHand();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies a stakes change at the next hand", () => {
    const { controller } = makeController();
    controller.start();
    vi.advanceTimersByTime(300);
    controller.setBlinds({ smallBlind: 2000, bigBlind: 4000 });
    expect(controller.getState().snapshot.blinds.bigBlind).toBe(1000);
    const hand = controller.getState().snapshot.handNumber;
    playHeroPassively(controller, 30_000);
    expect(controller.getState().snapshot.handNumber).toBeGreaterThan(hand);
    expect(controller.getState().snapshot.blinds.bigBlind).toBe(4000);
    controller.dispose();
  });
});
