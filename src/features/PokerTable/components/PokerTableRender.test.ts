/**
 * Static-render smoke tests: drive a real controller to specific states
 * and assert the felt / action bar render the right things (seats, cards,
 * legal buttons, rebuy prompt, result line). Same renderToStaticMarkup +
 * mocked react-i18next idiom as ChatPanelTabBar.test.ts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PokerTableController } from "../PokerTableController";
import { createSeededRng } from "../engine/cards";
import type { PokerPlayer } from "../engine/types";
import PokerActionBar from "./PokerActionBar";
import PokerFelt from "./PokerFelt";
import PokerHandHistory from "./PokerHandHistory";
import PokerTableHeader from "./PokerTableHeader";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}(${Object.values(params).join(",")})` : key,
  }),
}));

const HERO: PokerPlayer = {
  id: "user:me",
  name: "hours",
  kind: "human",
  avatarHue: 0,
};

function controllerAtHeroTurn() {
  const controller = new PokerTableController({
    hero: HERO,
    blinds: { smallBlind: 500, bigBlind: 1000 },
    buyIn: 100_000,
    bankroll: 500_000,
    speed: "fast",
    rng: createSeededRng(7),
    now: () => 1_000_000,
  });
  controller.start();
  for (
    let elapsed = 0;
    elapsed < 30_000 && !controller.isHeroToAct();
    elapsed += 25
  ) {
    vi.advanceTimersByTime(25);
  }
  expect(controller.isHeroToAct()).toBe(true);
  return controller;
}

function renderFelt(controller: PokerTableController): string {
  const state = controller.getState();
  return renderToStaticMarkup(
    createElement(PokerFelt, {
      snapshot: state.snapshot,
      heroSeat: state.heroSeat,
      revealedCommunity: state.revealedCommunity,
      thinkingSince: state.thinkingSince,
    })
  );
}

function renderActionBar(controller: PokerTableController): string {
  const state = controller.getState();
  return renderToStaticMarkup(
    createElement(PokerActionBar, {
      snapshot: state.snapshot,
      heroSeat: state.heroSeat,
      awaitingRebuy: state.awaitingRebuy,
      bankroll: state.bankroll,
      buyIn: 100_000,
      onAct: () => {},
      onRebuy: () => {},
      onResetBankroll: () => {},
      onDealNext: () => {},
    })
  );
}

describe("PokerTable rendering", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renders six seats, the hero's two face-up cards and face-down bot cards", () => {
    const controller = controllerAtHeroTurn();
    const markup = renderFelt(controller);
    for (let seat = 0; seat < 6; seat += 1) {
      expect(markup).toContain(`data-testid="poker-seat-${seat}"`);
    }
    // Hero's cards are face-up (aria-label "<rank> of <suit>"), bots' are face-down.
    const faceUp =
      markup.match(
        /aria-label="(10|[2-9]|[JQKA]) of (clubs|diamonds|hearts|spades)"/g
      ) ?? [];
    expect(faceUp).toHaveLength(2);
    expect(
      (markup.match(/aria-label="face-down card"/g) ?? []).length
    ).toBeGreaterThanOrEqual(2);
    // Pot pill, dealer button and the thinking indicator for the hero.
    expect(markup).toContain("pokerTable.potLabel");
    expect(markup).toContain('aria-label="dealer"');
    expect(markup).toContain("pokerTable.thinking(");
    controller.dispose();
  });

  it("uses shared selects for stakes and table speed", () => {
    const markup = renderToStaticMarkup(
      createElement(PokerTableHeader, {
        blinds: { smallBlind: 500, bigBlind: 1000 },
        handNumber: 3,
        settings: { stakesId: "0.5/1", speed: "normal" },
        historyOpen: false,
        onToggleHistory: () => {},
        onChangeStakes: () => {},
        onChangeSpeed: () => {},
        onLeave: () => {},
        onClose: () => {},
      })
    );

    expect(markup.match(/role="combobox"/g)).toHaveLength(2);
    expect(markup).toContain('data-testid="poker-stakes-select"');
    expect(markup).toContain('aria-label="pokerTable.settings.stakes"');
    expect(markup).toContain('data-testid="poker-speed-select"');
    expect(markup).toContain('aria-label="pokerTable.settings.speed"');
    expect(markup).toContain("pokerTable.header.title(0.5/1)");
    expect(markup).toContain("pokerTable.settings.speed_normal");
  });

  it("offers exactly the legal actions with the sizing controls when it is the hero's turn", () => {
    const controller = controllerAtHeroTurn();
    const legal = controller.getState().snapshot.legalActions!;
    const markup = renderActionBar(controller);
    expect(markup).toContain('data-testid="poker-action-bar"');
    expect(markup).toContain("pokerTable.actions.fold");
    if (legal.actions.includes("check")) {
      expect(markup).toContain("pokerTable.actions.check");
    } else {
      expect(markup).toContain("pokerTable.actions.call(");
    }
    if (legal.chipRange) {
      expect(markup).toContain("25%");
      expect(markup).toContain("133%");
      expect(markup).toMatch(/pokerTable\.actions\.(bet|raise|allIn)\(/);
    }
    controller.dispose();
  });

  it("shows the waiting line when a bot is to act and the result line after a hand", () => {
    const controller = controllerAtHeroTurn();
    // Fold; a bot acts next.
    controller.heroAct("fold");
    if (
      !controller.isHeroToAct() &&
      controller.getState().snapshot.toAct !== null
    ) {
      expect(renderActionBar(controller)).toContain("pokerTable.waitingFor(");
    }
    // Let the hand finish; the felt shows a winner and the history lists it.
    for (let elapsed = 0; elapsed < 60_000; elapsed += 25) {
      vi.advanceTimersByTime(25);
      if (controller.getState().snapshot.phase === "hand-complete") break;
      if (controller.isHeroToAct()) controller.heroAct("fold");
    }
    expect(controller.getState().snapshot.phase).toBe("hand-complete");
    expect(renderFelt(controller)).toMatch(/pokerTable\.result\.wins(With)?\(/);
    expect(renderActionBar(controller)).toContain("pokerTable.nextHand");
    const history = renderToStaticMarkup(
      createElement(PokerHandHistory, {
        entries: controller.getState().handHistory,
      })
    );
    expect(history).toContain("pokerTable.header.hand(1)");
    controller.dispose();
  });

  it("shows the rebuy prompt when the hero is out of chips", () => {
    const controller = new PokerTableController({
      hero: HERO,
      blinds: { smallBlind: 500, bigBlind: 1000 },
      buyIn: 100_000,
      bankroll: 0,
      speed: "fast",
      rng: createSeededRng(1),
    });
    controller.start();
    expect(controller.getState().awaitingRebuy).toBe(true);
    const markup = renderActionBar(controller);
    expect(markup).toContain("pokerTable.rebuy.title");
    expect(markup).toContain("pokerTable.rebuy.reset");
    controller.dispose();
  });
});
