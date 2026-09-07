/**
 * ModelIcon Configuration
 *
 * Unified icon system for all AI model providers and agents.
 *
 * This is the single source of truth for icon lookups. It supports:
 * - `ModelType` (business logic) → icon lookup via `getIconProvider()`
 * - `IconProvider` (UI layer) → direct icon lookup
 * - Model name string → icon inference via `getIconProviderFromModelName()`
 */
import {
  type FC,
  type Ref,
  type SVGProps,
  createElement,
  forwardRef,
} from "react";

import type { ModelType } from "@src/api/types/keys";
import AiderIcon from "@src/assets/modelIcons/aider.svg?url";
import AiHubMixIcon from "@src/assets/modelIcons/aihubmix.svg?url";
import AmpIcon from "@src/assets/modelIcons/amp.svg?url";
import AntigravityIcon from "@src/assets/modelIcons/antigravity.svg?url";
import AtlasCloudIcon from "@src/assets/modelIcons/atlascloud.svg";
import AugmentIcon from "@src/assets/modelIcons/augment.svg";
import AutoHandIcon from "@src/assets/modelIcons/autohand.svg";
import AWSIcon from "@src/assets/modelIcons/aws.svg";
import AzureIcon from "@src/assets/modelIcons/azure.svg?url";
import BaichuanIcon from "@src/assets/modelIcons/baichuan.svg?url";
import ByteDanceIcon from "@src/assets/modelIcons/bytedance.svg?url";
import CherryInIcon from "@src/assets/modelIcons/cherryin.svg?url";
import ClaudeIcon from "@src/assets/modelIcons/claude.svg?url";
import ClineIcon from "@src/assets/modelIcons/cline.svg";
import CohereIcon from "@src/assets/modelIcons/cohere.svg?url";
import ContinueIcon from "@src/assets/modelIcons/continue.svg";
import CopilotIcon from "@src/assets/modelIcons/copilot.svg";
import CursorIcon from "@src/assets/modelIcons/cursor.svg";
import CustomGatewayIcon from "@src/assets/modelIcons/custom.svg";
import DeepSeekIcon from "@src/assets/modelIcons/deepseek.svg?url";
import DevinIcon from "@src/assets/modelIcons/devin.svg?url";
import DoubaoIcon from "@src/assets/modelIcons/doubao.svg?url";
import DroidIcon from "@src/assets/modelIcons/droid.svg";
import GeminiIcon from "@src/assets/modelIcons/gemini";
import GooseIcon from "@src/assets/modelIcons/goose.svg";
import GrokIcon from "@src/assets/modelIcons/grok.svg";
import GroqIcon from "@src/assets/modelIcons/groq.svg";
import HermesIcon from "@src/assets/modelIcons/hermes.svg";
import HunyuanIcon from "@src/assets/modelIcons/hunyuan.svg?url";
import InfinityAgentIcon from "@src/assets/modelIcons/infinity-agent.svg";
import KiloIcon from "@src/assets/modelIcons/kilo.svg";
import KimiIcon from "@src/assets/modelIcons/kimi.svg?url";
import KiroIcon from "@src/assets/modelIcons/kiro.svg?url";
import LlamaCppIcon from "@src/assets/modelIcons/llama-cpp.svg?url";
import LmStudioIcon from "@src/assets/modelIcons/lmstudio.svg";
import LongCatIcon from "@src/assets/modelIcons/longcat.svg";
import MetaIcon from "@src/assets/modelIcons/meta.svg?url";
import MinimaxIcon from "@src/assets/modelIcons/minimax.svg?url";
import MistralIcon from "@src/assets/modelIcons/mistral.svg?url";
import ModelScopeIcon from "@src/assets/modelIcons/modelscope.svg?url";
import NvidiaIcon from "@src/assets/modelIcons/nvidia.svg?url";
import OllamaIcon from "@src/assets/modelIcons/ollama.svg";
import OmpIcon from "@src/assets/modelIcons/omp.svg?url";
import OpenAIIcon from "@src/assets/modelIcons/openai.svg";
import OpenClawIcon from "@src/assets/modelIcons/openclaw.svg?url";
import OpenCodeIcon from "@src/assets/modelIcons/opencode.svg";
import OpenRouterIcon from "@src/assets/modelIcons/openrouter.svg";
import OrgiiIcon from "@src/assets/modelIcons/org2-session.svg?url";
import PerplexityIcon from "@src/assets/modelIcons/perplexity.svg?url";
import PiIcon from "@src/assets/modelIcons/pi.svg?url";
import QoderIcon from "@src/assets/modelIcons/qoder.svg";
import QwenIcon from "@src/assets/modelIcons/qwen.svg?url";
import RovoIcon from "@src/assets/modelIcons/rovo.svg?url";
import SiliconFlowIcon from "@src/assets/modelIcons/siliconflow.svg?url";
import TraeIcon from "@src/assets/modelIcons/trae.svg";
import VllmIcon from "@src/assets/modelIcons/vllm.svg?url";
import VolcengineIcon from "@src/assets/modelIcons/volcengine.svg?url";
import WarpIcon from "@src/assets/modelIcons/warp.svg";
import WindsurfIcon from "@src/assets/modelIcons/windsurf.svg";
import WorkBuddyIcon from "@src/assets/modelIcons/workbuddy.svg?url";
import XaiIcon from "@src/assets/modelIcons/xai.svg";
import XiaomiIcon from "@src/assets/modelIcons/xiaomi.svg?url";
import YiIcon from "@src/assets/modelIcons/yi.svg";
import ZcodeIcon from "@src/assets/modelIcons/zcode.svg";
import ZenMuxIcon from "@src/assets/modelIcons/zenmux.svg";
import ZhipuIcon from "@src/assets/modelIcons/zhipu.svg?url";

// ============================================
// Types
// ============================================

/**
 * Icon provider — short brand name for icon lookup.
 *
 * This is a UI/display layer type that maps from business types
 * (`ModelType`, model names) to brand icons.
 */
export type IconProvider =
  | "openai"
  | "atlascloud"
  | "codex"
  | "aws"
  | "azure"
  | "claude"
  | "claude_code"
  | "copilot"
  | "cursor"
  | "windsurf"
  | "trae"
  | "workbuddy"
  | "warp"
  | "amp"
  | "devin"
  | "rovo"
  | "hermes"
  | "openclaw"
  | "aug"
  | "codebuff"
  | "qwen_code"
  | "mimo_code"
  | "antigravity"
  | "continue_cli"
  | "droid"
  | "mistral_vibe"
  | "autohand"
  | "omp"
  | "pi"
  | "kilo"
  | "gemini"
  | "grok"
  | "xai"
  | "groq"
  | "cohere"
  | "deepseek"
  | "mistral"
  | "qwen"
  | "meta"
  | "nvidia"
  | "perplexity"
  | "kiro"
  | "kimi"
  | "hunyuan"
  | "ollama"
  | "lm_studio"
  | "llamacpp"
  | "bytedance"
  | "volcengine"
  | "xiaomi"
  | "yi"
  | "zhipu"
  | "zcode"
  | "qoder"
  | "baichuan"
  | "minimax"
  | "longcat"
  | "siliconflow"
  | "modelscope"
  | "aihubmix"
  | "cherryin"
  | "custom"
  | "doubao"
  | "openrouter"
  | "zenmux"
  | "vllm"
  | "orgii"
  // Inactive agents (kept for future use)
  | "aider"
  | "cline"
  | "goose"
  | "opencode"
  | "unknown";

// ============================================
// Icon Map
// ============================================

/**
 * A provider glyph is either a URL to brand artwork with its own palette,
 * drawn through `<img>` so it costs no JS module, or, for marks authored in
 * `currentColor`, the svgr component that inherits the surrounding text color.
 * `config.test.ts` checks each import against the SVG's own content.
 */
export type ModelIconSource = string | FC<SVGProps<SVGSVGElement>>;

/** Maps icon providers to their glyph source (asset URL or svgr component) */
export const ICON_MAP: Record<IconProvider, ModelIconSource | undefined> = {
  // CLI agents (active)
  cursor: CursorIcon,
  windsurf: WindsurfIcon,
  trae: TraeIcon,
  workbuddy: WorkBuddyIcon,
  warp: WarpIcon,
  claude_code: ClaudeIcon,
  copilot: CopilotIcon,
  gemini: GeminiIcon,
  kiro: KiroIcon,
  // OpenAI-related
  openai: OpenAIIcon,
  atlascloud: AtlasCloudIcon,
  codex: OpenAIIcon,
  // Anthropic
  claude: ClaudeIcon,
  // ORGII
  orgii: OrgiiIcon,
  // API providers
  aws: AWSIcon,
  azure: AzureIcon,
  cohere: CohereIcon,
  deepseek: DeepSeekIcon,
  grok: GrokIcon,
  xai: XaiIcon,
  groq: GroqIcon,
  mistral: MistralIcon,
  qwen: QwenIcon,
  meta: MetaIcon,
  nvidia: NvidiaIcon,
  perplexity: PerplexityIcon,
  kimi: KimiIcon,
  hunyuan: HunyuanIcon,
  ollama: OllamaIcon,
  lm_studio: LmStudioIcon,
  llamacpp: LlamaCppIcon,
  bytedance: ByteDanceIcon,
  volcengine: VolcengineIcon,
  xiaomi: XiaomiIcon,
  yi: YiIcon,
  zhipu: ZhipuIcon,
  zcode: ZcodeIcon,
  qoder: QoderIcon,
  baichuan: BaichuanIcon,
  minimax: MinimaxIcon,
  longcat: LongCatIcon,
  siliconflow: SiliconFlowIcon,
  modelscope: ModelScopeIcon,
  aihubmix: AiHubMixIcon,
  cherryin: CherryInIcon,
  custom: CustomGatewayIcon,
  doubao: DoubaoIcon,
  openrouter: OpenRouterIcon,
  zenmux: ZenMuxIcon,
  vllm: VllmIcon,
  // Active agent
  opencode: OpenCodeIcon,
  // Inactive agents (kept for future use)
  aider: AiderIcon,
  cline: ClineIcon,
  goose: GooseIcon,
  // Extended CLI agents — lobehub icons where available, infinity fallback otherwise
  amp: AmpIcon,
  devin: DevinIcon,
  rovo: RovoIcon,
  hermes: HermesIcon,
  openclaw: OpenClawIcon,
  aug: AugmentIcon,
  codebuff: InfinityAgentIcon,
  qwen_code: QwenIcon,
  mimo_code: XiaomiIcon,
  antigravity: AntigravityIcon,
  continue_cli: ContinueIcon,
  droid: DroidIcon,
  mistral_vibe: MistralIcon,
  autohand: AutoHandIcon,
  omp: OmpIcon,
  pi: PiIcon,
  kilo: KiloIcon,
  // Fallback
  unknown: undefined,
};

/** Active icon providers available for user selection (excludes unknown + inactive agents) */
export const SELECTABLE_ICON_PROVIDERS: IconProvider[] = [
  "openai",
  "atlascloud",
  "claude",
  "claude_code",
  "gemini",
  "deepseek",
  "cursor",
  "copilot",
  "kiro",
  "codex",
  "grok",
  "groq",
  "cohere",
  "mistral",
  "qwen",
  "meta",
  "nvidia",
  "perplexity",
  "kimi",
  "hunyuan",
  "ollama",
  "lm_studio",
  "llamacpp",
  "aws",
  "azure",
  "bytedance",
  "volcengine",
  "xiaomi",
  "yi",
  "zhipu",
  "zcode",
  "qoder",
  "baichuan",
  "minimax",
  "longcat",
  "siliconflow",
  "modelscope",
  "aihubmix",
  "cherryin",
  "custom",
  "doubao",
  "openrouter",
  "zenmux",
  "vllm",
  "orgii",
  "opencode",
];

/**
 * ORGII orchestrator + CLI coding-agent brands — excluded from custom model icon
 * picker (only API / model-hosting providers).
 */
const EXCLUDED_MODEL_ALIAS_ICON_PROVIDER: ReadonlySet<IconProvider> = new Set([
  "orgii",
  "cursor",
  "claude_code",
  "copilot",
  "kiro",
  "codex",
  "opencode",
]);

/** Model/API provider icons for KeyVault custom model table (no ORGII, no CLI agents). */
export const MODEL_PROVIDER_ICON_PROVIDERS: IconProvider[] =
  SELECTABLE_ICON_PROVIDERS.filter(
    (provider) => !EXCLUDED_MODEL_ALIAS_ICON_PROVIDER.has(provider)
  );

// ============================================
// ModelType → IconProvider Mapping
// ============================================

/**
 * Maps ModelType (business logic) to IconProvider (UI display).
 *
 * This is the single source of truth for converting business types to icon brands.
 */
const MODEL_TYPE_TO_ICON: Record<ModelType, IconProvider> = {
  // CLI agents (active)
  cursor_cli: "cursor",
  copilot: "copilot",
  claude_code: "claude_code",
  codex: "codex",
  kiro: "kiro",
  kimi_cli: "kimi",
  opencode: "opencode",
  // Extended CLI agents
  aider: "aider",
  goose: "goose",
  amp: "amp",
  cline: "cline",
  kilo: "kilo",
  grok_cli: "grok",
  devin: "devin",
  rovo: "rovo",
  hermes: "hermes",
  openclaw: "openclaw",
  aug: "aug",
  codebuff: "codebuff",
  qwen_code: "qwen_code",
  mimo_code: "mimo_code",
  antigravity: "antigravity",
  continue_cli: "continue_cli",
  droid: "droid",
  mistral_vibe: "mistral_vibe",
  autohand: "autohand",
  omp: "omp",
  pi: "pi",
  qoder_cli: "qoder",
  trae_cli: "trae",
  deepseek_harness: "deepseek",
  // API key providers
  anthropic_api: "claude",
  openai_api: "openai",
  atlascloud_api: "atlascloud",
  deepseek_api: "deepseek",
  gemini_api: "gemini",
  groq_api: "groq",
  xai_api: "grok",
  zhipu_api: "zhipu",
  dashscope_api: "qwen",
  minimax_api: "minimax",
  longcat_api: "longcat",
  siliconflow_api: "siliconflow",
  modelscope_api: "modelscope",
  aihubmix_api: "aihubmix",
  cherryin_api: "cherryin",
  bedrock_api: "aws",
  custom_api: "custom",
  moonshot_api: "kimi",
  openrouter_api: "openrouter",
  zenmux_api: "zenmux",
  vllm_api: "vllm",
  azure_openai_api: "azure",
  azure_anthropic_api: "azure",
  orgii_orchestrator: "orgii",
  // Short aliases (for validation convenience)
  openai: "openai",
  anthropic: "claude",
  google: "gemini",
};

/**
 * Get icon provider from ModelType.
 * @param modelType - The business-logic model type (e.g. "cursor_cli", "anthropic_api")
 */
export function getIconProvider(modelType: ModelType): IconProvider {
  return MODEL_TYPE_TO_ICON[modelType] || "unknown";
}

export function getIconProviderFromType(value: string): IconProvider {
  if (isIconProvider(value)) return value;
  return MODEL_TYPE_TO_ICON[value as ModelType] || "unknown";
}

export function isIconProvider(value: string): value is IconProvider {
  return Object.prototype.hasOwnProperty.call(ICON_MAP, value);
}

export function getIconComponent(
  provider: IconProvider
): FC<SVGProps<SVGSVGElement>> | undefined {
  const source = ICON_MAP[provider];
  return source === undefined ? undefined : toIconComponent(source);
}

const urlIconComponents = new Map<string, FC<SVGProps<SVGSVGElement>>>();

/**
 * Adapt a glyph source to the svgr component shape callers already render
 * (`<Icon width height className style />`). URL sources get a memoized
 * `<img>` component so identity stays stable across renders.
 */
export function toIconComponent(
  source: ModelIconSource
): FC<SVGProps<SVGSVGElement>> {
  if (typeof source !== "string") return source;
  const cached = urlIconComponents.get(source);
  if (cached) return cached;
  // Pass the remaining props through so wrappers that tag the glyph
  // (`agentIcons.tsx` sets data-icon / data-brand) keep working; only the
  // SVG-paint props that mean nothing on an <img> are dropped.
  const UrlIcon = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>(
    (
      {
        width,
        height,
        className,
        style,
        fill: _fill,
        stroke: _stroke,
        strokeWidth: _strokeWidth,
        color: _color,
        viewBox: _viewBox,
        ...rest
      },
      ref
    ) =>
      createElement("img", {
        ...rest,
        src: source,
        width,
        height,
        className,
        style,
        alt: "",
        "aria-hidden": "true",
        draggable: false,
        ref: ref as unknown as Ref<HTMLImageElement>,
      })
  );
  UrlIcon.displayName = "UrlModelIcon";
  const component = UrlIcon as unknown as FC<SVGProps<SVGSVGElement>>;
  urlIconComponents.set(source, component);
  return component;
}

/**
 * Detect icon provider from model name.
 * @param modelName - The model name string (e.g. "gpt-4o", "composer-1", "auto")
 * @param agentType - Optional agent type hint for generic names like "auto"
 */
const CURSOR_MODEL_NAME_ICONS = new Set(["auto", "default", "premium"]);

export function getIconProviderFromModelName(
  modelName: string,
  agentType?: string
): IconProvider {
  const lower = modelName.toLowerCase();

  // Generic model names that depend on agent type context
  if (lower === "auto" && agentType) {
    return MODEL_TYPE_TO_ICON[agentType as ModelType] || "unknown";
  }

  // Cursor models (composer and Cursor plan/tier names)
  if (lower.includes("composer") || CURSOR_MODEL_NAME_ICONS.has(lower)) {
    return "cursor";
  }

  // GitHub Copilot models (copilot-chat, copilot-premium, etc.)
  if (lower.includes("copilot")) {
    return "copilot";
  }

  // OpenAI models (provider-prefixed OpenRouter IDs, GPT series, O-series,
  // Codex variants, etc.)
  if (
    lower.startsWith("openai/") ||
    lower.includes("gpt") ||
    lower.includes("codex") ||
    /^o\d/.test(lower)
  ) {
    return "openai";
  }

  // Anthropic/Claude models (including model family names + Cursor's
  // "op-*-relay" tier name, which is an Opus-class proxy and should
  // share the Claude brand mark — same shape of normalization as
  // OpenAI's `^o\d` rule above for o-series models like "o5.5-high").
  if (
    lower.includes("claude") ||
    lower.includes("fable") ||
    lower.includes("haiku") ||
    lower.includes("opus") ||
    lower.includes("sonnet") ||
    /^op[-_]/.test(lower)
  ) {
    return "claude";
  }

  // Google/Gemini/Gemma models
  if (
    lower.startsWith("google/") ||
    lower.includes("gemini") ||
    lower.includes("gemma")
  ) {
    return "gemini";
  }

  // xAI/Grok models
  if (lower.includes("grok")) {
    return "grok";
  }

  // DeepSeek models
  if (lower.includes("deepseek")) {
    return "deepseek";
  }

  // Cohere models
  if (lower.startsWith("cohere/") || lower.includes("command-r")) {
    return "cohere";
  }

  // Mistral models
  if (lower.includes("mistral") || lower.includes("mixtral")) {
    return "mistral";
  }

  // Alibaba/Qwen models
  if (lower.includes("qwen")) {
    return "qwen";
  }

  // NVIDIA/Nemotron models
  if (
    lower.includes("nvidia") ||
    lower.includes("nvdia") ||
    lower.includes("nemotron")
  ) {
    return "nvidia";
  }

  // Meta/Llama models
  if (lower.includes("llama") || lower.includes("meta")) {
    return "meta";
  }

  // Perplexity models
  if (lower.includes("perplexity") || lower.includes("pplx")) {
    return "perplexity";
  }

  // ZenMux provider/model slugs
  if (lower.includes("zenmux")) {
    return "zenmux";
  }

  // Moonshot/Kimi models
  if (lower.includes("kimi") || lower.includes("moonshot")) {
    return "kimi";
  }

  // Tencent Hunyuan models
  if (lower.includes("hunyuan") || /^hy(?:\d|[-_])/.test(lower)) {
    return "hunyuan";
  }

  // Local runtimes
  if (lower.includes("ollama")) {
    return "ollama";
  }
  if (lower.includes("lmstudio") || lower.includes("lm-studio")) {
    return "lm_studio";
  }
  if (lower.includes("llama.cpp") || lower.includes("llama-cpp")) {
    return "llamacpp";
  }

  // ByteDance/Doubao models
  if (lower.includes("bytedance")) {
    return "bytedance";
  }

  // Doubao (ByteDance's model name)
  if (lower.includes("doubao")) {
    return "doubao";
  }

  // Volcengine models
  if (lower.includes("volcengine") || lower.includes("volc")) {
    return "volcengine";
  }

  // Xiaomi/MiMo models
  if (lower.startsWith("xiaomi/") || lower.includes("mimo")) {
    return "xiaomi";
  }

  // 01.AI/Yi models
  if (lower.includes("yi-") || lower === "yi" || lower.includes("01.ai")) {
    return "yi";
  }

  // ZCode IDE / Z.ai coding workspace
  if (lower.includes("zcode")) {
    return "zcode";
  }

  // Qoder IDE (Alibaba's agentic IDE)
  if (lower.includes("qoder")) {
    return "qoder";
  }

  // Zhipu/GLM models
  if (
    lower.includes("zhipu") ||
    lower.includes("glm") ||
    lower.includes("chatglm")
  ) {
    return "zhipu";
  }

  // Baichuan models
  if (lower.includes("baichuan")) {
    return "baichuan";
  }

  // Minimax models
  if (lower.includes("minimax") || lower.includes("abab")) {
    return "minimax";
  }

  // LongCat models
  if (lower.includes("longcat") || lower.startsWith("meituan/")) {
    return "longcat";
  }

  return "unknown";
}

// ============================================
// Theming
// ============================================

/**
 * Icons that use fill="currentColor" and should respond to text color classes.
 * Brand-colored icons have their colors baked in and should NOT be themed.
 */
export const THEMEABLE_ICONS = new Set<IconProvider>([
  "unknown",
  "openai",
  "codex",
  "aws",
  "cursor",
  "copilot",
  "grok",
  "xai",
  "groq",
  "openrouter",
  "zenmux",
  "custom",
  "yi",
  "zcode",
  "orgii",
  // Inactive agents that use currentColor
  "goose",
  "cline",
  "opencode",
  "kimi",
  // Extended CLI agents using monochrome/currentColor icons.
  "codebuff",
  "qwen_code",
  "mimo_code",
  "mistral_vibe",
  "autohand",
]);
