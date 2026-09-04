import { z } from "zod";

import type { SettingDefinition } from "@src/config/settingsSchema/types";

/**
 * Default LAN WebSocket port of the Mobile Remote bridge.
 *
 * The bridge owns a listener separate from the unified IDE server so that LAN
 * exposure can never widen the IDE server's unauthenticated `/git`, `/agent`,
 * `/search` and `/ws` routes. This port therefore stays clear of the IDE
 * server's per-instance range (13847 + instance offset).
 *
 * Must stay in sync with `DEFAULT_MOBILE_LAN_PORT` in
 * `src-tauri/src/api/mobile_bridge/auth.rs`.
 */
export const MOBILE_REMOTE_DEFAULT_LAN_PORT = 13947;

/**
 * Mobile Remote Control settings.
 *
 * Phase 0 uses a LAN WebSocket bridge on its own listener. Phase 1+ adds
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
    description:
      "Legacy desktop access token for local orgii-mobile-relay dev. Production relay auth uses ORG2 Cloud login instead.",
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
      "TCP port for the Mobile Remote LAN WebSocket bridge. The bridge listens on its own port, never on the IDE server port.",
    category: "mobileRemote",
  },
} as const satisfies Record<string, SettingDefinition>;
