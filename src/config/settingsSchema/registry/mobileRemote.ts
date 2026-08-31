import { z } from "zod";

import type { SettingDefinition } from "@src/config/settingsSchema/types";

/** Default LAN WebSocket port — shared with the IDE server (Phase 0). */
export const MOBILE_REMOTE_DEFAULT_LAN_PORT = 13847;

/**
 * Mobile Remote Control settings.
 *
 * Phase 0 uses a LAN WebSocket bridge on the IDE server. Phase 1+ adds
 * relay pairing (`mobileRemoteApi`). The Settings → Mobile Remote section
 * gates LAN exposure, token display, and the paired-device list.
 */
export const MOBILE_REMOTE_SETTINGS_REGISTRY = {
  "mobileRemote.enabled": {
    schema: z.boolean(),
    default: false,
    description:
      "Enable Mobile Remote Control. When off, LAN bridge endpoints stay disabled and device controls are hidden.",
    category: "mobileRemote",
  },
  "mobileRemote.relayEnabled": {
    schema: z.boolean(),
    default: false,
    description: "Connect this desktop outbound to the configured public relay",
    category: "mobileRemote",
  },
  "mobileRemote.relayUrl": {
    schema: z.string(),
    default: "",
    description: "Public ws:// or wss:// Mobile Remote relay URL",
    category: "mobileRemote",
  },
  "mobileRemote.desktopId": {
    schema: z.string(),
    default: "",
    description: "Stable identity generated for this desktop during pairing",
    category: "mobileRemote",
  },
  "mobileRemote.desktopToken": {
    schema: z.string(),
    default: "",
    description: "Desktop access token configured on the self-hosted relay",
    category: "mobileRemote",
  },
  "mobileRemote.allowLanExposure": {
    schema: z.boolean(),
    default: false,
    description:
      "Allow Mobile Remote WebSocket connections from other devices on your LAN. When off, the bridge binds to localhost only.",
    category: "mobileRemote",
  },
  "mobileRemote.lanToken": {
    schema: z.string(),
    default: "",
    description:
      "Shared secret appended to the Mobile Remote WebSocket URL. Regenerate if you suspect it was exposed.",
    category: "mobileRemote",
  },
  "mobileRemote.lanPort": {
    schema: z.number().int().min(1).max(65535),
    default: MOBILE_REMOTE_DEFAULT_LAN_PORT,
    description:
      "TCP port for the Mobile Remote LAN WebSocket bridge (defaults to the IDE server port).",
    category: "mobileRemote",
  },
} as const satisfies Record<string, SettingDefinition>;
