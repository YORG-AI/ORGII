import { z } from "zod";

import type { SettingDefinition } from "@src/config/settingsSchema/types";

export const HOUSEKEEPER_SETTINGS_REGISTRY = {
  "housekeeper.enabled": {
    schema: z.boolean(),
    default: false,
    description:
      "Enable the local MiniCPM resident housekeeper for lightweight tasks",
    category: "housekeeper",
  },
  "housekeeper.accountId": {
    schema: z.string().nullable(),
    default: null,
    description:
      "KeyVault vLLM account ID used by the local MiniCPM housekeeper",
    category: "housekeeper",
  },
  "housekeeper.model": {
    schema: z.string().min(1),
    default: "openbmb/MiniCPM5-1B",
    description: "Model ID used by the local MiniCPM housekeeper",
    category: "housekeeper",
  },
  "housekeeper.contextLimitTokens": {
    schema: z.number().int().min(1024).max(32768),
    default: 10000,
    description: "Safe context budget for local MiniCPM housekeeper requests",
    category: "housekeeper",
  },
  "housekeeper.features.promptPolish": {
    schema: z.boolean(),
    default: true,
    description: "Allow MiniCPM to polish chat drafts before sending",
    category: "housekeeper",
  },
  "housekeeper.features.stepExplain": {
    schema: z.boolean(),
    default: true,
    description: "Allow MiniCPM to explain session replay steps",
    category: "housekeeper",
  },
  "housekeeper.features.uiControl": {
    schema: z.boolean(),
    default: true,
    description: "Allow MiniCPM to classify lightweight UI control requests",
    category: "housekeeper",
  },
  "housekeeper.features.contextCompact": {
    schema: z.boolean(),
    default: false,
    description:
      "Allow MiniCPM to maintain an isolated rolling summary of older context",
    category: "housekeeper",
  },
} as const satisfies Record<string, SettingDefinition>;
