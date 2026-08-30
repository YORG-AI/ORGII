import { z } from "zod";

import type { SettingDefinition } from "@src/config/settingsSchema/types";

/**
 * Mobile Remote Control settings.
 *
 * The feature lets a paired phone (running the ORGII PWA) drive sessions
 * on this desktop via the `orgii-mobile-relay` broker. Off by default
 * because it requires (a) a relay deployment and (b) a security review
 * of where you trust the relay to live. The Settings → Mobile Remote
 * Control section uses `mobileRemote.enabled` to gate the device list,
 * hosting picker, and Relay URL field.
 */
export const MOBILE_REMOTE_SETTINGS_REGISTRY = {
  "mobileRemote.enabled": {
    schema: z.boolean(),
    default: false,
    description:
      "Enable Mobile Remote Control. When off, the section shows a 'Coming soon' pill and no device controls are rendered. Turn this on after you've decided where your relay will run.",
    category: "mobileRemote",
  },
} as const satisfies Record<string, SettingDefinition>;
