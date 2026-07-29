import { describe, expect, it } from "vitest";

import {
  MAX_UNLOADED_TURN_RETRIES,
  decideUnloadedTurnRetry,
} from "./unloadedTurnRetry";

describe("decideUnloadedTurnRetry", () => {
  it("allows a retry starting from zero attempts", () => {
    expect(decideUnloadedTurnRetry(0)).toEqual({
      shouldRetry: true,
      nextAttempt: 1,
    });
  });

  it("keeps allowing retries up to the configured max", () => {
    expect(decideUnloadedTurnRetry(1)).toEqual({
      shouldRetry: true,
      nextAttempt: 2,
    });
  });

  it("stops retrying once the attempt count reaches the max", () => {
    expect(decideUnloadedTurnRetry(MAX_UNLOADED_TURN_RETRIES)).toEqual({
      shouldRetry: false,
      nextAttempt: MAX_UNLOADED_TURN_RETRIES,
    });
  });

  it("never allows a retry count to exceed the max even if called past it", () => {
    expect(decideUnloadedTurnRetry(MAX_UNLOADED_TURN_RETRIES + 5)).toEqual({
      shouldRetry: false,
      nextAttempt: MAX_UNLOADED_TURN_RETRIES + 5,
    });
  });

  it("honors a custom maxRetries override", () => {
    expect(decideUnloadedTurnRetry(0, 0)).toEqual({
      shouldRetry: false,
      nextAttempt: 0,
    });
    expect(decideUnloadedTurnRetry(3, 5)).toEqual({
      shouldRetry: true,
      nextAttempt: 4,
    });
  });

  it("default max is 2 bounded retries", () => {
    expect(MAX_UNLOADED_TURN_RETRIES).toBe(2);
  });
});
