export const SESSION_MEMORY_EMBEDDING_PROVIDERS = [
  "disabled",
  "local_qwen",
  "local_coderank",
  "embedding_api",
] as const;

export type SessionMemoryEmbeddingProvider =
  (typeof SESSION_MEMORY_EMBEDDING_PROVIDERS)[number];

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

const DEFAULTS: Omit<SessionMemoryEmbeddingConfig, "provider"> = {
  model: undefined,
  localBaseUrl: undefined,
  dimensions: undefined,
  minTokenDelta: 5_000,
  minIntervalSecs: 300,
  requestTimeoutSecs: 20,
  maxInputChars: 48_000,
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
    model: optionalText(embedding.model),
    localBaseUrl: optionalText(embedding.localBaseUrl),
    dimensions: optionalPositiveNumber(embedding.dimensions),
    minTokenDelta: finitePositiveNumber(
      embedding.minTokenDelta,
      DEFAULTS.minTokenDelta
    ),
    minIntervalSecs: finitePositiveNumber(
      embedding.minIntervalSecs,
      DEFAULTS.minIntervalSecs
    ),
    requestTimeoutSecs: finitePositiveNumber(
      embedding.requestTimeoutSecs,
      DEFAULTS.requestTimeoutSecs
    ),
    maxInputChars: finitePositiveNumber(
      embedding.maxInputChars,
      DEFAULTS.maxInputChars
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
