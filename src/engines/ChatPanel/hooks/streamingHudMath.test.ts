/**
 * computeStreamingHud — streaming telemetry math regression tests.
 *
 * Covers the pure derivation extracted from `useStreamingHud`:
 *   - token estimate from delta length (chars / 4)
 *   - tokens/s only after a minimum sample window
 *   - ETA only while below the target answer length, and never negative
 */
import { describe, expect, it } from "vitest";

import { computeStreamingHud } from "./streamingHudMath";

describe("computeStreamingHud", () => {
  it("estimates tokens from delta length at ~4 chars/token", () => {
    const hud = computeStreamingHud(400, 5_000);
    expect(hud.tokens).toBe(100);
    expect(hud.active).toBe(true);
  });

  it("withholds tokens/s until the minimum sample window elapses", () => {
    const tooEarly = computeStreamingHud(400, 500);
    expect(tooEarly.tokensPerSec).toBeNull();
    expect(tooEarly.etaSecs).toBeNull();

    const ready = computeStreamingHud(400, 2_000);
    expect(ready.tokensPerSec).toBe(50);
  });

  it("derives elapsed seconds by flooring the millisecond duration", () => {
    expect(computeStreamingHud(40, 2_900).elapsedSecs).toBe(2);
    expect(computeStreamingHud(40, 3_000).elapsedSecs).toBe(3);
  });

  it("emits an ETA only while below the target answer length", () => {
    // 100 tokens at 50 tok/s → 500 remaining → 10s ETA.
    const midStream = computeStreamingHud(400, 2_000);
    expect(midStream.etaSecs).toBe(10);

    // Past the target length → ETA suppressed (no negative countdown).
    const longAnswer = computeStreamingHud(4_000, 5_000);
    expect(longAnswer.tokens).toBeGreaterThan(600);
    expect(longAnswer.etaSecs).toBeNull();
  });

  it("clamps negative or zero inputs without producing NaN", () => {
    const negative = computeStreamingHud(-100, -500);
    expect(negative.tokens).toBe(0);
    expect(negative.elapsedSecs).toBe(0);
    expect(negative.tokensPerSec).toBeNull();
    expect(negative.etaSecs).toBeNull();
  });
});
