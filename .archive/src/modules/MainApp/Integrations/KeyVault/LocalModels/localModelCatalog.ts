import type { LocalModelHardwareSummary } from "@src/api/tauri/perf/types";

export const LOCAL_MODEL_BACKEND = {
  CUDA: "cuda",
  ROCM: "rocm",
  METAL: "metal",
  CPU_X86: "cpu_x86",
  CPU_ARM: "cpu_arm",
} as const;

export type LocalModelBackend =
  (typeof LOCAL_MODEL_BACKEND)[keyof typeof LOCAL_MODEL_BACKEND];

export const LOCAL_MODEL_RUN_MODE = {
  GPU: "gpu",
  CPU_OFFLOAD: "cpu_offload",
  CPU_ONLY: "cpu_only",
  NO_FIT: "no_fit",
} as const;

export type LocalModelRunMode =
  (typeof LOCAL_MODEL_RUN_MODE)[keyof typeof LOCAL_MODEL_RUN_MODE];

export const LOCAL_MODEL_FIT_LEVEL = {
  EXCELLENT: "excellent",
  GOOD: "good",
  TIGHT: "tight",
  TOO_TIGHT: "too_tight",
} as const;

export type LocalModelFitLevel =
  (typeof LOCAL_MODEL_FIT_LEVEL)[keyof typeof LOCAL_MODEL_FIT_LEVEL];

export interface LocalModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  family: string;
  parametersB: number;
  quant: string;
  contextTokens: number;
  useCase: "general" | "coding" | "reasoning" | "chat" | "embedding";
  ollamaModel?: string;
  ggufHint: string;
  notes: string;
}

export interface LocalModelRecommendation extends LocalModelCatalogEntry {
  requiredGb: number;
  speedTps: number;
  score: number;
  fitLevel: LocalModelFitLevel;
  runMode: LocalModelRunMode;
}

const QUANT_BYTES_PER_PARAM: Record<string, number> = {
  Q8_0: 1.0,
  Q6_K: 0.75,
  Q5_K_M: 0.625,
  Q4_K_M: 0.5,
  Q4_0: 0.5,
  Q3_K_M: 0.375,
  Q2_K: 0.25,
};

const BACKEND_SPEED_FACTOR: Record<LocalModelBackend, number> = {
  [LOCAL_MODEL_BACKEND.CUDA]: 230,
  [LOCAL_MODEL_BACKEND.ROCM]: 180,
  [LOCAL_MODEL_BACKEND.METAL]: 150,
  [LOCAL_MODEL_BACKEND.CPU_X86]: 70,
  [LOCAL_MODEL_BACKEND.CPU_ARM]: 90,
};

export const LOCAL_MODEL_CATALOG: readonly LocalModelCatalogEntry[] = [
  {
    id: "qwen2.5-coder-3b-q4",
    name: "Qwen2.5 Coder 3B Instruct",
    provider: "Qwen",
    family: "Qwen2.5 Coder",
    parametersB: 3.1,
    quant: "Q4_K_M",
    contextTokens: 32768,
    useCase: "coding",
    ollamaModel: "qwen2.5-coder:3b-instruct-q4_K_M",
    ggufHint: "GGUF Q4_K_M",
    notes: "Fast coding model for small machines and CPU fallback.",
  },
  {
    id: "qwen2.5-coder-7b-q4",
    name: "Qwen2.5 Coder 7B Instruct",
    provider: "Qwen",
    family: "Qwen2.5 Coder",
    parametersB: 7.6,
    quant: "Q4_K_M",
    contextTokens: 32768,
    useCase: "coding",
    ollamaModel: "qwen2.5-coder:7b-instruct-q4_K_M",
    ggufHint: "GGUF Q4_K_M",
    notes: "Balanced local coding recommendation for modern laptops.",
  },
  {
    id: "qwen2.5-coder-14b-q4",
    name: "Qwen2.5 Coder 14B Instruct",
    provider: "Qwen",
    family: "Qwen2.5 Coder",
    parametersB: 14.7,
    quant: "Q4_K_M",
    contextTokens: 32768,
    useCase: "coding",
    ollamaModel: "qwen2.5-coder:14b-instruct-q4_K_M",
    ggufHint: "GGUF Q4_K_M",
    notes: "Stronger coding model when memory headroom is available.",
  },
  {
    id: "llama-3.2-3b-q4",
    name: "Llama 3.2 3B Instruct",
    provider: "Meta",
    family: "Llama 3.2",
    parametersB: 3.2,
    quant: "Q4_K_M",
    contextTokens: 8192,
    useCase: "chat",
    ollamaModel: "llama3.2:3b-instruct-q4_K_M",
    ggufHint: "GGUF Q4_K_M",
    notes: "Small general chat model with low memory requirements.",
  },
  {
    id: "llama-3.1-8b-q4",
    name: "Llama 3.1 8B Instruct",
    provider: "Meta",
    family: "Llama 3.1",
    parametersB: 8,
    quant: "Q4_K_M",
    contextTokens: 131072,
    useCase: "general",
    ollamaModel: "llama3.1:8b-instruct-q4_K_M",
    ggufHint: "GGUF Q4_K_M",
    notes: "General-purpose long-context local assistant.",
  },
  {
    id: "mistral-nemo-12b-q4",
    name: "Mistral Nemo 12B Instruct",
    provider: "Mistral AI",
    family: "Mistral Nemo",
    parametersB: 12.2,
    quant: "Q4_K_M",
    contextTokens: 128000,
    useCase: "general",
    ollamaModel: "mistral-nemo:12b-instruct-2407-q4_K_M",
    ggufHint: "GGUF Q4_K_M",
    notes: "Good long-context general model for 16 GB+ systems.",
  },
  {
    id: "gemma-2-9b-q4",
    name: "Gemma 2 9B Instruct",
    provider: "Google",
    family: "Gemma 2",
    parametersB: 9.2,
    quant: "Q4_K_M",
    contextTokens: 8192,
    useCase: "general",
    ollamaModel: "gemma2:9b-instruct-q4_K_M",
    ggufHint: "GGUF Q4_K_M",
    notes: "High-quality compact general assistant.",
  },
  {
    id: "deepseek-r1-distill-qwen-7b-q4",
    name: "DeepSeek R1 Distill Qwen 7B",
    provider: "DeepSeek",
    family: "DeepSeek R1 Distill",
    parametersB: 7,
    quant: "Q4_K_M",
    contextTokens: 32768,
    useCase: "reasoning",
    ollamaModel: "deepseek-r1:7b-qwen-distill-q4_K_M",
    ggufHint: "GGUF Q4_K_M",
    notes: "Small reasoning-focused model for local experiments.",
  },
  {
    id: "deepseek-r1-distill-qwen-14b-q4",
    name: "DeepSeek R1 Distill Qwen 14B",
    provider: "DeepSeek",
    family: "DeepSeek R1 Distill",
    parametersB: 14,
    quant: "Q4_K_M",
    contextTokens: 32768,
    useCase: "reasoning",
    ollamaModel: "deepseek-r1:14b-qwen-distill-q4_K_M",
    ggufHint: "GGUF Q4_K_M",
    notes: "Better reasoning quality when GPU or unified memory allows it.",
  },
  {
    id: "nomic-embed-text-q4",
    name: "Nomic Embed Text",
    provider: "Nomic",
    family: "Embedding",
    parametersB: 0.14,
    quant: "Q4_K_M",
    contextTokens: 8192,
    useCase: "embedding",
    ollamaModel: "nomic-embed-text",
    ggufHint: "Ollama embedding model",
    notes: "Lightweight local embeddings for search and RAG indexes.",
  },
];

export function recommendLocalModels(
  hardware: LocalModelHardwareSummary
): LocalModelRecommendation[] {
  const gpuBudgetGb = hardware.has_gpu
    ? (hardware.gpu_vram_gb ??
      (hardware.unified_memory ? hardware.total_ram_gb : 0))
    : 0;
  const ramBudgetGb = Math.max(
    hardware.available_ram_gb,
    hardware.total_ram_gb * 0.65
  );
  const backend = normalizeBackend(hardware.backend);

  return LOCAL_MODEL_CATALOG.map((entry) =>
    analyzeLocalModel(entry, gpuBudgetGb, ramBudgetGb, backend)
  ).sort((left, right) => right.score - left.score);
}

function analyzeLocalModel(
  entry: LocalModelCatalogEntry,
  gpuBudgetGb: number,
  ramBudgetGb: number,
  backend: LocalModelBackend
): LocalModelRecommendation {
  const requiredGb = estimateMemoryGb(entry);
  const runMode = resolveRunMode(requiredGb, gpuBudgetGb, ramBudgetGb);
  const fitLevel = resolveFitLevel(
    requiredGb,
    runMode,
    gpuBudgetGb,
    ramBudgetGb
  );
  const speedTps = estimateSpeedTps(entry, backend, runMode);
  const score = scoreRecommendation(entry, requiredGb, speedTps, fitLevel);

  return {
    ...entry,
    requiredGb: roundOne(requiredGb),
    speedTps: roundOne(speedTps),
    fitLevel,
    runMode,
    score: roundOne(score),
  };
}

function estimateMemoryGb(entry: LocalModelCatalogEntry): number {
  const bytesPerParam = QUANT_BYTES_PER_PARAM[entry.quant] ?? 0.5;
  const kvCacheGb = 0.000008 * entry.parametersB * entry.contextTokens;
  return entry.parametersB * bytesPerParam + kvCacheGb + 0.5;
}

function resolveRunMode(
  requiredGb: number,
  gpuBudgetGb: number,
  ramBudgetGb: number
): LocalModelRunMode {
  if (gpuBudgetGb > 0 && requiredGb <= gpuBudgetGb) {
    return LOCAL_MODEL_RUN_MODE.GPU;
  }
  if (gpuBudgetGb > 0 && requiredGb <= ramBudgetGb) {
    return LOCAL_MODEL_RUN_MODE.CPU_OFFLOAD;
  }
  if (gpuBudgetGb <= 0 && requiredGb <= ramBudgetGb) {
    return LOCAL_MODEL_RUN_MODE.CPU_ONLY;
  }
  return LOCAL_MODEL_RUN_MODE.NO_FIT;
}

function resolveFitLevel(
  requiredGb: number,
  runMode: LocalModelRunMode,
  gpuBudgetGb: number,
  ramBudgetGb: number
): LocalModelFitLevel {
  if (runMode === LOCAL_MODEL_RUN_MODE.NO_FIT) {
    return LOCAL_MODEL_FIT_LEVEL.TOO_TIGHT;
  }
  const budget =
    runMode === LOCAL_MODEL_RUN_MODE.GPU ? gpuBudgetGb : ramBudgetGb;
  const ratio = budget > 0 ? requiredGb / budget : 1;
  if (ratio <= 0.55) return LOCAL_MODEL_FIT_LEVEL.EXCELLENT;
  if (ratio <= 0.8) return LOCAL_MODEL_FIT_LEVEL.GOOD;
  return LOCAL_MODEL_FIT_LEVEL.TIGHT;
}

function estimateSpeedTps(
  entry: LocalModelCatalogEntry,
  backend: LocalModelBackend,
  runMode: LocalModelRunMode
): number {
  if (runMode === LOCAL_MODEL_RUN_MODE.NO_FIT) return 0;
  const speedFactor = BACKEND_SPEED_FACTOR[backend];
  const offloadMultiplier =
    runMode === LOCAL_MODEL_RUN_MODE.CPU_OFFLOAD
      ? 0.45
      : runMode === LOCAL_MODEL_RUN_MODE.CPU_ONLY
        ? 0.6
        : 1;
  const quantMultiplier = entry.quant.startsWith("Q4") ? 1.15 : 1;
  return (
    (speedFactor / Math.max(entry.parametersB, 0.2)) *
    quantMultiplier *
    offloadMultiplier
  );
}

function scoreRecommendation(
  entry: LocalModelCatalogEntry,
  requiredGb: number,
  speedTps: number,
  fitLevel: LocalModelFitLevel
): number {
  const qualityScore = Math.min(
    100,
    42 + Math.log2(entry.parametersB + 1) * 18
  );
  const speedScore = Math.min(100, (speedTps / 35) * 100);
  const contextScore =
    entry.contextTokens >= 32768 ? 100 : entry.contextTokens >= 8192 ? 75 : 50;
  const fitScore =
    fitLevel === LOCAL_MODEL_FIT_LEVEL.EXCELLENT
      ? 100
      : fitLevel === LOCAL_MODEL_FIT_LEVEL.GOOD
        ? 82
        : fitLevel === LOCAL_MODEL_FIT_LEVEL.TIGHT
          ? 55
          : 0;
  const memoryPenalty =
    fitLevel === LOCAL_MODEL_FIT_LEVEL.TOO_TIGHT ? requiredGb : 0;
  return (
    qualityScore * 0.4 +
    speedScore * 0.25 +
    fitScore * 0.25 +
    contextScore * 0.1 -
    memoryPenalty
  );
}

function normalizeBackend(backend: string): LocalModelBackend {
  const values = Object.values(LOCAL_MODEL_BACKEND) as string[];
  if (values.includes(backend)) return backend as LocalModelBackend;
  return LOCAL_MODEL_BACKEND.CPU_X86;
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}
