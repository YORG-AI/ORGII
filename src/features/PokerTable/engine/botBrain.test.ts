import { describe, expect, it } from "vitest";

import { type BotDecisionInput, decideBotAction } from "./botBrain";
import { type Card, createSeededRng } from "./cards";
import { chenScore, describeHand, estimateEquity } from "./handEvaluator";
import { BOT_PERSONAS, findPersona } from "./personas";

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

const balanced = findPersona("vector").style;

function base(overrides: Partial<BotDecisionInput>): BotDecisionInput {
  return {
    holeCards: [c("As"), c("Ah")],
    communityCards: [],
    street: "preflop",
    legalActions: {
      actions: ["fold", "call", "raise"],
      chipRange: { min: 2000, max: 50000 },
    },
    callAmount: 1000,
    potTotal: 1500,
    stack: 50000,
    betSize: 0,
    opponentsInHand: 4,
    bigBlind: 1000,
    style: balanced,
    rng: createSeededRng(1),
    equitySamples: 120,
    ...overrides,
  };
}

describe("handEvaluator", () => {
  it("scores starting hands on the Chen scale", () => {
    expect(chenScore([c("As"), c("Ah")])).toBe(20);
    expect(chenScore([c("As"), c("Ks")])).toBe(12);
    expect(chenScore([c("7c"), c("2d")])).toBe(-1);
    expect(chenScore([c("Ts"), c("9s")])).toBe(8);
  });

  it("describes made hands", () => {
    expect(
      describeHand([
        c("Kh"),
        c("Kd"),
        c("2s"),
        c("2c"),
        c("9h"),
        c("Qs"),
        c("3d"),
      ])
    ).toMatch(/Two Pair/);
    expect(describeHand([c("Kh"), c("Kd")])).toBeNull();
  });

  it("estimates equity roughly right for a monster vs. trash", () => {
    const rng = createSeededRng(3);
    const aces = estimateEquity({
      holeCards: [c("As"), c("Ah")],
      communityCards: [],
      opponents: 1,
      samples: 400,
      rng,
    });
    const trash = estimateEquity({
      holeCards: [c("7c"), c("2d")],
      communityCards: [],
      opponents: 1,
      samples: 400,
      rng,
    });
    expect(aces).toBeGreaterThan(0.75);
    expect(trash).toBeLessThan(0.45);
  });
});

describe("decideBotAction", () => {
  it("raises premium hands preflop with an aggressive persona", () => {
    const decision = decideBotAction(
      base({ style: findPersona("lambda").style, rng: () => 0.1 })
    );
    expect(decision.action).toBe("raise");
    expect(decision.amount).toBeGreaterThanOrEqual(2000);
    expect(decision.amount).toBeLessThanOrEqual(50000);
  });

  it("folds trash to a raise for a tight persona", () => {
    const decision = decideBotAction(
      base({
        holeCards: [c("7c"), c("2d")],
        callAmount: 3000,
        betSize: 0,
        style: findPersona("cipher").style,
        rng: () => 0.9,
      })
    );
    expect(decision.action).toBe("fold");
  });

  it("checks rather than folds when checking is free", () => {
    const decision = decideBotAction(
      base({
        holeCards: [c("7c"), c("2d")],
        callAmount: 0,
        legalActions: {
          actions: ["fold", "check", "raise"],
          chipRange: { min: 2000, max: 50000 },
        },
        rng: () => 0.99,
      })
    );
    expect(decision.action).toBe("check");
  });

  it("bets a strong made hand postflop when checked to", () => {
    const decision = decideBotAction(
      base({
        holeCards: [c("Ks"), c("Kh")],
        communityCards: [c("Kd"), c("7s"), c("2c")],
        street: "flop",
        callAmount: 0,
        potTotal: 6000,
        opponentsInHand: 1,
        legalActions: {
          actions: ["fold", "check", "bet"],
          chipRange: { min: 1000, max: 50000 },
        },
        style: findPersona("lambda").style,
        rng: () => 0.05,
      })
    );
    expect(decision.action).toBe("bet");
    expect(decision.amount).toBeGreaterThanOrEqual(1000);
  });

  it("folds a hopeless hand to a large river bet", () => {
    const decision = decideBotAction(
      base({
        holeCards: [c("3c"), c("2d")],
        communityCards: [c("Kd"), c("Qs"), c("8c"), c("5h"), c("9h")],
        street: "river",
        callAmount: 20000,
        potTotal: 24000,
        opponentsInHand: 1,
        legalActions: {
          actions: ["fold", "call", "raise"],
          chipRange: { min: 40000, max: 50000 },
        },
        // A constant rng would degenerate the equity sampler's shuffle, so
        // seed it and switch bluffing off to keep the decision deterministic.
        style: { ...balanced, bluffFrequency: 0 },
        rng: createSeededRng(5),
      })
    );
    expect(decision.action).toBe("fold");
  });

  it("only ever returns a legal action with an in-range size", () => {
    const rng = createSeededRng(11);
    for (const persona of BOT_PERSONAS) {
      for (let i = 0; i < 40; i += 1) {
        const facing = rng() < 0.5;
        const legalActions = facing
          ? {
              actions: ["fold", "call", "raise"] as const,
              chipRange: { min: 4000, max: 30000 },
            }
          : {
              actions: ["fold", "check", "bet"] as const,
              chipRange: { min: 1000, max: 30000 },
            };
        const decision = decideBotAction(
          base({
            holeCards: [c("Qd"), c("Jd")],
            communityCards: [c("Td"), c("4s"), c("8c")],
            street: "flop",
            callAmount: facing ? 2000 : 0,
            legalActions: {
              actions: [...legalActions.actions],
              chipRange: legalActions.chipRange,
            },
            style: persona.style,
            rng,
            equitySamples: 40,
          })
        );
        expect(legalActions.actions).toContain(decision.action);
        if (decision.amount !== undefined) {
          expect(decision.amount).toBeGreaterThanOrEqual(
            legalActions.chipRange.min
          );
          expect(decision.amount).toBeLessThanOrEqual(
            legalActions.chipRange.max
          );
        }
      }
    }
  });
});
