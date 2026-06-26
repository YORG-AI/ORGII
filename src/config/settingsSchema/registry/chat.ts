import { z } from "zod";

import type { SettingDefinition } from "@src/config/settingsSchema/types";

export const CHAT_SETTINGS_REGISTRY = {
  "chat.fontSize": {
    schema: z.number().int().min(10).max(16),
    default: 14,
    description: "Chat panel font size in pixels (10-16)",
    category: "chat",
  },
  "chat.codeFontSize": {
    schema: z.number().int().min(10).max(16),
    default: 13,
    description: "Chat code block font size in pixels (10-16)",
    category: "chat",
  },
  "chat.lineHeight": {
    schema: z.number().min(1.2).max(2.0),
    default: 1.6,
    description: "Chat panel line height multiplier (1.2-2.0)",
    category: "chat",
  },
  "chat.typingEffectEnabled": {
    schema: z.boolean(),
    default: true,
    description: "Enable typing effect animation for agent responses",
    category: "chat",
  },
  "chat.typingSpeed": {
    schema: z.number().int().min(1).max(50),
    default: 5,
    description: "Typing effect speed in milliseconds per character (1-50)",
    category: "chat",
  },
  "chat.decryptEffectEnabled": {
    schema: z.boolean(),
    default: false,
    description: "Enable decrypt text animation effect for agent responses",
    category: "chat",
  },
  "chat.sendOnEnter": {
    schema: z.boolean(),
    default: false,
    description: "Send chat messages with Enter instead of Ctrl/Cmd+Enter",
    category: "chat",
  },
} as const satisfies Record<string, SettingDefinition>;
