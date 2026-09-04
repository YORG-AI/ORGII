/** Mirrors `mobile_relay_protocol::MOBILE_WS_PATH`. */
export const MOBILE_REMOTE_RELAY_WS_PATH = "/v1/mobile/ws" as const;

/** Default local `orgii-mobile-relay` endpoint (`ORGII_RELAY_LISTEN=127.0.0.1:8787`). */
export const MOBILE_REMOTE_RELAY_LOCAL_URL =
  `ws://127.0.0.1:8787${MOBILE_REMOTE_RELAY_WS_PATH}` as const;

/** Cloudflare Workers deployment of `orgii-mobile-relay` (Mobile PWA + relay). */
export const MOBILE_REMOTE_RELAY_PRODUCTION_HOST =
  "orgii-mobile-relay.superficial-jasper.workers.dev" as const;

/**
 * Default production relay endpoint for outdoor Mobile Remote testing.
 * Override with `REACT_APP_MOBILE_RELAY_PRODUCTION_URL` when pointing at
 * another deployed relay.
 */
export const MOBILE_REMOTE_RELAY_PRODUCTION_URL =
  process.env.REACT_APP_MOBILE_RELAY_PRODUCTION_URL ??
  `wss://${MOBILE_REMOTE_RELAY_PRODUCTION_HOST}${MOBILE_REMOTE_RELAY_WS_PATH}`;

export type MobileRemoteRelayPreset = "local" | "production";

export const MOBILE_REMOTE_RELAY_PRESET_URLS: Record<
  MobileRemoteRelayPreset,
  string
> = {
  local: MOBILE_REMOTE_RELAY_LOCAL_URL,
  production: MOBILE_REMOTE_RELAY_PRODUCTION_URL,
};

export function resolveMobileRemoteRelayPreset(
  relayUrl: string
): MobileRemoteRelayPreset | null {
  const trimmed = relayUrl.trim();
  for (const preset of Object.keys(
    MOBILE_REMOTE_RELAY_PRESET_URLS
  ) as MobileRemoteRelayPreset[]) {
    if (trimmed === MOBILE_REMOTE_RELAY_PRESET_URLS[preset].trim()) {
      return preset;
    }
  }
  return null;
}

export function mobileRemoteRelayPresetUrl(
  preset: MobileRemoteRelayPreset
): string {
  return MOBILE_REMOTE_RELAY_PRESET_URLS[preset];
}
