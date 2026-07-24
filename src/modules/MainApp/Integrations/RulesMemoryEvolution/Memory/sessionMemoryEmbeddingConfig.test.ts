import { describe, expect, it } from "vitest";

import {
  readSessionMemoryEmbeddingConfig,
  sessionMemoryEmbeddingFingerprint,
} from "./sessionMemoryEmbeddingConfig";

describe("session-memory embedding config", () => {
  it("uses Rust-aligned defaults for a missing integration slice", () => {
    expect(readSessionMemoryEmbeddingConfig(undefined)).toEqual({
      provider: "embedding_api",
      model: undefined,
      localBaseUrl: undefined,
      dimensions: undefined,
      minTokenDelta: 5000,
      minIntervalSecs: 300,
      requestTimeoutSecs: 20,
      maxInputChars: 48000,
    });
  });

  it("keeps only supported providers and creates a stable vector fingerprint", () => {
    const config = readSessionMemoryEmbeddingConfig({
      provider: "embedding_api",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });

    expect(sessionMemoryEmbeddingFingerprint(config)).toBe(
      "embedding_api:text-embedding-3-small:1536"
    );
    expect(
      readSessionMemoryEmbeddingConfig({ provider: "auto" }).provider
    ).toBe("embedding_api");
  });

  it("normalizes optional values and rejects invalid numeric settings", () => {
    expect(
      readSessionMemoryEmbeddingConfig({
        model: "  text-embedding-3-small  ",
        localBaseUrl: "   ",
        dimensions: 0,
        minTokenDelta: -1,
        minIntervalSecs: Number.NaN,
        requestTimeoutSecs: Infinity,
        maxInputChars: 0,
      })
    ).toMatchObject({
      model: "text-embedding-3-small",
      localBaseUrl: undefined,
      dimensions: undefined,
      minTokenDelta: 5000,
      minIntervalSecs: 300,
      requestTimeoutSecs: 20,
      maxInputChars: 48000,
    });
  });
});
