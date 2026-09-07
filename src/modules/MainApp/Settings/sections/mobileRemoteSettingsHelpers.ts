import { invoke } from "@tauri-apps/api/core";
import type { TFunction } from "i18next";

import { resolveMobileRemoteRelayPreset } from "@src/config/mobileRemoteRelay";
import { MOBILE_REMOTE_DEFAULT_LAN_PORT } from "@src/config/settingsSchema/registry/mobileRemote";

/** Shown in the WS URL when LAN exposure is on but no host has been resolved yet. */
export const MOBILE_REMOTE_LAN_HOST_PLACEHOLDER = "<local-ip>";

/** Tauri command registered in `system_services::network::get_local_lan_ip`. */
export const MOBILE_REMOTE_GET_LAN_IP_COMMAND = "get_local_lan_ip";

const PRIVATE_IPV4 =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/;

export function generateMobileRemoteLanToken(): string {
  return crypto.randomUUID();
}

/** Pick the host segment for a WS URL once LAN IP resolution has finished. */
export function resolveMobileRemoteLanHostWithIp(
  allowLanExposure: boolean,
  resolvedLanIp: string | null | undefined
): string {
  if (!allowLanExposure) {
    return "127.0.0.1";
  }
  const trimmed = resolvedLanIp?.trim();
  if (trimmed && isPrivateLanIpv4(trimmed)) {
    return trimmed;
  }
  return MOBILE_REMOTE_LAN_HOST_PLACEHOLDER;
}

export function isPrivateLanIpv4(host: string): boolean {
  return PRIVATE_IPV4.test(host.trim());
}

/**
 * Resolve the desktop LAN IPv4 via Tauri when available.
 *
 * Falls back to `null` outside Tauri or when the command is missing / fails
 * (Settings keeps the `<local-ip>` placeholder and shows copy guidance).
 */
export async function fetchMobileRemoteLanIp(): Promise<string | null> {
  try {
    const ip = await invoke<string>(MOBILE_REMOTE_GET_LAN_IP_COMMAND);
    const trimmed = ip?.trim();
    return trimmed && isPrivateLanIpv4(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

export function buildMobileRemoteWsUrl(args: {
  host: string;
  port: number;
  token: string;
}): string {
  const port = args.port > 0 ? args.port : MOBILE_REMOTE_DEFAULT_LAN_PORT;
  const tokenQuery = args.token
    ? `?token=${encodeURIComponent(args.token)}`
    : "";
  return `ws://${args.host}:${port}/mobile/ws${tokenQuery}`;
}

export function isMobileRemoteLanHostPlaceholder(host: string): boolean {
  return host.trim() === MOBILE_REMOTE_LAN_HOST_PLACEHOLDER;
}

/** Local `orgii-mobile-relay` dev still authenticates with a shared desktop token. */
export function usesLocalRelayDesktopToken(relayUrl: string): boolean {
  return resolveMobileRemoteRelayPreset(relayUrl) === "local";
}

export function isMobileRemoteRelayUrlConfigured(relayUrl: string): boolean {
  return /^wss?:\/\//.test(relayUrl.trim());
}

export function isMobileRemoteRelayReady(args: {
  relayUrl: string;
  desktopToken: string;
  cloudSignedIn: boolean;
}): boolean {
  if (!isMobileRemoteRelayUrlConfigured(args.relayUrl)) {
    return false;
  }
  if (usesLocalRelayDesktopToken(args.relayUrl)) {
    return args.desktopToken.trim().length >= 24;
  }
  return args.cloudSignedIn;
}

function isRelayAuthFailureMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("401") ||
    lower.includes("auth_required") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid desktop token") ||
    lower.includes("invalid token") ||
    lower.includes("desktop relay token")
  );
}

/** Map relay broker errors to ORG2 Cloud vs local-token guidance in Settings. */
export function formatMobileRemoteRelayStatusMessage(
  message: string | null | undefined,
  relayUrl: string,
  cloudSignedIn: boolean,
  t: TFunction<"settings">
): string | null {
  if (!message?.trim()) {
    return null;
  }
  const trimmed = message.trim();
  if (usesLocalRelayDesktopToken(relayUrl)) {
    if (
      trimmed.toLowerCase().includes("token") &&
      trimmed.toLowerCase().includes("invalid")
    ) {
      return t("mobileRemote.relayStatusLocalTokenInvalid");
    }
    return trimmed;
  }

  const lower = trimmed.toLowerCase();
  if (
    lower.includes("desktop relay token") ||
    (lower.includes("desktop token") && lower.includes("24"))
  ) {
    return t("mobileRemote.relayStatusCloudLoginRequired");
  }
  if (isRelayAuthFailureMessage(trimmed)) {
    return cloudSignedIn
      ? t("mobileRemote.relayStatusAuthFailedSignedIn")
      : t("mobileRemote.relayStatusCloudLoginRequired");
  }
  return trimmed;
}
