import { z } from "zod";

import type { SettingDefinition } from "@src/config/settingsSchema/types";

export const PRIVACY_SETTINGS_REGISTRY = {
  "privacy.diagnosticsLevel": {
    schema: z.enum(["off", "performance-only", "default"]),
    default: "default" as const,
    description:
      "Diagnostics level: minimal existence heartbeat, performance-only, or default usage aggregates",
    category: "privacy",
    enumLabels: {
      off: "Off",
      "performance-only": "Performance only",
      default: "Default",
    },
  },
  "privacy.diagnosticsUploadIntervalHours": {
    schema: z.number().int().min(1).max(24),
    default: 12,
    description: "Diagnostics upload interval in hours",
    category: "privacy",
  },
  "privacy.offlineMode": {
    schema: z.boolean(),
    default: false,
    description:
      "Disable non-essential outbound network calls including diagnostics",
    category: "privacy",
  },
  "privacy.shareRuntimeWithOrg": {
    schema: z.boolean(),
    default: true,
    description:
      "Share coarse runtime, usage, and builder-profile aggregates with cloud organizations that have team runtime telemetry enabled (never session contents, titles, or repo paths)",
    category: "privacy",
  },
} as const satisfies Record<string, SettingDefinition>;
