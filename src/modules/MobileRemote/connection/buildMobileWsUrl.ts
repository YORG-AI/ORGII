import type { MobileConnectionConfig } from "./types";

/** Build Phase 0 LAN WebSocket URL from host/port/token. */
export function buildMobileWsUrl(config: MobileConnectionConfig): string {
  if (config.wsUrl?.trim()) {
    const explicit = config.wsUrl.trim();
    if (!config.deviceToken?.trim()) return explicit;
    const url = new URL(explicit);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error("Mobile relay URL must use ws or wss");
    }
    url.searchParams.set("token", config.deviceToken.trim());
    if (config.pairingCode?.trim()) {
      url.searchParams.set("pairingCode", config.pairingCode.trim());
    }
    if (config.deviceLabel?.trim()) {
      url.searchParams.set("deviceLabel", config.deviceLabel.trim());
    }
    return url.toString();
  }
  const host = config.host?.trim();
  const port = config.port ?? 13847;
  const token = config.token?.trim() ?? "";
  if (!host) {
    throw new Error("Mobile connection requires wsUrl or host");
  }
  const encoded = encodeURIComponent(token);
  return `ws://${host}:${port}/mobile/ws?token=${encoded}`;
}
