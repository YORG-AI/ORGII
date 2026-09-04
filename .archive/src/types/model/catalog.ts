/**
 * AI Model Catalog Types
 *
 * Descriptive metadata for entries in the multimodal model catalog —
 * modalities, reasoning, pricing, context window, etc. These are
 * provider-agnostic and consumed by the BYOK key vault model preview.
 */
import type { IconProvider } from "@src/components/ModelIcon/config";

export type { IconProvider } from "@src/components/ModelIcon/config";

export type InputModality = "text" | "image" | "audio" | "video" | "file";
export type OutputModality = "text" | "image" | "audio" | "video" | "file";

export type ReasoningMode = "none" | "toggleable" | "always_on";

export type ModelSeries =
  | "gpt"
  | "claude"
  | "gemini"
  | "deepseek"
  | "qwen"
  | "llama"
  | "grok"
  | "mistral"
  | "kimi"
  | "glm"
  | "doubao"
  | "minimax"
  | "other";

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  provider: IconProvider;
  providerName: string;
  series: ModelSeries;
  description: string;
  inputModalities: InputModality[];
  outputModalities: OutputModality[];
  pricing: ModelPricing;
  contextLength: number;
  maxOutput: number;
  reasoning: ReasoningMode;
  releaseDate?: string;

  /** Market data — populated by the archived market UI, absent in OSS. */
  listingsCount?: number;
  agentTypes?: string[];
  marketInputPrice?: {
    min: number | null;
    max: number | null;
    official: number | null;
  };
  marketOutputPrice?: {
    min: number | null;
    max: number | null;
    official: number | null;
  };
  minRatio?: number | null;
  medianRatio?: number | null;
  trend?: "up" | "down" | "flat" | null;
  trendDelta?: number | null;
  tier?: string | null;
  strengths?: string[] | null;
}
