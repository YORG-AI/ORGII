/**
 * Shared enum / literal schemas for key validation Tauri commands.
 *
 * CLI agent types, API provider types, the unified model type union,
 * auth methods, native harness types, health status, and the
 * session-level enums (merge status, price tier). Split out of
 * `validation.ts` — see that file for the full export surface.
 */
import { z } from "zod/v4";

// ============================================================================
// Shared enums / literals
// ============================================================================

/** CLI agent type constants for type-safe usage */
export const CLI_AGENT = {
  CURSOR: "cursor_cli",
  CLAUDE_CODE: "claude_code",
  CODEX: "codex",
  COPILOT: "copilot",
  KIRO: "kiro",
  KIMI: "kimi_cli",
  OPENCODE: "opencode",
  AIDER: "aider",
  GOOSE: "goose",
  AMP: "amp",
  CLINE: "cline",
  KILO: "kilo",
  GROK: "grok_cli",
  DEVIN: "devin",
  ROVO: "rovo",
  HERMES: "hermes",
  OPENCLAW: "openclaw",
  AUG: "aug",
  CODEBUFF: "codebuff",
  QWEN_CODE: "qwen_code",
  MIMO_CODE: "mimo_code",
  ANTIGRAVITY: "antigravity",
  CONTINUE: "continue_cli",
  DROID: "droid",
  MISTRAL_VIBE: "mistral_vibe",
  AUTOHAND: "autohand",
  OMP: "omp",
  PI: "pi",
  QODER_CLI: "qoder_cli",
  TRAE_CLI: "trae_cli",
} as const;

/** CLI-based coding agents (external processes managed by the app). */
export const CliAgentTypeSchema = z.union([
  z.literal("cursor_cli"),
  z.literal("claude_code"),
  z.literal("codex"),
  z.literal("copilot"),
  z.literal("kiro"),
  z.literal("kimi_cli"),
  z.literal("opencode"),
  z.literal("aider"),
  z.literal("goose"),
  z.literal("amp"),
  z.literal("cline"),
  z.literal("kilo"),
  z.literal("grok_cli"),
  z.literal("devin"),
  z.literal("rovo"),
  z.literal("hermes"),
  z.literal("openclaw"),
  z.literal("aug"),
  z.literal("codebuff"),
  z.literal("qwen_code"),
  z.literal("mimo_code"),
  z.literal("antigravity"),
  z.literal("continue_cli"),
  z.literal("droid"),
  z.literal("mistral_vibe"),
  z.literal("autohand"),
  z.literal("omp"),
  z.literal("pi"),
  z.literal("qoder_cli"),
  z.literal("trae_cli"),
]);

/** Direct API key providers (REST API, no child process). */
export const ApiProviderTypeSchema = z.union([
  z.literal("anthropic_api"),
  z.literal("openai_api"),
  z.literal("atlascloud_api"),
  z.literal("deepseek_api"),
  z.literal("gemini_api"),
  z.literal("groq_api"),
  z.literal("xai_api"),
  z.literal("zhipu_api"),
  z.literal("dashscope_api"),
  z.literal("moonshot_api"),
  z.literal("openrouter_api"),
  z.literal("zenmux_api"),
  z.literal("minimax_api"),
  z.literal("longcat_api"),
  z.literal("siliconflow_api"),
  z.literal("modelscope_api"),
  z.literal("aihubmix_api"),
  z.literal("cherryin_api"),
  z.literal("bedrock_api"),
  z.literal("custom_api"),
  z.literal("vllm_api"),
  z.literal("azure_openai_api"),
  z.literal("azure_anthropic_api"),
  z.literal("orgii_orchestrator"),
]);

/**
 * Unified model type — CLI agents + API providers + short aliases.
 * Use `CliAgentType` or `ApiProviderType` when the domain is known.
 */
export const ModelTypeSchema = z.union([
  CliAgentTypeSchema,
  ApiProviderTypeSchema,
  // Short aliases (backend accepts these; used by validation convenience functions)
  z.literal("openai"),
  z.literal("anthropic"),
  z.literal("google"),
]);

export const AuthMethodSchema = z.union([
  z.literal("api_key"),
  z.literal("oauth"),
]);

export const NATIVE_HARNESS_TYPE = {
  CURSOR: "cursor_native",
} as const;

export const NativeHarnessTypeSchema = z.union([
  z.literal(NATIVE_HARNESS_TYPE.CURSOR),
]);

export const HealthStatusSchema = z.union([
  z.literal("valid"),
  z.literal("degraded"),
  z.literal("invalid"),
  z.literal("unknown"),
]);

// ============================================================================
// Session enums
// ============================================================================

/** Merge status for worktree sessions */
export const MergeStatusSchema = z.enum([
  "pending",
  "merged",
  "conflict",
  "skipped",
  "failed",
]);

/** Price tier for market sessions */
export const PriceTierSchema = z.enum(["basic", "standard", "premium", "vip"]);
