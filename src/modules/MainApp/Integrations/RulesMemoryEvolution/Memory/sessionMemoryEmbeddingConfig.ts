export const SESSION_MEMORY_EMBEDDING_PROVIDERS = [
  "disabled",
  "local_qwen",
  "local_coderank",
  "embedding_api",
] as const;

export type SessionMemoryEmbeddingProvider =
  (typeof SESSION_MEMORY_EMBEDDING_PROVIDERS)[number];

export const SESSION_MEMORY_RERANK_PROVIDERS = [
  "disabled",
  "zenmux_api",
  "local",
] as const;

export type SessionMemoryRerankProvider =
  (typeof SESSION_MEMORY_RERANK_PROVIDERS)[number];

export interface SessionMemoryEmbeddingConfig {
  provider: SessionMemoryEmbeddingProvider;
  model?: string;
  localBaseUrl?: string;
  dimensions?: number;
  minTokenDelta: number;
  minIntervalSecs: number;
  requestTimeoutSecs: number;
  maxInputChars: number;
}

export interface SessionMemoryRerankConfig {
  provider: SessionMemoryRerankProvider;
  model?: string;
  baseUrl?: string;
  requestTimeoutSecs: number;
}

const EMBEDDING_DEFAULTS: Omit<SessionMemoryEmbeddingConfig, "provider"> = {
  model: "qwen/qwen3-vl-embedding",
  localBaseUrl: undefined,
  dimensions: 1024,
  minTokenDelta: 5_000,
  minIntervalSecs: 300,
  requestTimeoutSecs: 20,
  maxInputChars: 48_000,
};

const RERANK_DEFAULTS: SessionMemoryRerankConfig = {
  provider: "zenmux_api",
  model: "qwen/qwen3-vl-rerank",
  baseUrl: undefined,
  requestTimeoutSecs: 20,
};

function finitePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function readSessionMemoryEmbeddingConfig(
  raw: unknown
): SessionMemoryEmbeddingConfig {
  const value = raw && typeof raw === "object" ? raw : {};
  const embedding = value as Record<string, unknown>;
  const provider = SESSION_MEMORY_EMBEDDING_PROVIDERS.includes(
    embedding.provider as SessionMemoryEmbeddingProvider
  )
    ? (embedding.provider as SessionMemoryEmbeddingProvider)
    : "embedding_api";

  return {
    provider,
    model:
      optionalText(embedding.model) ??
      (provider === "embedding_api" ? EMBEDDING_DEFAULTS.model : undefined),
    localBaseUrl: optionalText(embedding.localBaseUrl),
    dimensions:
      optionalPositiveNumber(embedding.dimensions) ??
      (provider === "embedding_api"
        ? EMBEDDING_DEFAULTS.dimensions
        : undefined),
    minTokenDelta: finitePositiveNumber(
      embedding.minTokenDelta,
      EMBEDDING_DEFAULTS.minTokenDelta
    ),
    minIntervalSecs: finitePositiveNumber(
      embedding.minIntervalSecs,
      EMBEDDING_DEFAULTS.minIntervalSecs
    ),
    requestTimeoutSecs: finitePositiveNumber(
      embedding.requestTimeoutSecs,
      EMBEDDING_DEFAULTS.requestTimeoutSecs
    ),
    maxInputChars: finitePositiveNumber(
      embedding.maxInputChars,
      EMBEDDING_DEFAULTS.maxInputChars
    ),
  };
}

export function readSessionMemoryRerankConfig(
  raw: unknown
): SessionMemoryRerankConfig {
  const value = raw && typeof raw === "object" ? raw : {};
  const rerank = value as Record<string, unknown>;
  const provider = SESSION_MEMORY_RERANK_PROVIDERS.includes(
    rerank.provider as SessionMemoryRerankProvider
  )
    ? (rerank.provider as SessionMemoryRerankProvider)
    : RERANK_DEFAULTS.provider;

  return {
    provider,
    model:
      optionalText(rerank.model) ??
      (provider === "zenmux_api" ? RERANK_DEFAULTS.model : undefined),
    baseUrl: optionalText(rerank.baseUrl),
    requestTimeoutSecs: finitePositiveNumber(
      rerank.requestTimeoutSecs,
      RERANK_DEFAULTS.requestTimeoutSecs
    ),
  };
}

/** The identity stored alongside vectors; changing it requires re-embedding. */
export function sessionMemoryEmbeddingFingerprint(
  config: SessionMemoryEmbeddingConfig
): string {
  return [
    config.provider,
    config.model ?? "default",
    config.dimensions ?? "auto",
  ].join(":");
}
