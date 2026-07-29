import { describe, expect, it } from "vitest";

import {
  readSessionMemoryEmbeddingConfig,
  readSessionMemoryRerankConfig,
  sessionMemoryEmbeddingFingerprint,
} from "./sessionMemoryEmbeddingConfig";

describe("session-memory semantic model config", () => {
  it("uses Rust-aligned defaults for missing integration slices", () => {
    expect(readSessionMemoryEmbeddingConfig(undefined)).toEqual({
      provider: "embedding_api",
      model: "qwen/qwen3-vl-embedding",
      localBaseUrl: undefined,
      dimensions: 1024,
      minTokenDelta: 5000,
      minIntervalSecs: 300,
      requestTimeoutSecs: 20,
      maxInputChars: 48000,
    });
    expect(readSessionMemoryRerankConfig(undefined)).toEqual({
      provider: "zenmux_api",
      model: "qwen/qwen3-vl-rerank",
      baseUrl: undefined,
      requestTimeoutSecs: 20,
    });
  });

  it("normalizes invalid embedding values and keeps a stable fingerprint", () => {
    const config = readSessionMemoryEmbeddingConfig({
      provider: "embedding_api",
      model: " text-embedding-3-small ",
      dimensions: 1536,
      minTokenDelta: -1,
      requestTimeoutSecs: Infinity,
    });
    expect(sessionMemoryEmbeddingFingerprint(config)).toBe(
      "embedding_api:text-embedding-3-small:1536"
    );
    expect(config).toMatchObject({
      minTokenDelta: 5000,
      requestTimeoutSecs: 20,
    });
    expect(
      readSessionMemoryEmbeddingConfig({ provider: "auto" }).provider
    ).toBe("embedding_api");
  });

  it("preserves explicit local and disabled rerank semantics", () => {
    expect(
      readSessionMemoryRerankConfig({
        provider: "local",
        model: " local-reranker ",
        baseUrl: " http://localhost:9877 ",
        requestTimeoutSecs: 7,
      })
    ).toEqual({
      provider: "local",
      model: "local-reranker",
      baseUrl: "http://localhost:9877",
      requestTimeoutSecs: 7,
    });
    expect(readSessionMemoryRerankConfig({ provider: "disabled" })).toEqual({
      provider: "disabled",
      model: undefined,
      baseUrl: undefined,
      requestTimeoutSecs: 20,
    });
  });

  it("rejects unknown providers and invalid rerank values", () => {
    expect(
      readSessionMemoryRerankConfig({
        provider: "auto",
        model: " ",
        baseUrl: " ",
        requestTimeoutSecs: 0,
      })
    ).toEqual({
      provider: "zenmux_api",
      model: "qwen/qwen3-vl-rerank",
      baseUrl: undefined,
      requestTimeoutSecs: 20,
    });
  });

  it("round-trips backend-shaped objects without changing valid values", () => {
    const embedding = {
      provider: "local_qwen",
      model: "Qwen3-Embedding-0.6B",
      localBaseUrl: "http://127.0.0.1:8000/v1",
      dimensions: 1024,
      minTokenDelta: 7000,
      minIntervalSecs: 60,
      requestTimeoutSecs: 15,
      maxInputChars: 32000,
    } as const;
    const rerank = {
      provider: "zenmux_api",
      model: "qwen/qwen3-vl-rerank",
      baseUrl: "https://zenmux.ai/api/v1",
      requestTimeoutSecs: 25,
    } as const;
    expect(readSessionMemoryEmbeddingConfig(embedding)).toEqual(embedding);
    expect(readSessionMemoryRerankConfig(rerank)).toEqual(rerank);
  });
});
